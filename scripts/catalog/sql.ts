import type { CanonicalCatalog } from '../../src/catalog/schema';
import {normalizeNdc,normalizeMedicationCode} from '../../src/shared/identifiers';

/** SQL literals are escaped as SQL, never interpolated into a shell. */
export function sqlValue(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('SQL numeric values must be safe integers'); return String(value); }
  if (value.includes('\0')) throw new Error('NUL is not permitted in catalog strings');
  return `'${value.replaceAll("'", "''")}'`;
}
export const sqlInsert = (table: string, values: (string|number|null)[], columns?:string[]) => {
  if(!/^catalog_[a-z_]+$/.test(table))throw new Error('Invalid catalog table');
  if(columns&&(columns.length!==values.length||columns.some(column=>!/^[a-z_][a-z_0-9]*$/.test(column))))throw new Error('Invalid catalog columns');
  return `INSERT INTO ${table}${columns?` (${columns.join(',')})`:''} VALUES (${values.map(sqlValue).join(',')});`;
};
const insert=sqlInsert;

export function* catalogStatements(c: CanonicalCatalog, options:{rowsOnly?:boolean}={}): Generator<string> {
  const release = c.release.id;
  const components = c.plans.reduce((n,p) => n+p.providers.length+p.drugs.length+p.prices.length,0);
  const counties = c.plans.reduce((n,p) => n+p.countyFips.length,0);
  if(!options.rowsOnly){yield insert('catalog_releases',[release,c.release.year,c.release.createdAt,JSON.stringify(c.release),c.plans.length,c.premiumRates.length,c.sources.length,c.coverage.length,components,counties,'staging']);
  for (const source of c.sources) yield insert('catalog_sources',[release,source.id,JSON.stringify(source)]);}
  for (const p of c.plans) {
    const summary = { ...p, serviceAreas:undefined, providers: [],drugs: [],prices: [] };
    yield insert('catalog_plans',[release,p.id,p.state,p.family,p.year,p.status,p.name,p.effectiveStart,p.effectiveEnd,JSON.stringify(summary)]);
    for (const county of p.countyFips) {
      const area=p.serviceAreas?.find(a=>a.countyFips===county);
      yield insert('catalog_plan_counties',[release,p.id,county,area?.wholeCounty===false?0:1,JSON.stringify(area?.zipCodes??[]),area?.source?.id??null,area?.source?.location??null],['release_id','plan_id','county_fips','whole_county','zip_codes','source_id','source_location']);
    }
    const componentColumns=['release_id','plan_id','kind','ordinal','lookup_key','lookup_key_2','data_json','location_key'];
    const locationKey=(value:string|undefined)=>value?.trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ')??null;
    for (const [ordinal,row] of p.providers.entries()) yield insert('catalog_components',[release,p.id,'provider',ordinal,row.npi,null,JSON.stringify(row),locationKey(row.location)],componentColumns);
    for (const [ordinal,row] of p.drugs.entries()) {
      const normalized={...row,...row.ndc?{ndc:normalizeNdc(row.ndc)}:{}};
      yield insert('catalog_components',[release,p.id,'drug',ordinal,normalized.rxnorm ?? null,normalized.ndc ?? null,JSON.stringify(normalized),null],componentColumns);
    }
    for (const [ordinal,row] of p.prices.entries()) {
      const normalized={...row,...row.medicationCode?{medicationCode:normalizeMedicationCode(row.medicationCode)}:{}};
      yield insert('catalog_components',[release,p.id,'price',ordinal,normalized.serviceCode ?? normalized.category,normalized.medicationCode ?? null,JSON.stringify(normalized),locationKey(row.providerLocation)],componentColumns);
    }
  }
  for (const r of c.premiumRates) yield insert('catalog_premium_rates',[release,r.id,r.planId,r.countyFips,r.minAge,r.maxAge,r.tobacco,r.effectiveStart,r.effectiveEnd,JSON.stringify(r)]);
  if(options.rowsOnly)return;
  for (const row of c.coverage) yield insert('catalog_coverage',[release,row.state,row.family,row.year,JSON.stringify(row)]);
  yield* publicationStatements(release);
}
export function* publicationStatements(release:string):Generator<string>{
  // An interrupted load leaves only invisible staging rows. A database trigger verifies all counts.
  yield `UPDATE catalog_releases SET status='published' WHERE id=${sqlValue(release)} AND status='staging';`;
  // This one statement is the atomic release switch, including rollback to a previous published release.
  yield `INSERT INTO catalog_active(singleton,release_id) VALUES(1,${sqlValue(release)}) ON CONFLICT(singleton) DO UPDATE SET release_id=excluded.release_id;`;
}
