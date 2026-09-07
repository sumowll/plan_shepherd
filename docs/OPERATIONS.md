# Configuration and operations

## Local setup and registrations

The repository has a runnable application, public-catalog migrations and release tooling. It has no production account, source license, secret, completed release approval or deployed application. Manual intake works while unavailable sources remain visible.

Copy `.env.example` to `.env`. `npm run env:prepare` writes `.dev.vars` with mode 0600 for local Wrangler. Shell environment values override the file. Only an explicit list enters Worker bindings; deployment/feed credentials remain tooling-only. Never use `VITE_` for a secret.

The implemented connectors require **public SMART authorization-code clients with S256 PKCE and returned patient context**. Register exact redirects:

```text
<APP_ORIGIN>/oauth/callback/atrius
<APP_ORIGIN>/oauth/callback/cigna
```

Supported modes are `query` and `form_post`, patient read scopes and no offline access. Confidential client secrets, private-key JWT, mTLS and non-SMART patient-context discovery need a separate adapter if your registrations require them. No unverified ID-token fallback is used. Set authorization/token overrides together or use SMART discovery. Endpoints must be approved public HTTPS DNS names.

`ATRIUS_*` configures Atrius Epic. `CIGNA_*` must identify the approved **employer-sponsored** endpoint; a directory or Medicare endpoint is not equivalent. Token exchange must return a SMART `patient` and Bearer access token. Subsequent requests are cryptographically bound to the connector, token, authorized patient and expiry. Referenced provider/medication reads require a capability issued from an authorized record.

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

## Production release

1. Run `npm ci`, `npm run cf:types`, `npm run typecheck`, `npm test`, and `npm run deploy:check`. The last command performs a local dry run without deploying.
2. Configure public HTTPS `APP_ORIGIN`, `APP_ENV=production`, database, secrets and approved service settings. `CLOUDFLARE_CUSTOM_DOMAIN=true` binds that hostname; otherwise use the exact workers.dev origin. Preview URLs are disabled.
3. Verify live authorized Atrius and Cigna employer imports: identity/context, scopes, 2025 dates, paging/references, expiry/errors, partial data, cancellation and clearing. Keep patient payloads out of test artifacts.
4. Independently qualify catalog/calculation results. Verify each of 153 state/family combinations as available with reviewed data or not offered with evidence. A missing source cannot be labeled not offered.
5. Create a release record with `npm run readiness:template -- /path/to/readiness.json`; set `PRODUCTION_READINESS_FILE`. The template has no approvals. Complete actual evidence for live imports, retention/service scope, callbacks, calculations, load and incident/rollback review without patient data.
6. Run `npm run verify:production`, then `npm run deploy:production:check` for remote catalog verification and a production-configured dry run. The authorized operator then runs `npm run deploy`.

Deployment rereads `.env`, verifies the actual D1 active release against the record (including searchable available plans, verified benefits, and plan-term premium data for each offered county), runs tests/build, creates private temporary config with the real DB/runtime values, and supplies secrets through Wrangler's `--secrets-file`. Temporary files are cleaned on success/failure. Inspect `.cache/deployment-*` after an abnormal OS shutdown that bypassed cleanup. Secrets do not enter command arguments, the frontend or catalog. Publishing a different catalog release requires fresh release qualification.

## Monitoring and recovery

Use `/api/health` for uptime and `/api/status` for feature/catalog state. Neither exposes records or credentials. Native rate limits protect APIs/callbacks with hashed minute-scoped IP keys. They are not an account-level abuse guarantee; configure WAF/budget controls without logging patient bodies, especially for anonymous paid AI requests.

Imports are bounded to 100 pages per primary resource type, 20,000 primary resources, 500 authorized references and two reference hops, with byte limits/timeouts. Partial results are explicit. Comparisons accept at most 20 plans and 2,000 care events. The AI has separate context/output limits. Indexed public component rows keep large plan directories out of monolithic JSON documents.

For an incident, disable the affected processing approval and deploy the reviewed change. Do not enable patient-body logging. Rotate compromised app/provider secrets; signing-key rotation invalidates receipts and users reconnect. Restore the last reviewed Worker version for app regressions. For a catalog regression, atomically point `catalog_active.release_id` to a retained published release and requalify its release ID; never edit published plan rows. Check health/status, source coverage and synthetic comparisons before reopening.

Existing sessions pinned to an unsafe release need a reload/reimport. There is no persisted patient-session store to delete remotely. Actual load, device/browser accessibility, current source operation and external security/compliance qualification remain release checks. The browser automation runtime was unavailable during implementation; component tests do not replace visual device review.
