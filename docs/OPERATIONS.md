# Configuration and operations

## Local setup and registrations

The repository has a runnable application, public-catalog migrations and release tooling. It has no production account, source license, secret, completed release approval or deployed application. Manual intake works while unavailable sources remain visible.

Copy `.env.example` to `.env`. `npm run dev` prepares `.dev.vars` with mode 0600 and uses the exact HTTP loopback host and port in `APP_ORIGIN`, defaulting to `http://127.0.0.1:5173`. It refuses to switch ports when one is occupied. Restart after configuration changes. `npm run env:prepare` remains available separately. Shell environment values override the file. Application settings and the environment bindings explicitly referenced by the registry enter Worker bindings; unrelated deployment/feed credentials remain tooling-only. Never use `VITE_` for a secret.

## Connector registry

[config/connectors.json](../config/connectors.json) is the server-only list of supported authorization server registrations, supporting up to 10,000 entries. Add a record to this JSON array to add a connection; API routes, callbacks, availability checks and the connection picker use its stable `id`. IDs contain lowercase letters, digits and hyphens, start with a letter or digit, and have at most 80 characters. Keep separate IDs for separate authorization servers, including sandbox and production registrations. Never reassign an existing ID to a different authorization server. Multiple FHIR services sharing an authorization server do not inherently require separate callbacks; each configured entry represents the FHIR base and client registration used for its import.

For example, append this record while retaining any existing connections you want to offer:

```json
{
  "id": "hospital-123",
  "name": "Example Hospital",
  "kind": "provider",
  "scopeProfile": "smart",
  "fhirBaseUrl": "https://ehr.example.com/fhir/R4",
  "clientIdEnv": "HOSPITAL_123_CLIENT_ID",
  "clientSecretEnv": "HOSPITAL_123_CLIENT_SECRET",
  "tokenAuthMethod": "client_secret_basic",
  "scopes": "launch/patient patient/*.read",
  "enabled": true
}
```

Set `HOSPITAL_123_CLIENT_ID` and `HOSPITAL_123_CLIENT_SECRET` privately in `.env` or CI's secret environment. The environment preparation and deployment scripts automatically include these referenced bindings. A public registration may instead specify `tokenAuthMethod: "none"` and omit `clientSecretEnv`; a public `clientId` literal is also supported. Client secrets must use `clientSecretEnv`; the registry rejects literal `clientSecret` values and references to unrelated application secrets. Declaring `clientSecretEnv` requires that secret unless the authentication method is explicitly `none`. The JSON is versioned configuration, so do not store secrets or patient data in it.

Register the exact `<APP_ORIGIN>/oauth/callback/hospital-123` callback in this server's client registration, including protocol, hostname, port and path. For example, with `APP_ORIGIN=http://localhost:3000`, use `http://localhost:3000/oauth/callback/hospital-123`. Production uses the public HTTPS application origin. An optional `redirectUri` must match that origin and the entry's callback path. The shared handler validates the connection identity against the sign-in attempt. Adding a registry record does not automatically register a client or grant access with an external server.

Use `kind: "provider"` or `"payer"` for display and default imports, and select the documented grant behavior with `scopeProfile: "smart"`, `"epic"` or `"cigna"`. Use `smart` for standard SMART patient-read and optional identity scopes; the other profiles recognize their existing vendor grant formats. Provider imports default to `Patient`, `Encounter`, `MedicationRequest` and `MedicationDispense`; payer imports default to `Patient` and `ExplanationOfBenefit`. An explicit `resources` array must start with `Patient`, contain no duplicates, and use only supported types (the default types above or `Condition`). Both the browser import and the resource API enforce the configured selection. `authorizationUrl` and `tokenUrl` must be set together when overriding discovery. `enabled` defaults to true; false disables that connection and skips discovery and its production configuration check. Use `testEnvironment: true` to label a test registration. Registry entries are validated before use; duplicate IDs and invalid definitions fail closed.

The bundled Atrius and Cigna records retain their current IDs, callback URLs, scope defaults and environment prefixes. `legacyEnvPrefixes` exists to preserve those registrations; new records should use explicit `clientIdEnv` and `clientSecretEnv` references. Restart local development after registry or environment changes. Rebuild and redeploy for production registry changes.

For small environment-specific catalogs, `CONNECTOR_REGISTRY` may contain a JSON array that **replaces the entire bundled registry**. An explicit blank or invalid value fails validation; omit the variable to use the bundled file. Local preparation and deployment preserve the override and reject values over 5,120 UTF-8 bytes. Keep large catalogs in `config/connectors.json` so the catalog itself does not consume a Worker variable. Cloudflare also limits the number of variables and secrets, so a catalog with thousands of separate credential bindings requires a separate credential-storage design; this registry does not remove those platform limits. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).

## Client registration settings

The connectors use authorization-code flow with S256 PKCE and explicit returned patient context. Set each record's `tokenAuthMethod`, or `ATRIUS_TOKEN_AUTH_METHOD` / `CIGNA_TOKEN_AUTH_METHOD` for the bundled defaults, to match the registration:

| Method | Registration | Default |
| --- | --- | --- |
| `none` | Public client; no client secret is sent | Registration without a secret |
| `client_secret_basic` | Confidential client; secret sent through HTTP Basic authentication | SMART/Epic profile with a secret |
| `client_secret_post` | Confidential client; secret sent in the token request body | Cigna profile with a secret |

Confidential clients require the corresponding `*_CLIENT_SECRET`. Private-key JWT, mTLS and patient-context discovery outside SMART need a separate adapter. Register exact redirects:

```text
<APP_ORIGIN>/oauth/callback/atrius
<APP_ORIGIN>/oauth/callback/cigna
```

`ATRIUS_*` configures Atrius Epic. A corresponding `EPIC_*` value is used only when the `ATRIUS_*` key is absent; an explicit blank canonical value wins. Remove unused blank `ATRIUS_*` keys when retaining a legacy Epic registration. `ATRIUS_REDIRECT_URI` and `CIGNA_REDIRECT_URI` can set the matching callback explicitly. Legacy `EPIC_REDIRECT_URI=<APP_ORIGIN>/auth/callback` is supported, but every callback must use the same origin as `APP_ORIGIN`.

Supported response modes are `query` and `form_post`. Atrius requests `launch/patient patient/*.read` by default; Cigna requests `openid fhirUser patient/*.read`. Explicit `*_SCOPES` values override these defaults. Requested scopes use a connector-specific allowlist. Token responses also accept native Epic operation grants such as `Patient.read` and `Encounter.search`, and Cigna's `search` and `read` grants. Write, user-wide, system-wide, refresh-token and unknown scopes remain rejected. Set authorization/token endpoint overrides together or use SMART discovery. Endpoints must be approved public HTTPS DNS names.

Token exchange must return an explicit SMART `patient` and Bearer access token, including when native grants are returned. Subsequent requests are cryptographically bound to the connector, token, authorized patient and expiry. Referenced provider/medication reads require a capability issued from an authorized record.

The `smart` and `cigna` profiles accept `openid` and `fhirUser` for registration compatibility; the `epic` profile retains its existing patient-read scope behavior. Returned ID tokens are discarded, never used to identify a patient or sent to the browser. A signed-in user may represent another patient. A response without an explicit SMART `patient` still fails with `missing_patient_context`. Using OpenID identity in a future adapter requires validated tokens and an explicit mapping to the authorized patient. See [SMART identity scopes](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html#scopes-for-requesting-identity-data).

[Cigna's published Patient Access guide](https://developer.cigna.com/assets/content/service-apis/patient-access/getting-started.md) requests the identity/patient scopes above, illustrates `search read openid` grants with explicit `patient` context, and lists US Commercial availability beginning January 1, 2027. Sandbox/devportal endpoints contain test data. A sandbox, directory or Medicare registration does not establish access to employer-sponsored records. Verify the endpoint and member population against the registration; actual granted scopes and patient context still need qualification.

Run `npm run connectors:check` after editing `.env` or the registry. It lists every registration, reports configuration problems, callback addresses and token authentication methods, and checks public SMART discovery for up to four connections at a time when explicit endpoint overrides are absent. Disabled registrations are listed and skip discovery. With endpoint overrides it validates configuration; sign-in checks endpoint availability. The command does not authenticate a member, exchange a code, read records or qualify a registration.

For an unavailable connector, follow the reported issue: supply the client ID and secret through its referenced bindings, configure its public HTTPS `fhirBaseUrl`, and check `SESSION_SIGNING_KEY` and the environment's existing `PATIENT_PROCESSING_APPROVED` control. For the bundled defaults, continue using `*_CLIENT_ID`, `*_CLIENT_SECRET` and `*_FHIR_BASE_URL`; Atrius has a default FHIR base and Cigna requires one. Match `APP_ORIGIN`, callback path, client authentication method and requested scopes to the actual registration. Then restart with `npm run dev` and use **Retry availability** in the connection section. For Cigna's documented scope request, set `CIGNA_SCOPES=openid fhirUser patient/*.read`.

Generate an application signing secret locally, then put it in `.env` or your secret manager:

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

Provision D1 `plan-shepherd-catalog`; put its actual ID, account ID and scoped API token in `.env`. Scripts never create or delete a remote database implicitly.

```sh
npm run db:migrate:production
npm run catalog:import -- --file /path/to/reviewed-catalog.json --validate-only
npm run catalog:import -- --file /path/to/reviewed-catalog.json --output-sql /path/to/review.sql
npm run catalog:import -- --file /path/to/reviewed-catalog.json --remote
```

Use `--bundle` for national partitions. Review source rights, versions, freshness, service areas, benefits, exact networks/formularies and prices. Missing semantics require mapping and review, not a verification flag. [DATA_SOURCES.md](DATA_SOURCES.md) distinguishes implemented adapters from remaining acquisition work.

Imports stage a complete release and change one active pointer after schema/count checks. Published data is immutable. Failed imports leave the previous release active; identify failed staging rows before cleanup. Retain published releases for comparisons pinned to them.

## Hosted preview

The separate `wrangler.preview.jsonc` configuration targets Worker `plan-shepherd-preview` in the Moonba account at `https://plan-shepherd-preview.late-mouse-6954.workers.dev`. It uses production browser security headers and API rate limiting, with patient connections, AI and production release approvals explicitly disabled. It attaches no integration secrets or D1 database. Manual intake and bundled county lookup work; catalog searches report missing sources and no plans. This is a preview for evaluating the interface, and `/api/status` reports `productionReady: false`.

Using Node.js 24:

```sh
npx wrangler login
npm run deploy:preview:check
npm run deploy:preview
```

The commands build the application and deploy only the compiled Worker and public client assets. Local `.env` and `.dev.vars` credentials are not uploaded. The preview configuration has its own Worker name and does not change the production deployment gates. To target another account, update its `account_id`, `name` and exact HTTPS `APP_ORIGIN` together. The default `npm run deploy` still runs the fully qualified production release workflow below.

Check `/`, its referenced JavaScript/CSS assets, `/api/health`, `/api/status` and `/api/geography/counties?state=MA` after deployment. HTML must have `Cache-Control: no-store`, CSP and HSTS; the API status must show disabled connections and AI, no catalog and `productionReady: false`. Source control includes regression tests for asset response headers.

## Production release

1. Run `npm ci`, `npm run cf:types`, `npm run typecheck`, `npm test`, and `npm run deploy:check`. The last command performs a local dry run without deploying.
2. Configure public HTTPS `APP_ORIGIN`, `APP_ENV=production`, database, secrets and approved service settings. `CLOUDFLARE_CUSTOM_DOMAIN=true` binds that hostname; otherwise use the exact workers.dev origin. Preview URLs are disabled.
3. Verify live authorized Atrius and Cigna employer imports: identity/context, scopes, 2025 dates, paging/references, expiry/errors, partial data, cancellation and clearing. Cigna sandbox imports cannot satisfy the employer-import requirement; retain this release gate until the intended production endpoint and member population are available and qualified. Keep patient payloads out of test artifacts.
4. Independently qualify catalog/calculation results. Verify each of 153 state/family combinations as available with reviewed data or not offered with evidence. A missing source cannot be labeled not offered.
5. Create a release record with `npm run readiness:template -- /path/to/readiness.json`; set `PRODUCTION_READINESS_FILE`. The template has no approvals. Complete actual evidence for live imports, retention/service scope, callbacks, calculations, load and incident/rollback review without patient data.
6. Run `npm run verify:production`, then `npm run deploy:production:check` for remote catalog verification and a production-configured dry run. The authorized operator then runs `npm run deploy`.

Deployment rereads `.env`, validates every enabled registry entry, verifies the actual D1 active release against the record (including searchable available plans, verified benefits, and plan-term premium data for each offered county), runs tests/build, creates private temporary config with the real DB/runtime values, and supplies secrets through Wrangler's `--secrets-file`. Bindings referenced by any `clientSecretEnv`, and legacy `*_CLIENT_SECRET` bindings, are stored as Worker secrets alongside the signing key and AI key. Disabled optional registrations do not block configuration verification; the existing independent live Atrius and Cigna employer-import attestations remain required release gates. Temporary files are cleaned on success/failure. Inspect `.cache/deployment-*` after an abnormal OS shutdown that bypassed cleanup. Secrets do not enter command arguments, the frontend or catalog. Publishing a different catalog release requires fresh release qualification.

## Monitoring and recovery

Use `/api/health` for uptime and `/api/status` for feature/catalog state. Neither exposes records or credentials. Native rate limits protect APIs/callbacks with hashed minute-scoped IP keys. They are not an account-level abuse guarantee; configure WAF/budget controls without logging patient bodies, especially for anonymous paid AI requests.

Imports are bounded to 100 pages per primary resource type, 20,000 primary resources, 500 authorized references and two reference hops, with byte limits/timeouts. Partial results are explicit. Comparisons accept at most 20 plans and 2,000 care events. The AI has separate context/output limits. Indexed public component rows keep large plan directories out of monolithic JSON documents.

For an incident, disable the affected processing approval and deploy the reviewed change. Do not enable patient-body logging. Rotate compromised app/provider secrets; signing-key rotation invalidates receipts and users reconnect. Restore the last reviewed Worker version for app regressions. For a catalog regression, atomically point `catalog_active.release_id` to a retained published release and requalify its release ID; never edit published plan rows. Check health/status, source coverage and synthetic comparisons before reopening.

Existing sessions pinned to an unsafe release need a reload/reimport. There is no persisted patient-session store to delete remotely. Actual load, device/browser accessibility, current source operation and external security/compliance qualification remain release checks. The browser automation runtime was unavailable during implementation; component tests do not replace visual device review.
