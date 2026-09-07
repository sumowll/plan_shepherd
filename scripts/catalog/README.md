# Public catalog operations

The database contains public plan/reference data only. Patient records, conversations, OAuth tokens, preferences and claims must never be imported. The app starts with no plans and reports `source_gap`; it contains no synthetic production catalog.

## Canonical input

`src/catalog/schema.ts` is the executable schema. A JSON object has `schemaVersion: 1`, `dataClass: "public_reference"`, `release`, `sources`, `plans`, `premiumRates` and `coverage`.

- `release`: unique immutable `id`, `year`, ISO `createdAt`, `publisher`, `productionData: true`, `rightsConfirmed: true`, and `provenanceReviewedBy`. These declarations must be made by the data operator after reviewing real source rights and provenance. Schema validation cannot independently prove a publisher's facts.
- `sources`: registered public HTTPS URLs, publisher, exact version, ISO retrieval datetime, ISO effective date; optional SHA-256. A nested record's source must match the registered source. Record-specific `location` may differ.
- `plans`: all fields in the shared Plan contract, with `monthlyPremiumCents: null`. Store every profile-dependent or genuinely fixed rate in `premiumRates`. Keep variants, year and product family distinct. Unknown means unknown; a null deductible does not mean zero.
- `serviceAreas`: optional county entries with `wholeCounty` and `zipCodes` for partial counties. Every county must have an entry when this field is provided. Without the field, the canonical operator is explicitly asserting whole-county service areas through `countyFips`.
- `premiumRates`: ID, plan ID, county, inclusive min/max ages, tobacco (`yes`, `no`, or expressly age/tobacco independent `any`), effective interval, monthly cents, estimate flag and source. Optional `zipPrefixes` restrict a rate to published 3- or 5-digit ZIP prefixes. Flat MA premiums use an explicit 0–120 age interval and `any` tobacco value. The app returns unknown for missing or overlapping matches. It never substitutes another age's price.
- `coverage`: state/family/year declarations, plan counts, update date, reason and one of `available`, `not_offered`, `source_gap`. Counts are verified against the release. A missing declaration becomes a source gap automatically. `available` is the operator's reviewed coverage claim; downloading one file does not establish it.
- Nested provider, formulary and price records are stored independently and indexed by identifiers. Benefits, conditional rules, accumulators and drug phases remain typed. Every phase configuration has a registered source. Sources, providers and drug records are public; neither NPI nor a previously paid claim proves network membership.

Validate before writing:

```sh
npm run catalog:import -- --file /path/to/canonical.json --validate-only
npm run catalog:import -- --file /path/to/canonical.json --output-sql /path/to/review.sql
npm run db:migrate:local
npm run catalog:import -- --file /path/to/canonical.json
```

`--remote` is an explicit remote mutation switch for an authorized operator; it is never the default. It loads `.env` plus the operator environment and sends bounded D1 query batches to the validated `CATALOG_DATABASE_ID`. Run `npm run db:migrate:production` first. `--database` defaults to `plan-shepherd-catalog` and can be overridden only for local imports. Local imports invoke the checked-in Wrangler installation through Node with argument arrays and `shell: false`. Remote imports use the D1 query API, with at most 50 statements and 95,000 SQL bytes per request, so the database can serve reads between batches; they do not invoke D1's blocking file-import operation. Database credentials belong in the operator environment (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), never in input catalogs or public application variables. Validation and reviewable SQL generation do not load deployment credentials or mutate a database.

Publication first loads an invisible staging release. Database triggers check counts for sources, plans, geographic rows, rates, coverage and components before publication. A single active-pointer statement makes the complete release visible atomically. Reads use a pinned release ID; older published releases remain available for ongoing sessions and rollback. Published rows cannot be changed. A failure before publication leaves the prior active release in place. If the final request was sent but not acknowledged, inspect `catalog_active` before retrying because the complete release may already have committed. Writes are not automatically retried. Inspect incomplete staging rows before cleanup or retrying with a new release ID; never edit a published release.

Canonical JSON input is bounded at 512 MiB per file, single stored plan summaries at 80,000 bytes (county provenance is stored separately), individual SQL statements below D1's statement limit, and rate/component arrays are bounded. For national data, use `--bundle /path/to/partitions.json` instead of `--file`. The bundle is `{ schemaVersion: 1, release, parts: [{ path, sha256 }] }`, where each partition is a validated canonical JSON file for disjoint plans; paths resolve relative to the bundle. The importer validates each part separately, rejects duplicate plans/conflicting sources, combines coverage declarations conservatively, and rechecks checksums while producing one atomic release. It holds one partition at a time rather than the entire national catalog. Cross-partition duplicate rate IDs are rejected by D1 before the active pointer changes.

This importer replaces the entire published release, so importing one state's file alone does not append to the previous catalog. Include every intended state/family in a bundle. Keep the resulting database within the configured D1 capacity and preflight data volume before remote import. The underlying schema supports independently stored components so directories need not be repeated inside plan summary blobs. Migration `0003_catalog_projection.sql` stores county source IDs/locations separately and preserves existing inline releases. Search and comparison hydrate the requested county. Paired event selectors narrow prices by service, provider/location, medication, date and fill details before loading. SQL counts matching row bytes before materialization; the comparison shares an 8 MiB reference-data budget across plans, components and premiums, with an explicit size error instead of silently dropping matching prices.

## Genuine CMS ACA CSV / ZIP conversion

The adapter uses [CMS 2026 Exchange PUF dictionaries](https://www.cms.gov/marketplace/resources/data/public-use-files) and supports local official CSV files or ZIP files containing CSV. It streams records, checks SHA-256 first, bounds archive and CSV sizes, supports quoted multiline cells and never extracts archive paths to disk.

```sh
node_modules/node/bin/node node_modules/tsx/dist/cli.mjs scripts/catalog/cms-aca.ts --manifest /path/to/cms-files.json --output /path/to/canonical.json
```

The manifest schema is exported as `cmsManifestSchema` from `cms-aca.ts`. It contains:

- `schemaVersion`, reviewed `release`, and an explicit list of `states`.
- Required `planAttributes` and `serviceAreas`; optional `benefits` and `rates`. Each is `{ path, sha256, source, entry? }`. Paths resolve relative to the manifest. Specify `entry` if a ZIP contains multiple CSVs.
- `stateCountyGeography`: `{ state, countyFips, source }` records from an authoritative county inventory, required to expand statewide service areas.
- `ratingGeography`: `{ state, countyFips, ratingAreaId, zipPrefixes?, source }` records from authoritative state/CMS rating geography. A missing mapping leaves rates unknown. Do not infer a rating area from county numbering. ZIP-based rating uses explicit prefixes.

The converter joins exact HIOS plan variants and issuer/service-area keys; excludes dental, SHOP and off-exchange ACA variants; preserves CSR conditions; parses whole/partial-county service areas; and joins individual age bands and tobacco rates. Age bands `0-14`, individual ages and `64 and over` are supported. Family-tier rates are reported as unsupported rather than misapplied. Compound/per-day benefit charges retain their original explanation/conditions; only unambiguous elementary copays/coinsurance become numeric fields. Original input digests persist in source provenance.

A machine-readable `.report.json` lists skipped/unresolved source semantics. Output has `rulesVerified: false`, unknown enrollment status, incomplete network/formulary indicators and state coverage `source_gap`. This is deliberate: PUF parsing does not verify current enrollment, every benefit condition, clinical directories, formularies or statewide completeness. Reconcile with current issuer/exchange sources, ingest missing public components, review deterministic rules, and update the canonical release before representing those facts as verified. This is a production source adapter, not a source of fabricated complete coverage.

[CMS SBE PUFs](https://www.cms.gov/marketplace/resources/data/state-based-public-use-files) are separate snapshots and are not updated during the plan year. Validate their schema and obtain supplements before merging national coverage. There is no built-in assumption that the Marketplace API's derived fields are fully reproduced by PUFs.

## Remaining source contracts

MA and short-term records use the same canonical validator/importer. Direct MA PBP/formulary source adapters and issuer short-term feed mappings must be implemented against the specific acquired files/contracts before their feeds can be scheduled. Neither a Medicare plan list nor CMS Finder is a substitute for those contracts. Short-term products are expressly excluded from required [CMS Finder submissions](https://www.cms.gov/cciio/resources/files/faq_plan_finder_data_entry).

No patient integration settings belong in catalog input. Cigna employer-sponsored API entitlement remains separate from plan catalog availability. The pipeline does not use patient credentials for acquisition. `npm run catalog:fetch -- --output /path/to/new-canonical.json` downloads the canonical public-reference JSON contract using `SHORT_TERM_FEED_URL` and optional bearer `SHORT_TERM_FEED_TOKEN` from `.env` or the operator environment. It requires a final public HTTPS endpoint, rejects redirects, streams at most 512 MiB with a timeout, creates the output exclusively with mode `0600`, validates the complete file, and removes failed/invalid downloads. It does not publish or convert provider-specific formats. See [production source capabilities and requirements](../../docs/DATA_SOURCES.md) for the source-by-source implementation boundary.

## County names for intake

`src/catalog/data/counties-2025.json` is derived from the official [2025 Census Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip), including the 50 states and DC. It contains 3,144 county identities, with original names/FIPS codes, source URL, vintage, retrieval time and SHA-256. The small static reference is available even before a plan catalog is published. No user location is sent to Census.

The 2025 reference uses Connecticut planning regions. The eight legacy Connecticut county names are separately sourced from the official [2020 Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_counties_national.zip). `getCountyOptions` includes an old code as a clearly labeled separate option only when the current plan catalog uses it. There is no automatic old-to-new spatial mapping. Other unmatched catalog geography codes retain an explicit name-verification gap.

To regenerate from downloaded official archives:

```sh
python3 scripts/catalog/import-counties.py --input /path/to/2025_Gaz_counties_national.zip --year 2025 --output src/catalog/data/counties-2025.json
python3 scripts/catalog/import-counties.py --input /path/to/2020_Gaz_counties_national.zip --year 2020 --legacy-ct-only --output src/catalog/data/connecticut-counties-2020.json
```

The county-name reference is not a ZIP-to-county spatial crosswalk. ZIP and exact source-vintage county selection remain separate inputs to plan availability and rating.
