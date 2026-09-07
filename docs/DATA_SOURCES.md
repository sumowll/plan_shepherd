# Production data sources and catalog operations

This document describes the implemented ingestion paths and the source contracts still needed to populate the application. The repository ships real public county names, but no insurance plans, prices, provider networks, formularies, or patient records. A working importer does not establish complete national plan coverage.

## Implemented capabilities

| Data | Implemented path | Production boundary |
| --- | --- | --- |
| ACA marketplace plans | Local CMS 2026 Plan Attributes, Service Area, Benefits and Cost Sharing, and Rate CSV/ZIP converter | Requires operator-acquired files, source hashes, authoritative rating geography, and reconciliation of incomplete semantics. |
| Canonical public plan catalog | Strict JSON validation, partitioned release assembly, D1 import, immutable publication, pinned release queries | Accepts all three product families when real, reviewed canonical records are supplied. No fabricated fallback records. |
| Medicare Advantage | Canonical plan/benefit/rate/formulary/provider/price contracts | No direct PBP, landscape, formulary, pharmacy, or directory source converter is implemented. |
| Short-term medical | Configured canonical JSON feed download/validation; canonical policy term, underwriting, benefit, exclusion, service area, and rate contracts | The provider must supply the canonical format. No source-specific issuer format converter is implemented. CMS Finder is not a short-term feed. |
| County names | Included Census 2025 reference for 50 states and DC, with source provenance | County names are not a ZIP-to-county or rating-area crosswalk. Territories are outside the current state schema. |
| Atrius Health history | Configurable Epic/SMART patient-authorized connector | Requires a registered public client, verified endpoint/scopes, and approved patient processing. This is an individual session import, not a catalog feed. |
| Cigna history | Configurable SMART/FHIR patient-authorized connector | An employer-sponsored member's endpoint and entitlement must be verified with the registered application. There is no assumed universal Cigna access. |

No scheduled acquisition jobs, live Marketplace/Finder calls, live issuer quoting integration, or direct Transparency in Coverage ingestion are configured. `catalog:fetch` consumes `SHORT_TERM_FEED_URL` and optional `SHORT_TERM_FEED_TOKEN` from `.env` or the operator environment to acquire a canonical public-reference JSON file. Merely filling these values does not publish plans. Provider-specific formats still need a reviewed converter before they satisfy the canonical contract.

## Canonical feed contract

The executable contract is [`src/catalog/schema.ts`](../src/catalog/schema.ts), with domain types in [`src/shared/contracts.ts`](../src/shared/contracts.ts). Every input is a strict JSON object containing:

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Literal `1`. |
| `dataClass` | Literal `public_reference`. Patient resources, identifiers from patient sessions, claims, conversations, credentials, and access tokens are prohibited. |
| `release` | Unique immutable ID, year, UTC creation time, publisher, `productionData: true`, `rightsConfirmed: true`, and `provenanceReviewedBy`. These are reviewed operator attestations; the validator cannot independently prove the publisher's claims. |
| `sources` | Registered source IDs, publisher, public HTTPS URL, exact version, retrieval datetime, effective date, and optional SHA-256. A record-specific source may add an exact document/row `location`; its other provenance must agree with the registered source. |
| `plans` | Exact product family, year, issuer/product/variant identity, status, effective interval, service areas, typed benefits and conditions, provider/drug/price components, completeness flags, and source documents. Base `monthlyPremiumCents` must be `null`; all actual rates are separate. |
| `premiumRates` | Unique ID, plan ID, county FIPS, inclusive minimum/maximum age, tobacco `yes`/`no`/`any`, optional 3- or 5-digit `zipPrefixes`, effective interval, monthly cents, estimate flag, and source. A genuinely flat MA premium still requires an explicit rate record. |
| `coverage` | State/family/year, plan count, last update, explanatory note, and `available`, `not_offered`, or `source_gap`. Missing declarations become source gaps. Count validation alone does not prove completeness or legal availability. |

Plan IDs must remain stable within their exact family/year/product/variant. Preserve ACA HIOS standard component and CSR variant distinctions; a differently conditioned CSR variant is not interchangeable with another variant. MA source transformations must preserve contract, plan benefit package, segment, year, and service-area distinctions. Short-term transformations must preserve issuer/product, policy form, state, benefit option, term, and underwriting assumptions rather than borrowing an ACA ID scheme.

`serviceAreas`, when present, has one entry for each plan county: `{ countyFips, wholeCounty, zipCodes?, source? }`. Partial counties require explicit five-digit ZIPs. If omitted, the operator is asserting that the plan's `countyFips` entries represent entire counties. A ZIP prefix used for rating does not establish plan availability.

Premium matching requires one unambiguous rate for the person's age, tobacco status, county/ZIP, and applicable dates. Missing and conflicting rates return unknown. For a short-term policy, the application prices only the intersection of the requested period and the actual policy term; it does not assume renewal. A later policy start uses date of birth to calculate the correct age. Underwritten prices remain labeled estimates. Subsidies, underwriting acceptance, and final enrollment are separate facts.

Benefits can carry separate accumulators, deductible/copay/coinsurance ordering, component-specific out-of-pocket credits, service/drug-tier selectors, unresolved conditions, insurer payment caps, and sourced drug phases. `null` means unknown; known absence of an out-of-pocket cap requires its explicit unbounded flag. A source converter must not turn an exclusion, per-day charge, visit limit, or conditional benefit into an unconditional flat copay.

Provider rows require a source-backed plan network assertion for the NPI and location. Drug rows preserve RxNorm/NDC identifiers, tier, coverage, restrictions, and source. NDC formatting is normalized consistently in input, indexes, and selectors by removing hyphens and outer whitespace; leading zeros and digit count are preserved, with no inferred 10-to-11 digit conversion. Service codes allow up to 250 characters; comparison selection deduplicates before enforcing a 2,000 distinct-code limit and uses JSON array SQL bindings. Price observations distinguish allowed, cash, and billed amounts and can include balance billing. Drug price inputs must declare `quantityUnit: "fill"` or `"dispensed_unit"`; the engine leaves ambiguous units unknown. A prior claim is not evidence of another plan's negotiated rate. An NPI is not evidence of network participation.

## CMS ACA source conversion

Acquire the official 2026 source files from the [CMS Exchange Public Use Files](https://www.cms.gov/marketplace/resources/data/public-use-files). The converter uses these published schemas:

- [Plan Attributes dictionary](https://www.cms.gov/files/document/planattributes-datadictionary-py26.pdf).
- [Service Area dictionary](https://www.cms.gov/files/document/servicearea-datadictionary-py26.pdf).
- [Benefits and Cost Sharing dictionary](https://www.cms.gov/files/document/benefitscostsharing-datadictionary-py26.pdf).
- [Rate dictionary](https://www.cms.gov/files/document/rate-datadictionary-py26.pdf).

The converter accepts local UTF-8 CSV or normal ZIP archives containing CSV. Each archive/file is SHA-256 verified before parsing; ZIP CRC and uncompressed length are checked, archive paths are never extracted, and rows/decompression are bounded. Encrypted, multi-disk, and ZIP64 archives are rejected. These limits are intentional operational bounds, not support for every CMS distribution format.

The manifest contract is exported as `cmsManifestSchema` from [`scripts/catalog/cms-aca.ts`](../scripts/catalog/cms-aca.ts):

```text
schemaVersion: 1
release: canonical reviewed release metadata
states: explicit state abbreviations
planAttributes: { path, sha256, source, entry? }
serviceAreas: { path, sha256, source, entry? }
benefits?: { path, sha256, source, entry? }
rates?: { path, sha256, source, entry? }
stateCountyGeography: [{ state, countyFips, source }]
ratingGeography: [{ state, countyFips, ratingAreaId, zipPrefixes?, source }]
```

File paths resolve relative to the manifest. ZIP `entry` is required when the archive contains multiple CSV members. Statewide service areas require a reviewed county inventory in the same geographic vintage as the plan source. Rate rows require authoritative county/ZIP-to-rating-area mappings; the converter does not derive rating areas from FIPS numbering or assign the first available rate.

```sh
node_modules/node/bin/node node_modules/tsx/dist/cli.mjs scripts/catalog/cms-aca.ts \
  --manifest /path/to/cms-files.json --output /path/to/canonical.json
```

Only individual medical marketplace variants are selected; SHOP, dental, and off-exchange ACA variants are excluded. Individual ages, `0-14`, `64 and over`, and published tobacco-rate columns are supported. Family-tier rating semantics are reported as unsupported. All benefit descriptions are preserved, but numeric conversion is limited to unambiguous simple charges. CSR requirements and complex benefit conditions remain explicit.

The output's adjacent `.report.json` records unresolved geography and skipped semantics. Converted plans initially have `rulesVerified: false`, unknown enrollment status, incomplete network/formulary indicators, and state coverage `source_gap`. Review and supplement the canonical output against current issuer/exchange sources before asserting verified rules, directory completeness, enrollment availability, or state completeness.

The federal Exchange PUF release is not a complete source for states operating their own platforms. [CMS State-based Exchange PUFs](https://www.cms.gov/marketplace/resources/data/state-based-public-use-files) are separate snapshots with different availability boundaries and are not updated during the plan year. There is no dedicated SBE converter in this repository. Obtain the applicable files and exchange/issuer supplements, validate their actual schema, and map them into canonical records. The [Marketplace API](https://developer.cms.gov/marketplace-api/) is a possible additional source; its derived fields are not automatically reproduced by loading PUF files.

## Medicare Advantage and short-term source work

These are concrete source acquisition and mapping requirements, not implemented adapter claims:

| Source | Required transformation and limitation |
| --- | --- |
| [CMS 2026 PBP benefits JSON](https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/benefits-data/pbp-benefits-2026-json) | Map exact plan/segment/year identities, medical benefit conditions, deductibles, limits, and cost sharing. Preserve benefit-specific sources and unresolved meanings. A plan-level summary alone cannot verify the full rule set. |
| [CMS MA/Part D contract and enrollment resources](https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data) | Join applicable landscape, service area, contract, and enrollment-status releases by their documented identifiers and dates. Do not use enrollment totals as an eligibility or network rule. |
| [CMS Part D formulary, pharmacy network, and pricing files](https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information) | Preserve source release cadence, RxNorm/NDC identity, restrictions, pharmacy/network characteristics, and price semantics. Published average prices are estimates, not live pharmacy quotes. |
| [CMS provider-directory API requirements](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/frequently-asked-questions/provider-directory-api) and actual issuer directories | Acquire each applicable issuer/plan directory, normalize location and network identifiers, and reconcile effective dates. Directory completeness needs explicit source evidence. |
| Short-term issuer or licensed distributor contract | Obtain state-specific filed product/term availability, eligibility and underwriting inputs, quote validity, service areas, benefits, exclusions, caps, network/formulary details where applicable, and authorized public redistribution terms. Build and verify the exact provider adapter before scheduling acquisition. |

CMS explicitly excludes short-term products from required [Plan Finder submissions](https://www.cms.gov/cciio/resources/files/faq_plan_finder_data_entry). Finder cannot fill this source gap. Neither a website's marketing premium nor a historical Cigna claim is a substitute for a current underwritten short-term quote.

[NPPES](https://download.cms.gov/nppes/NPI_Files.html) can support provider identity normalization, and [RxNorm distributions](https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html) can support drug identity mapping subject to the applicable distribution terms. No direct NPPES/RxNorm ingestion or terminology service is implemented. [Transparency in Coverage files](https://www.cms.gov/healthplan-price-transparency/resources/technical-clarification) require a separately implemented, versioned normalization pipeline; their size and negotiated-rate semantics do not fit a blind JSON-to-catalog import.

## Validation, publication, and refresh

Use Node 24 and the locked project dependencies. These commands take operator-supplied real public data; no example production plans are generated:

For a provider that supplies the canonical contract, configure the final public HTTPS `SHORT_TERM_FEED_URL` without credentials/query parameters and optional bearer `SHORT_TERM_FEED_TOKEN`, then acquire a local file:

```sh
npm run catalog:fetch -- --output /path/to/new-canonical.json
```

The download uses a 120-second timeout, refuses redirects, caps both declared and actual streamed bytes at 512 MiB, and creates the output exclusively with mode `0600`. The downloaded file is read once for canonical validation and checksum verification. Invalid or interrupted outputs are removed; existing files are preserved. Errors do not print credentials, source URLs, or response bodies. This command neither fetches patient data nor publishes a catalog. Review the acquired release and use the separate importer afterward. A provider CSV, proprietary JSON response, or dynamic underwriting quote is not automatically converted by this command.

```sh
npm run catalog:import -- --file /path/to/canonical.json --validate-only
npm run catalog:import -- --file /path/to/canonical.json --output-sql /path/to/review.sql
npm run db:migrate:local
npm run catalog:import -- --file /path/to/canonical.json
```

For an authorized production import, configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CATALOG_DATABASE_ID` privately in `.env` or the operator environment, then run:

```sh
npm run db:migrate:production
npm run catalog:import -- --file /path/to/canonical.json --remote
```

The remote importer sends bounded requests to the D1 query API using the actual account/database IDs from the operator environment. It does not target the checked-in placeholder or use the file-import operation that blocks serving queries. Requests contain at most 50 statements and 95,000 SQL bytes, with bounded responses and no automatic write retries. `--database` overrides are supported only for local imports. Public catalog preparation/import does not require patient connector credentials or runtime launch readiness. It must be possible to publish the initial catalog before a runtime release is approved.

For national volumes, use `--bundle /path/to/partitions.json` in place of `--file`. The bundle contains `{ schemaVersion: 1, release, parts: [{ path, sha256 }] }`; each part is a canonical file containing disjoint plans. Parts are validated individually, source conflicts/duplicate plans are rejected, coverage is merged conservatively, and digests are checked again during SQL generation. Input is bounded to 512 MiB per part. Preflight aggregate D1 capacity before importing a national release.

Each publication replaces the entire active catalog; importing one state does not append it to the previous release. Include every intended state/family in the release or bundle. D1 first loads invisible staging rows, then checks expected counts before marking the release published. One active-pointer update switches readers atomically. Published records are immutable, and comparisons pin their release ID. A failed staging batch leaves the previous active release available between requests. A lost acknowledgement for the final publication request requires inspecting the active pointer before retrying, because the release may have committed. Inspect incomplete staging rows before cleanup/retry. Retain older releases as required for active sessions, provenance review, and rollback.

Refreshing a source requires a new source version and new immutable release, with updated hashes, effective dates, reconciliation report, and coverage declarations. There is no scheduled refresh service yet. An operator must monitor the acquired source's actual cadence and publish updates; a stale annual snapshot must not be presented as a current directory or quote.

Before declaring a state/family `available`, verify geographic coverage against an authoritative inventory, reconcile source plan counts and excluded variants, test exact identity joins, review conditional cost rules, validate rate selectors with published examples, and document remaining provider/drug/price gaps. These are data acceptance criteria; the catalog validator checks structural consistency and does not replace source review.

## County vintage and patient-session boundaries

The included [2025 Census Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip) supplies 3,144 county/county-equivalent identities for the 50 states and DC. Its source URL, vintage, retrieval time, and SHA-256 are included in the reference JSON. The county endpoint works without a catalog or any request to Census.

Connecticut's current reference uses nine planning regions. Eight legacy county identities are separately sourced from the [2020 Gazetteer](https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_counties_national.zip). A legacy county appears as a labeled alternative only if the published plan catalog actually uses its code. Old counties are never silently mapped to new planning regions. Other unmatched catalog codes are labeled as requiring name verification. Regeneration commands and helper interfaces are documented in [`scripts/catalog/README.md`](../scripts/catalog/README.md).

Atrius/Epic and Cigna patient access are session imports independent of this public catalog. Registration and access requirements must be checked against [Epic developer resources](https://open.epic.com/DeveloperResources) and [Cigna Patient Access documentation](https://developer.cigna.com/service-apis/patient-access/docs). The application's configurable connector does not prove a particular employer member's entitlement. Patient clinical records, historical prices, tokens, and conversations must never enter catalog input files, D1 rows, release metadata, or operational reports.
