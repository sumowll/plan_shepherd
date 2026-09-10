# Configuration and operations

## Local setup and registrations

The application has a hosted preview at [plan-shepherd.moonbacare.com](https://plan-shepherd.moonbacare.com), public-catalog migrations and release tooling. Source licenses, secrets and completed production release approvals are not bundled. Manual intake works while unavailable sources remain visible.

If `.env` does not already exist, copy `.env.example` to `.env` for application settings such as `APP_ORIGIN`, processing approvals, `SESSION_SIGNING_KEY` and AI configuration, plus local connection client IDs and secrets. Recognized shell values override that file. Connection setup can update the same dotenv files, as described below.

`npm run dev` loads development connection credentials, prepares `.dev.vars` with mode 0600 and uses the exact HTTP loopback host and port in `APP_ORIGIN`, defaulting to `http://127.0.0.1:5173`. It refuses to switch ports when one is occupied. Restart after setup changes. `npm run env:prepare` remains available separately. The generated Worker bindings include the selected connection credentials; `.dev.vars` is disposable and should not be edited manually. Builds and environment preparation never overwrite the protected inputs `.env`, `.env.secrets.preview` or `.env.secrets.production`. Keep those files excluded from Git, owner-only, and backed up securely. Unrelated deployment/feed credentials remain tooling-only. Never use `VITE_` for a secret.

The `.env` workflow also remains available for catalog/migration tooling. Deployment reads committed Wrangler application configuration and the selected target secret file, with recognized shell/CI credential overrides; it never loads `.env` or `.dev.vars`.

## Connector registry

Use the setup command to enter each connection's metadata and credentials in one place:

```sh
npm run connectors -- add
npm run connectors -- edit cigna-patient-access
npm run connectors -- list
```

`add` creates a new data source and UUID. `edit <key-or-uuid>` updates an existing connection while retaining its UUID, organization and API type. Both run interactively, collect metadata and hidden credential values, and save the result. They ask which credential targets to update: `development`, `preview`, `production`, or a comma-separated combination. Use `--target production` to select one target directly. Blank credential input preserves the saved values; it does not erase them. New connections start disabled unless explicitly enabled during setup. Choose the advanced settings prompt to configure a custom routing key, callback path or exact URL, import resources and test-data labels. Choosing no preserves those existing settings; the advanced prompts accept `-` to restore an automatic/default value where indicated.

Setup preserves separate files for connection metadata and each target’s private values:

| File | Role |
| --- | --- |
| [config/connectors.json](../config/connectors.json) | Versioned, server-only metadata authoritative for every target: identity, API, endpoints, scopes, authentication, credential references and optional callback configuration |
| `.env` | Ignored, protected local application settings and development client IDs/secrets |
| `.env.secrets.preview` | Ignored, protected preview application secrets and referenced client IDs/secrets |
| `.env.secrets.production` | Ignored, protected production application secrets and referenced client IDs/secrets |

Development and deployment load the selected target file. Selecting several targets saves the entered credential in each target file; updating production preserves the other target files. Updates preserve unrelated entries and comments. There is no cross-target fallback: a missing production value stays missing even if development has one. Only connection bindings referenced by the current registry are selected.

The command hides credential input and never prints the values. Target dotenv files must be regular files with owner-only permissions; setup saves them with mode 0600 and rejects symlinks. Updates replace each file atomically and attempt to restore credentials if saving the registry fails. After an interrupted or failed save, review the setup with `list` before retrying.

Recognized client IDs and secrets can be supplied through the target dotenv file or shell/CI; shell values take precedence. For deployment, public client IDs may also appear in Wrangler `vars` as defaults, overridden by the secret file and then shell/CI. Keep client secrets out of public Wrangler configuration. Connection metadata remains authoritative in `config/connectors.json`; external metadata settings, including `CONNECTOR_REGISTRY`, are rejected.

`list` shows all targets unless `--target` is supplied. For each connection it displays the UUID, API, FHIR base, requested scopes, token authentication method, callback, credential presence and configuration status. It hides values and makes no external registration or import checks. The optional `--secrets-file <path>` selects a custom target dotenv file. For setup, listing and connection checks it requires an explicit `--target development|preview|production`, so a file is associated with exactly one target. Deployment also accepts `--secrets-file`; see the CI example below.

### Connection identity and references

The registry supports up to 10,000 entries. Each entry represents one API and FHIR data source. Setup generates a UUID once; it is never generated at application startup.

| Field | Meaning | Example |
| --- | --- | --- |
| `id` | Immutable connection UUID used by authorization and imported records | `74883015-7d10-40a9-a7d5-f75c6b1582ae` |
| `organizationId` | Organization shared by related connections | `cigna` |
| `kind` | Provider/payer role of this connection | `payer` |
| `apiType` | API purpose | `patient_access` |
| `key` | Optional override of the derived callback/routing key | `cigna-patient-access-sandbox` |

Keep the same UUID when development, preview and production OAuth credentials access the same API and FHIR dataset. Credential rotation, a different target client ID, display-name edits and routine maintenance do not create a new data source. A different API product or FHIR dataset, including a sandbox with test patients, needs a separate connection and UUID. Add that source instead of editing an existing connection to point at unrelated data. Never reassign a UUID to another source. Sharing an organization does not grant access to another connection's receipts or records.

The routing key derives from `<organizationId>-<apiType>`, replacing underscores with hyphens, for example `aetna-patient-access`. An explicit `key` is needed only for a custom route or an additional connection with the same organization/API pair. UUIDs are normalized to lowercase. Duplicate UUIDs or resolved keys, UUID-shaped keys and missing identity fields are rejected. Keys and organization IDs use lowercase letters, digits and hyphens, start with a letter or digit and have at most 80 characters. Use a shorter explicit key if a derived key exceeds that limit. UUID and key lookups are indexed.

Client ID binding names derive from `<ORGANIZATION_ID>_<API_TYPE>_CLIENT_ID`, uppercased with hyphens replaced by underscores. Omit `clientIdEnv` for this default; an explicit reference supports a shared or differently named registration. Binding names start with a letter, use uppercase letters, digits and underscores, and have at most 101 characters. Setup asks for the reference and saves the actual value under that name in each selected target dotenv file. The scripts generate that runtime binding automatically. You can also maintain the referenced value directly in the appropriate target file.

A secret requires an explicit `clientSecretEnv`; there are no implicit legacy-prefix secret lookups. Separate registrations within one organization/API pair need separate credential references when they use different values for the same target. The schema rejects literal `clientSecret` values and references to unrelated application secrets. It still accepts a public `clientId` literal for existing records, but setup moves that value into the selected target dotenv files when the record is edited.

Atrius Health and BCH are separate organizations served through Epic, each with its own UUID and FHIR endpoint. Both reference `EPIC_CLIENT_ID`: enter the shared value once for the selected targets. Setup identifies other connections sharing a reference before changing its value. Atrius and BCH retain distinct `ATRIUS_CLIENT_SECRET` and `BCH_CLIENT_SECRET` references. Epic itself is not another patient-record connection duplicating Atrius.

Cigna and Aetna use separate client registrations for their different API products. Their default references are:

| `apiType` | Cigna client ID reference | Aetna client ID reference |
| --- | --- | --- |
| `patient_access` | `CIGNA_PATIENT_ACCESS_CLIENT_ID` | `AETNA_PATIENT_ACCESS_CLIENT_ID` |
| `payer_to_payer` | `CIGNA_PAYER_TO_PAYER_CLIENT_ID` | `AETNA_PAYER_TO_PAYER_CLIENT_ID` |
| `provider_directory` | `CIGNA_PROVIDER_DIRECTORY_CLIENT_ID` | `AETNA_PROVIDER_DIRECTORY_CLIENT_ID` |

Each API product receives its own UUID and endpoint while sharing its organization's ID. The current application implements patient-access sign-in and imports only. Payer-to-payer and provider-directory entries are reserved for future adapters and should remain disabled. Unsupported API types cannot use patient authorization, token, resource, reference or callback routes even if enabled in the registry. Adding a record does not implement its adapter or register an app with the external server.

A large registry does not remove platform limits on Worker variables and secrets. A deployment with thousands of separate credential bindings requires an appropriate credential-storage/runtime design; see [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).

### Migrating older setup

The separate-file workflow is restored: development credentials live in `.env`, preview credentials in `.env.secrets.preview`, and production credentials in `.env.secrets.production`. Saved values were copied back to their assigned targets from `config/connector-credentials.local.json`; that protected JSON file is retained as a recovery copy only. Runtime and setup no longer read it, and it should not be actively maintained. Review each target with `list` rather than reentering saved values.

Move any custom connection metadata from a former `CONNECTOR_REGISTRY` override into the reviewed registry before removing that override. Existing client IDs and secrets can remain in the appropriate dotenv or shell/CI source; public client IDs may remain in Wrangler configuration. Preserve the existing data-source UUID when the API and dataset are unchanged.

Remove obsolete `legacyEnvPrefixes` and `scopeProfile` fields; the strict schema rejects them. Settings formerly supplied by `scopeProfile` are now independent: Epic resource-operation grants use `grantedScopeFormat: "resource_operations"`; Cigna native grants use `"read_search"` with requested `scopes: "openid fhirUser patient/*.read"`. Select the actual `tokenAuthMethod` explicitly. Current bundled Atrius, BCH and Aetna registrations use basic authentication; Cigna uses POST. Do not infer the authentication method from the organization name.

Older string IDs must migrate to a permanent UUID with explicit `organizationId` and `apiType`. Keeping the old string as an explicit `key` preserves a custom callback route. The current derived keys are `atrius-health-patient-access`, `bch-patient-access`, `cigna-patient-access` and `aetna-patient-access`. A key change requires the matching callback update at the external authorization server. The former duplicate `epic` connection is retired; use Atrius UUID `1938958e-4c7b-426b-a356-0e0a47f9d31c`. Its historical `/auth/callback` path is available when explicitly selected through setup, using `callbackPath: "/auth/callback"` for portability across target origins.

After replacing older non-UUID authorization sessions, reload and reconnect. There is no persisted server-side patient session or record migration. Future stored imports must use the connection UUID as their source identity; changing a display name or key must not rewrite provenance.

## Client registration settings

Setup saves `scopes` and `tokenAuthMethod` explicitly in the shared registry. These settings apply to the same data source in all targets; target-specific credentials do not override them.

| Setting | Purpose |
| --- | --- |
| `scopes` | Space-separated permissions requested during sign-in |
| `grantedScopeFormat` | Accepted returned-grant syntax: `smart`, `resource_operations` or `read_search` |
| `tokenAuthMethod` | Exact client authentication: `none`, `client_secret_basic` or `client_secret_post` |
| `authorizationUrl`, `tokenUrl` | Explicit endpoints, configured together, or omitted for SMART discovery |
| `responseMode` | Callback delivery using `query` or `form_post` |
| `callbackPath` | Optional supported callback path joined to each target's application origin |
| `redirectUri` | Optional exact callback URL; mutually exclusive with `callbackPath` |

All grant formats permit the supported SMART patient-read/launch scopes. `resource_operations` additionally permits returned `Patient.read` and `Encounter.search`; `read_search` additionally permits returned `read` and `search` labels. Native labels are accepted only in returned grants, not in requested scopes. Returned `openid` and `fhirUser` must each appear in the requested scopes. Write, user-wide, system-wide, refresh-token and unknown scopes remain rejected.

Current Atrius, BCH and Aetna request `launch/patient patient/*.read`; Cigna requests `openid fhirUser patient/*.read`. Atrius selects resource-operation grants, Cigna selects read/search grants, and BCH/Aetna use SMART grants. The bundled entries discover authorization and token endpoints from their FHIR servers. Endpoints must use approved public HTTPS DNS names. The former local Cigna overrides used `r-hi2.cigna.com`, which [Cigna documents as sandbox authentication](https://developer.cigna.com/service-apis/patient-access/sandbox), alongside a production FHIR base. Those overrides were removed. A sandbox connection needs a separate UUID, its matching test FHIR base, and test labeling.

`none` is for a public client using S256 PKCE, with no secret sent. `client_secret_basic` sends a confidential client's secret through HTTP Basic authentication; `client_secret_post` sends it in the token request body. Confidential methods require a saved value for the entry's secret reference. Existing hand-authored records retain runtime defaults: omitted patient-access `scopes` uses `launch/patient patient/*.read`; omitted `tokenAuthMethod` uses `none` without a declared secret, otherwise `clientSecretAuthMethod` (default basic). Setup writes explicit choices and removes that conditional authentication default from edited records. Private-key JWT, mTLS and non-SMART patient-context handling require another adapter.

Register the exact callback reported by `list` for each target, including its protocol, host, port and path:

```text
<APP_ORIGIN>/oauth/callback/atrius-health-patient-access
<APP_ORIGIN>/oauth/callback/bch-patient-access
<APP_ORIGIN>/oauth/callback/cigna-patient-access
<APP_ORIGIN>/oauth/callback/aetna-patient-access
```

The target application's `APP_ORIGIN` supplies the origin. The default callback is derived from the key. For a custom supported callback, prefer the advanced `callbackPath` option, such as `/auth/callback/bch-patient-access`: the same path uses each target's own origin. An exact `redirectUri` is mutually exclusive with `callbackPath` and must match the target origin and a supported path for that connection. Because metadata is shared, a fixed absolute URL must work for every target where it is used. Historical `*_REDIRECT_URI` variables do not select callbacks. API routes accept UUIDs or keys and resolve to the canonical UUID; a UUID in an API route does not create another registered callback URL.

Provider imports default to `Patient`, `Encounter`, `MedicationRequest` and `MedicationDispense`; payer imports default to `Patient` and `ExplanationOfBenefit`. An explicit `resources` array starts with `Patient`, has no duplicates and uses supported types, including `Condition`. Both browser imports and server resource APIs enforce the selection. `enabled: false` disables a connection and skips its discovery and production configuration check. Use `testEnvironment: true` for test sources; `testFhirBaseUrls` labels matching bases and does not select an endpoint.

Token exchange must return a Bearer token and explicit SMART `patient` context. Returned ID tokens are discarded; they neither identify the authorized patient nor reach the browser. A signed-in user can represent another patient. Requests are cryptographically bound to the connection UUID, token, patient and expiry. Referenced provider/medication reads require a capability issued from an authorized record. See [SMART identity scopes](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html#scopes-for-requesting-identity-data).

[Cigna's published Patient Access guide](https://developer.cigna.com/assets/content/service-apis/patient-access/getting-started.md) describes the identity/patient scopes above, native grants and explicit patient context, and lists US Commercial availability beginning January 1, 2027. Sandbox/devportal endpoints contain test data. A sandbox, directory or Medicare registration does not establish access to employer-sponsored records; qualify the intended endpoint and member population.

Run `npm run connectors -- list --target production` to review saved production configuration without external calls. `npm run connectors:check -- --target production` additionally checks public SMART discovery, with at most four connections in flight, when explicit endpoints are absent. Disabled entries skip discovery. Explicit endpoints receive configuration validation; neither command signs in, exchanges codes, reads records or qualifies a registration.

For an unavailable connection, use `edit` to correct metadata or save missing credentials for the reported target. Check the application's `SESSION_SIGNING_KEY` and `PATIENT_PROCESSING_APPROVED` separately, register the reported callback, then restart development or deploy and test sign-in. Use **Retry availability** in the records UI after restarting. Saving credentials does not enable application processing approvals.

Generate an application signing secret locally, then put it in `.env` for development, the target secret file, or your application secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Do not paste it into chat or commit it. Configure the approved AI project/model separately; see [AI_BOUNDARIES.md](AI_BOUNDARIES.md).

## Patient session and retention

Records, identities, drafts, chat, tokens and results remain in browser application memory and transient Worker requests. There are no patient cookies, localStorage/sessionStorage/IndexedDB writes, server-side patient sessions, patient queues or durable patient objects.

Clear-session aborts registered requests and invalidates asynchronous work. Reload/pagehide and restored-page handling clear state. A 30-minute idle deadline and two-hour absolute session duration apply, including checks after background-tab activation. This drops application references; JavaScript cannot guarantee physical memory zeroization, erase data already received upstream, or control browser/OS crash dumps.

Patient APIs and HTML use `Cache-Control: no-store`; production adds CSP, HSTS, frame restrictions and no-referrer policy. Hash-named code/style assets may be cached. Patient API bodies stay out of URLs. OAuth `query` callbacks necessarily receive a code/state in the URL, which the callback immediately removes from history. Prefer `form_post` where the approved provider supports it. Review CDN/WAF, callback and support-tool retention. Do not enable body logging, session replay or AI Gateway prompt logging.

Worker logs/traces and deployment Logpush are disabled. Account-level services and contracts still require verification; consult [Cloudflare's US privacy compliance documentation](https://www.cloudflare.com/trust-hub/us-privacy-compliance/). Avoid real patient data in the development server's debugging tools. Processing approval flags are controls, not compliance certification.

## Public catalog operations

Provision D1 `plan-shepherd-catalog`; catalog and migration tooling still reads its actual ID, account ID and scoped API token from `.env` or shell variables. Put the same actual database ID in `wrangler.production.jsonc` for deployment. Scripts never create or delete a remote database implicitly.

```sh
npm run db:migrate:production
npm run catalog:import -- --file /path/to/reviewed-catalog.json --validate-only
npm run catalog:import -- --file /path/to/reviewed-catalog.json --output-sql /path/to/review.sql
npm run catalog:import -- --file /path/to/reviewed-catalog.json --remote
```

Use `--bundle` for national partitions. Review source rights, versions, freshness, service areas, benefits, exact networks/formularies and prices. Missing semantics require mapping and review, not a verification flag. [DATA_SOURCES.md](DATA_SOURCES.md) distinguishes implemented adapters from remaining acquisition work.

Imports stage a complete release and change one active pointer after schema/count checks. Published data is immutable. Failed imports leave the previous release active; identify failed staging rows before cleanup. Retain published releases for comparisons pinned to them.

## Deployment configuration and secrets

Deployment treats `wrangler.preview.jsonc` and `wrangler.production.jsonc` as the authoritative public configuration for their targets. Both checked-in targets describe release modes of the same Worker and domain, not separate staging and production applications. Configure the account, Worker name, routes, application bindings, model and approval settings there. Connection metadata comes from `config/connectors.json`; client IDs and secrets come from the protected dotenv file for the exact deployment target or recognized shell/CI variables. Public client IDs can be defaults in Wrangler `vars`. The production config must contain the actual D1 catalog database ID before release. Deployment settings never come from local `.env` or generated `.dev.vars`. Referenced client IDs in the target secret file override Wrangler defaults, and recognized shell/CI credentials override the file. Other public application settings remain controlled by the selected Wrangler config. Keep dashboard changes synchronized with the committed config because deployment replaces dashboard variables with those values.

Application secrets and referenced connection client IDs/secrets come from the optional ignored `.env.secrets.preview` or `.env.secrets.production` file, according to the selected target. Recognized secret and client ID variables in shell/CI override that file. Use `.env.secrets.example` as a comments-only template only when the target file does not already exist, and uncomment only the keys to supply:

```sh
if [ ! -e .env.secrets.preview ]; then
  cp .env.secrets.example .env.secrets.preview
fi
chmod 600 .env.secrets.preview
# Fill selected app secrets and connection credentials privately, then:
npm run deploy:preview:check
npm run deploy:preview
```

The target secret source recognizes `SESSION_SIGNING_KEY`, `AI_API_KEY`, and client ID/secret bindings referenced by the active registry. Deployment generates their public/secret runtime bindings from those references. Unreferenced entries, including retired custom credential bindings, remain in the file for recovery but are not uploaded. Keep Cloudflare API credentials in shell/CI; they are tooling credentials and must not go in the target secret file. Preview deployments can use an existing `npx wrangler login` session. Production also requires `CLOUDFLARE_API_TOKEN` and `PRODUCTION_READINESS_FILE` in shell/CI.

Omitting an application secret preserves its existing remote value. Connector setup accepts nonblank saved credentials; leaving input blank preserves the saved value. To change a connection to a public registration, select `tokenAuthMethod: none` through setup; the secret reference is removed and no secret is sent. Missing credentials required by an enabled confidential connection block qualification. Production validation uses the production file and recognized shell/CI overrides. It never reads another target or an existing remote Worker secret to fill a missing value.

These npm commands use `scripts/deploy.ts`:

| Command | Behavior |
| --- | --- |
| `npm run deploy:preview:check` | Validate, test and build the preview; run Wrangler without publishing |
| `npm run deploy:preview` | Validate, test, build and deploy the preview with supplied secrets |
| `npm run deploy:preview:upload` | Validate, test, build and upload a preview version without activating it |
| `npm run deploy:production:check` | Run production release gates, verify the remote catalog, test/build and perform a deployment dry run |
| `npm run deploy` | Run the same production checks and publish the qualified release |

The script accepts `--target preview|production` (default `production`), `--config <jsonc>`, `--secrets-file <dotenv>` and `--dry-run`. `--upload-only` and `--skip-build` are preview-only options; skipping the build still runs tests and is intended for CI that already ran `npm run build`. A missing default target secret file is allowed; configuration checks still report required missing credentials. A missing explicitly requested file is an error. For example:

```sh
npm run deploy:preview:check -- --config wrangler.preview.jsonc --secrets-file /private/path/preview-secrets.env
npm run deploy:preview -- --config wrangler.preview.jsonc --secrets-file /private/path/preview-secrets.env
```

Deployment passes application and connector secrets with the Worker version through Wrangler's `--secrets-file`; they do not enter command arguments, the frontend or catalog. Private temporary deployment files are removed on success or failure. Inspect `.cache/deployment-*` after an abnormal OS shutdown that bypasses cleanup. Do not use raw `wrangler deploy` or `wrangler versions upload` as a substitute for these scripts: the wrapper loads the intended secret sources and runs the target's checks.

`npm run build` also uses an isolated temporary Wrangler config, disables frontend dotenv loading, and excludes application secrets from build subprocesses. Each wrapper-controlled Wrangler command receives an explicit empty environment file. This prevents local development bindings from being copied into build output or replacing deployment settings. `npm run deploy:check` runs the same preview checks as `deploy:preview:check`; CI uses it for type generation, TypeScript, tests, the build and a deployment dry run.

## Hosted preview

The `wrangler.preview.jsonc` configuration targets Worker `plan-shepherd` in the Moonba account at `https://plan-shepherd.moonbacare.com`, matching the connected Cloudflare Git build. It uses production browser security headers and API rate limiting, with patient connections, AI and production release approvals explicitly disabled. It has no D1 binding. Manual intake and bundled county lookup work; catalog searches report missing sources and no plans. The preview can receive application secrets through the deployment workflow while those processing controls remain disabled. `/api/status` reports `productionReady: false`.

`APP_ORIGIN` sets the trusted application origin and OAuth callbacks; it does not create a public hostname. The preview config also declares `plan-shepherd.moonbacare.com` as a Worker custom domain, letting Cloudflare manage its DNS record and HTTPS certificate. The old workers.dev address is disabled to keep browser requests on the configured origin. To target another account or hostname, update `account_id`, `name`, `routes` and exact HTTPS `APP_ORIGIN` together.

Using Node.js 24 and the optional secret setup above:

```sh
npx wrangler login
npm run deploy:preview:check
npm run deploy:preview
```

For the existing Cloudflare Workers Builds integration, use:

| Setting | Value |
| --- | --- |
| Worker name | `plan-shepherd` |
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:preview -- --skip-build` |
| Non-production branch deploy command | `npm run deploy:preview:upload -- --skip-build` |

Keep application and connector secrets in the Cloudflare build environment's recognized secret variables, or mount the target dotenv file as an owner-only regular file and pass its path with `--secrets-file`. Referenced client IDs can also be supplied through the file or shell/CI, overriding Wrangler defaults. The deployment script generates the appropriate runtime bindings, and other public application settings remain in the committed Wrangler config. The build integration already provides deployment credentials, so a separate GitHub Actions live-deployment workflow is unnecessary. Non-production branch uploads do not activate their version or change the live deployment.

For a CI-mounted credential file, adapt the deploy commands above to include its path:

```sh
npm run deploy:preview -- --skip-build --secrets-file /run/secrets/preview.env
npm run deploy:preview:upload -- --skip-build --secrets-file /run/secrets/preview.env
```

The mounted file must already exist, use dotenv format and have owner-only permissions such as 0600. Supply a file containing the preview credentials for these commands. Keep the file out of build artifacts and source control.

Build and typecheck commands generate `worker-configuration.d.ts` from the source Wrangler configuration before TypeScript runs. This file remains ignored by Git. The target deployment config avoids the development settings and placeholder database ID in Vite's default generated configuration.

Check `/`, its referenced JavaScript/CSS assets, `/api/health`, `/api/status` and `/api/geography/counties?state=MA` after deployment. HTML must have `Cache-Control: no-store`, CSP and HSTS; the API status must show disabled connections and AI, no catalog and `productionReady: false`. Source control includes regression tests for asset response headers.

## Production release

1. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run deploy:check`. The last command performs a local build dry run without deploying; it does not qualify a production release.
2. Configure `wrangler.production.jsonc` with the intended account and Worker, public HTTPS `APP_ORIGIN`, `APP_ENV=production`, actual D1 database ID and approved service settings. Declare a matching `routes` entry with `custom_domain: true` for a custom hostname and disable `workers_dev`; otherwise use the exact workers.dev origin. Keep preview URLs disabled. Review shared connection metadata in `config/connectors.json`; client IDs and secrets belong in `.env.secrets.production` or recognized shell/CI variables. Public client IDs may also be defaults in Wrangler `vars`.
3. Use `npm run connectors -- edit <key-or-uuid> --target production` for each connection that needs production credentials, then review `npm run connectors -- list --target production`. Preserve the existing production secret file, or create it as shown below only if absent; recognized secrets and client IDs may also be supplied through shell/CI. Supply `CLOUDFLARE_API_TOKEN` through shell/CI separately.
4. Verify live authorized Atrius and Cigna employer imports: identity/context, scopes, 2025 dates, paging/references, expiry/errors, partial data, cancellation and clearing. Cigna sandbox imports cannot satisfy the employer-import requirement; retain this release gate until the intended production endpoint and member population are available and qualified. Keep patient payloads out of test artifacts.
5. Independently qualify catalog/calculation results. Verify each of 153 state/family combinations as available with reviewed data or not offered with evidence. A missing source cannot be labeled not offered.
6. Create a release record with `npm run readiness:template -- /path/to/readiness.json`; set `PRODUCTION_READINESS_FILE` in shell/CI. The template has no approvals. Complete actual evidence for live imports, retention/service scope, callbacks, calculations, load and incident/rollback review without patient data.
7. Run `npm run deploy:production:check` for remote catalog verification and a production-configured dry run. The authorized operator then runs `npm run deploy`.

```sh
if [ ! -e .env.secrets.production ]; then
  cp .env.secrets.example .env.secrets.production
fi
chmod 600 .env.secrets.production
# Fill required app secrets and connection credentials privately and configure Wrangler.
# Supply CLOUDFLARE_API_TOKEN through your shell or CI secret manager.
export PRODUCTION_READINESS_FILE=/path/to/reviewed-readiness.json
npm run deploy:production:check
npm run deploy
```

Deployment validates every enabled registry entry and verifies the actual D1 active release against the record, including searchable available plans, verified benefits, and plan-term premium data for each offered county. It runs tests/build and supplies the qualified release ID with the deployment. Disabled optional registrations do not block configuration verification; the independent live Atrius and Cigna employer-import attestations remain required release gates. Publishing a different catalog release requires fresh release qualification.

The standalone `npm run verify:production` command checks local `.env` application/readiness settings with production credentials from `.env.secrets.production` and recognized shell overrides. Development connection credentials are excluded before loading production credentials. Use `npm run deploy:production:check` to validate the committed configuration and secret sources that will actually be deployed. Catalog and migration commands continue using their existing `.env` workflow.

## Monitoring and recovery

Use `/api/health` for uptime and `/api/status` for feature/catalog state. Neither exposes records or credentials. Native rate limits protect APIs/callbacks with hashed minute-scoped IP keys. They are not an account-level abuse guarantee; configure WAF/budget controls without logging patient bodies, especially for anonymous paid AI requests.

Imports are bounded to 100 pages per primary resource type, 20,000 primary resources, 500 authorized references and two reference hops, with byte limits/timeouts. Partial results are explicit. Comparisons accept at most 20 plans and 2,000 care events. The AI has separate context/output limits. Indexed public component rows keep large plan directories out of monolithic JSON documents.

For an incident, disable the affected processing approval and deploy the reviewed change. Do not enable patient-body logging. Rotate compromised app/provider secrets; signing-key rotation invalidates receipts and users reconnect. Restore the last reviewed Worker version for app regressions. For a catalog regression, atomically point `catalog_active.release_id` to a retained published release and requalify its release ID; never edit published plan rows. Check health/status, source coverage and synthetic comparisons before reopening.

Existing sessions pinned to an unsafe release need a reload/reimport. There is no persisted patient-session store to delete remotely. Actual load, device/browser accessibility, current source operation and external security/compliance qualification remain release checks. The browser automation runtime was unavailable during implementation; component tests do not replace visual device review.
