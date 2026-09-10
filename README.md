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

Configure local application settings and connection client IDs/secrets in a private `.env`; copy `.env.example` only when `.env` does not already exist. Set up connections through one command interface:

```sh
npm run connectors -- add
npm run connectors -- edit cigna-patient-access
npm run connectors -- list
```

Use `add` for a new data source, `edit <key-or-uuid>` for an existing connection, and `list` to review the setup. The interactive commands collect metadata and hidden credential values together. Choose `development`, `preview`, `production`, or several targets when the same credentials apply. Add `--target production` to edit or list one target. Leaving a credential blank during editing keeps its saved value. The optional advanced prompts cover callback paths, custom routing keys, import resources and test-data labels.

Setup saves reviewed connection metadata in [config/connectors.json](config/connectors.json). It saves client IDs and secrets in the existing private dotenv workflow: `.env` for development, `.env.secrets.preview` for preview, and `.env.secrets.production` for production. Updates preserve unrelated entries and comments. A missing target value never falls back to another target. Recognized shell/CI credentials override the selected file; public client IDs can also be defaults in the target Wrangler config. Connection metadata stays in the registry; overrides such as `CONNECTOR_REGISTRY` are rejected. The former `config/connector-credentials.local.json` is retained only as a recovery copy and is no longer loaded or maintained by setup.

Each connection has an immutable UUID `id`, an `organizationId` shared by its organization's connections, a provider/payer `kind`, and an `apiType`. The routing key derives from `<organizationId>-<apiType>` with underscores replaced by hyphens; `key` is only needed for a custom route or additional connection. Authorization and imported records use the UUID. Keep that UUID when target-specific OAuth credentials access the same API and FHIR dataset. A different API or data source, including a sandbox, needs a separate UUID. `patient_access` supports sign-in and imports; `payer_to_payer` and `provider_directory` are reserved for future adapters.

Atrius Health and BCH are separate data sources served through Epic. They share the client ID reference `EPIC_CLIENT_ID`, whose value is saved in each selected target file; their secret references remain separate. Other client ID binding names derive from organization and API, such as `CIGNA_PATIENT_ACCESS_CLIENT_ID`. These names identify the dotenv/shell values and runtime bindings used by the scripts. Secrets require an explicit `clientSecretEnv` reference.

Setup records `scopes` and `tokenAuthMethod` explicitly. `grantedScopeFormat` independently selects the accepted returned permissions. Current Atrius, BCH and Aetna registrations use `client_secret_basic`; Cigna uses `client_secret_post`, its explicit identity scopes and `read_search` grants. No organization name selects authentication behavior. Only requested identity permissions are accepted, and an explicit patient context remains required.

`list` shows each target's callback, scopes, authentication method, credential presence and availability without printing credential values. Register the exact callback with the corresponding authorization server. Saved configuration does not verify that registration or test an import. `npm run connectors:check -- --target development` additionally checks public SMART discovery where endpoints are not explicitly configured; it does not sign in or read records. See [connection setup and migration](docs/OPERATIONS.md#connector-registry) for details and [deployment settings](docs/OPERATIONS.md#deployment-configuration-and-secrets) for supplying target secrets in CI. Add `--target <target> --secrets-file <path>` to setup or connection checks to use a custom dotenv file.

Restart `npm run dev` after setup; it regenerates the ignored, disposable `.dev.vars`. Builds never overwrite `.env` or `.env.secrets.<target>`; keep these protected inputs excluded from Git and backed up securely. Rebuild and redeploy for deployed metadata or credential changes. `npm run env:prepare` remains available separately. Never put credentials in `VITE_` variables. Cigna sandbox/devportal endpoints contain test data; its [published Patient Access guide](https://developer.cigna.com/assets/content/service-apis/patient-access/getting-started.md) lists US Commercial availability beginning January 1, 2027.

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

These checks do not deploy. Deployment uses connection metadata from `config/connectors.json`, credentials from the selected target secret file or recognized shell/CI variables, and public application settings committed in [wrangler.preview.jsonc](wrangler.preview.jsonc) or [wrangler.production.jsonc](wrangler.production.jsonc). It never loads local `.env` or `.dev.vars`. Secret-file client IDs override Wrangler client ID defaults; recognized shell/CI credentials override the file. Other public application settings remain controlled by Wrangler.

The preview enables manual intake and bundled county lookup, with patient connections, AI and release approvals disabled and no catalog database. Its deployment loads application secrets such as `SESSION_SIGNING_KEY` and `AI_API_KEY`, plus referenced connector client IDs/secrets, from the optional ignored `.env.secrets.preview` file or recognized shell/CI variables. Supplying secrets does not enable integrations. For a local preview deployment:

```sh
npx wrangler login
if [ ! -e .env.secrets.preview ]; then
  cp .env.secrets.example .env.secrets.preview
fi
chmod 600 .env.secrets.preview
# Fill only the app secrets and connection credentials you intend to supply.
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
