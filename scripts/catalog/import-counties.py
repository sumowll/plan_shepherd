#!/usr/bin/env python3
"""Build a small public county-name reference from an official Census Gazetteer ZIP.
No network access and no archive extraction. All names/codes come from the source.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
from pathlib import Path
import zipfile

STATES = set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())


def convert(path, year, legacy_ct=False):
    raw = Path(path).read_bytes()
    if len(raw) > 2_000_000:
        raise ValueError('County ZIP exceeds 2 MB')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = [i for i in archive.infolist() if i.filename.endswith('.txt')]
        if len(entries) != 1 or entries[0].file_size > 5_000_000:
            raise ValueError('Expected one bounded Gazetteer text file')
        text = archive.read(entries[0]).decode('utf-8-sig')
    delimiter = '|' if '|' in text.splitlines()[0] else '\t'
    records = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if not {'USPS', 'GEOID', 'NAME'}.issubset(records.fieldnames or []):
        raise ValueError('Missing Gazetteer columns')
    counties = []
    for row in records:
        state, fips, name = row['USPS'].strip(), row['GEOID'].strip(), row['NAME'].strip()
        if state not in STATES or legacy_ct and state != 'CT':
            continue
        if len(fips) != 5 or not fips.isdigit() or not name:
            raise ValueError('Invalid county identity')
        counties.append({'state': state, 'fips': fips, 'name': name})
    if len({r['fips'] for r in counties}) != len(counties):
        raise ValueError('Duplicate county FIPS')
    if legacy_ct:
        if len(counties) != 8 or any(not r['fips'].startswith('09') for r in counties):
            raise ValueError('Expected eight legacy Connecticut counties')
    elif {r['state'] for r in counties} != STATES or not 3000 < len(counties) < 3300:
        raise ValueError('Incomplete national county reference')
    return {'source': {'publisher': 'U.S. Census Bureau', 'url': f'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{year}_Gazetteer/{year}_Gaz_counties_national.zip',
                       'version': f'{year} Gazetteer', 'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
                       'sha256': hashlib.sha256(raw).hexdigest()},
            'counties': sorted(counties, key=lambda r: (r['state'], r['name']))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--year', type=int, choices=[2020, 2025], required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--legacy-ct-only', action='store_true')
    args = parser.parse_args()
    data = convert(args.input, args.year, args.legacy_ct_only)
    Path(args.output).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f"Wrote {len(data['counties'])} official public county identities")


if __name__ == '__main__':
    main()
