# Plan Shepherd

A consumer web application for comparing 2026 ACA Marketplace, short-term medical and Medicare Advantage coverage across the 50 states and DC. One person chooses coverage; their tax household can include other people.

Includes structured intake, Atrius/Epic and Cigna patient imports, a reviewable anticipated-care draft, provider and medication matching, benefit details, deterministic cost estimates, preliminary eligibility guidance and optional AI intake assistance. It does not recommend plans, specialists or treatments.

**The application runs locally now. Live integrations and real plan results require configuration and a published source catalog.** No credentials, patient records or demonstration plans are bundled. The application has not been deployed or qualified against your production registrations. Your clarified production requirements govern this implementation; the original README is preserved in [ORIGINAL_BRIEF.md](docs/ORIGINAL_BRIEF.md).

## Run locally

Use Node.js 24 LTS and npm. The lockfile pins dependencies.

```sh
npm ci
npm run cf:types
npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:5173`. Manual intake works without credentials. Missing integrations and plan sources appear as unavailable, rather than fabricated results.

When ready to configure services:

```sh
cp .env.example .env
# Fill .env privately, then:
npm run env:prepare
```

Restart the server after configuration changes. `.env` and generated `.dev.vars` are ignored by version control. Never put credentials in `VITE_` variables. See [operations and configuration](docs/OPERATIONS.md) for the supported registrations and production settings.

## Load public plan data

Patient records must never enter the public catalog. A CMS ACA CSV/ZIP converter, canonical source validation, profile-specific premiums, partitioned national imports and atomic publication are included.

```sh
npm run catalog:import -- --file /path/to/reviewed-catalog.json --validate-only
npm run catalog:import -- --file /path/to/reviewed-catalog.json
# Large national releases:
npm run catalog:import -- --bundle /path/to/partitions.json
```

See [source coverage and adapters](docs/DATA_SOURCES.md) and [catalog commands](scripts/catalog/README.md). Medicare Advantage and short-term source feeds must be mapped to the canonical schema. Environment variables do not supply missing benefit, provider, formulary or pricing facts.

## Check and deploy

```sh
npm run typecheck
npm test
npm run deploy:check
```

These checks do not deploy. Production deployment uses `npm run deploy` and requires real service configuration, a provisioned database, reviewed catalog and release record. It verifies actual catalog coverage, runs tests/build, and uploads secrets with the Worker version. Follow [OPERATIONS.md](docs/OPERATIONS.md).

## Design

- Records, tokens, conversations, preferences and estimates stay in the active browser session and transient requests. Clearing or reloading requires reimport. There is no patient database, saved account or enrollment transaction.
- D1 stores immutable public reference releases only. Each comparison pins one release and preserves source references.
- Unknown coverage and prices remain unknown. Incomplete estimates show their known subtotal and unresolved items.
- AI selects approved explanatory text and extracts supported intake proposals. The person confirms every change; calculations and plan lookups are deterministic.
- Actual service scope, retention, source rights and production registration behavior require verification. Configuration flags are not compliance certification.

Further detail: [implementation plan](docs/IMPLEMENTATION_PLAN.md), [calculation behavior](docs/CALCULATIONS.md), [AI boundaries](docs/AI_BOUNDARIES.md), [operations](docs/OPERATIONS.md).
