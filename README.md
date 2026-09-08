# Plan Shepherd

A consumer web application for comparing 2026 ACA Marketplace, short-term medical and Medicare Advantage coverage across the 50 states and DC. One person chooses coverage; their tax household can include other people.

Includes structured intake, registry-configured SMART on FHIR patient imports with Atrius/Epic and Cigna defaults, a reviewable anticipated-care draft, provider and medication matching, benefit details, deterministic cost estimates, preliminary eligibility guidance and optional AI intake assistance. It does not recommend plans, specialists or treatments.

**A hosted preview is live at [plan-shepherd.moonbacare.com](https://plan-shepherd.moonbacare.com). Live integrations and real plan results require configuration and a published source catalog.** No credentials, patient records or demonstration plans are bundled. The preview has not been qualified against your production registrations. Your clarified production requirements govern this implementation; the original README is preserved in [ORIGINAL_BRIEF.md](docs/ORIGINAL_BRIEF.md).

## Run locally

Use Node.js 24 LTS and npm. The lockfile pins dependencies.

```sh
npm ci
npm run cf:types
npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:5173`, or the loopback `APP_ORIGIN` configured in `.env`. `npm run dev` prepares `.dev.vars` automatically and starts on that exact host and port; an occupied port causes an error so registered OAuth callbacks stay consistent. Manual intake works without credentials. Missing integrations and plan sources appear as unavailable, rather than fabricated results.

When ready to configure services:

```sh
cp .env.example .env
# Fill .env privately, then:
npm run connectors:check
npm run dev
```

Add authorization servers to the server-only [connector registry](config/connectors.json); each entry gets `<APP_ORIGIN>/oauth/callback/<id>` through the shared handler. Put client secrets in the environment binding named by `clientSecretEnv`, never in the JSON. Register each exact callback with the corresponding authorization server. See [adding a connection](docs/OPERATIONS.md#connector-registry) for a complete example and deployment limits. Adding an entry does not register or qualify the app with that server.

`connectors:check` reports every registry entry's configuration issues, callback addresses and token authentication methods, and checks public SMART discovery with at most four connections at a time. Disabled entries skip discovery. It does not sign in, import records or qualify a registration. The connectors support public clients with S256 PKCE and confidential clients using `client_secret_basic` or `client_secret_post`. The bundled defaults preserve existing `ATRIUS_*`, `CIGNA_*` and legacy `EPIC_*` settings; `EPIC_*` is used when the corresponding `ATRIUS_*` setting is absent.

Restart the server after configuration changes. `.env` and generated `.dev.vars` are ignored by version control; `npm run env:prepare` remains available separately. Never put credentials in `VITE_` variables. See [operations and configuration](docs/OPERATIONS.md) for required settings, callbacks and production controls. Cigna sandbox/devportal endpoints contain test data; its [published Patient Access guide](https://developer.cigna.com/assets/content/service-apis/patient-access/getting-started.md) lists US Commercial availability beginning January 1, 2027.

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

These checks do not deploy. Deployment uses the public settings committed in [wrangler.preview.jsonc](wrangler.preview.jsonc) or [wrangler.production.jsonc](wrangler.production.jsonc). It never loads local `.env` or `.dev.vars`, and shell variables do not override these public settings.

The preview enables manual intake and bundled county lookup, with patient connections, AI and release approvals disabled and no catalog database. Its deployment can also upload application secrets from the optional ignored `.env.secrets.preview` file or recognized secret variables in the shell/CI environment. Supplying secrets does not enable integrations. For a local preview deployment:

```sh
npx wrangler login
cp .env.secrets.example .env.secrets.preview
chmod 600 .env.secrets.preview
# Uncomment and fill only the application secrets you intend to upload.
npm run deploy:preview:check
npm run deploy:preview
```

The secret template contains only comments; skip creating a secret file when none are needed. Production uses `npm run deploy:production:check`, then `npm run deploy`, with `wrangler.production.jsonc` and optional `.env.secrets.production`. It requires configured services, an actual database ID, reviewed catalog, credentials and a release record before publication. The deployment checks actual catalog coverage and runs tests/build. See [deployment settings and secrets](docs/OPERATIONS.md#deployment-configuration-and-secrets) and [Cloudflare Git build commands](docs/OPERATIONS.md#hosted-preview).

`npm run build` and `npm run typecheck` generate the ignored `worker-configuration.d.ts` before compiling, so fresh checkouts do not need a manual `cf:types` step.

## Design

- Records, tokens, conversations, preferences and estimates stay in the active browser session and transient requests. Clearing or reloading requires reimport. There is no patient database, saved account or enrollment transaction.
- D1 stores immutable public reference releases only. Each comparison pins one release and preserves source references.
- Unknown coverage and prices remain unknown. Incomplete estimates show their known subtotal and unresolved items.
- AI selects approved explanatory text and extracts supported intake proposals. The person confirms every change; calculations and plan lookups are deterministic.
- Actual service scope, retention, source rights and production registration behavior require verification. Configuration flags are not compliance certification.

Further detail: [implementation plan](docs/IMPLEMENTATION_PLAN.md), [calculation behavior](docs/CALCULATIONS.md), [AI boundaries](docs/AI_BOUNDARIES.md), [operations](docs/OPERATIONS.md).


## Future Improvement
Agree to OWASP Top 10 & SANS Top 25? 
SAST (Static Application Security Testing): Tools like bandit can be dropped into your environment to automatically scan your Python code for common security issues before you commit.

Dependency Scanning: Using tools like pip-audit or GitHub's native Dependabot will automatically check your packages for known vulnerabilities.
