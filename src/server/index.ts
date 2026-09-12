import { Hono } from 'hono';
import { z } from 'zod';
import { termsPage } from './terms';
import { aiEnabled, appOrigin, connectorConfig, connectorRedirectUri, setting, type RuntimeEnv } from './config';
import { connectorDefinition, connectorRegistry } from './connector-registry';
import { AppError, boundedText, readRequest } from './http';
import { catalogSearchSchema, comparisonSchema } from './validation';
import { assistantRequestSchema, runAssistant } from './assistant';
import { discoverConnector, exchangeCode, getResourcePage, resourceRequestSchema, tokenRequestSchema } from '../connectors/transport';
import { catalogStatus, searchCatalog, getPlans, applyPremiumRates, CatalogReadLimitError } from '../catalog/repository';
import { getCountyOptions } from '../catalog/geography';
import { readBudget } from '../catalog/limits';
import { stateSchema } from '../catalog/schema';
import { authorizeReferences, getReferences, referenceRequestSchema } from '../connectors/references';
import { comparePlans, evaluateEligibility } from '../domain/index';
import type { AppStatus } from '../shared/contracts';

const app = new Hono<{ Bindings: RuntimeEnv }>();
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY'); c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
  if (setting(c.env, 'APP_ENV') === 'production') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api/')) {
    const origin = c.req.header('Origin');
    if (origin && origin !== appOrigin(c.env, c.req.url)) throw new AppError('origin_forbidden', 'This request must originate from the application.', 403);
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') throw new AppError('origin_forbidden', 'Cross-site requests are not accepted.', 403);
  }
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/callback/') || c.req.path.startsWith('/auth/callback/') || c.req.path === '/auth/callback') {
    const limiter = c.env.API_RATE_LIMITER;
    if (limiter) {
      const ip = c.req.header('CF-Connecting-IP') ?? 'local';
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${Math.floor(Date.now() / 60000)}:${ip}`));
      const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (!(await limiter.limit({ key })).success) throw new AppError('rate_limited', 'Please wait a moment before trying again.', 429);
    } else if (setting(c.env, 'APP_ENV') === 'production') throw new AppError('rate_limit_unconfigured', 'The service is not ready to accept requests.', 503);
  }
  await next();
});
app.onError((error, c) => {
  if (error instanceof CatalogReadLimitError) return c.json({ error: { code: 'catalog_selection_too_large', message: 'This comparison matches too much plan data. Compare fewer plans or care items at a time.' } }, 422);
  if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  if (error instanceof z.ZodError) return c.json({ error: { code: 'invalid_input', message: 'Please check the highlighted information.', fields: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } }, 400);
  // Never emit exception messages or input payloads to logs or to clients.
  return c.json({ error: { code: 'service_unavailable', message: 'This operation is temporarily unavailable. Your session has not been saved.' } }, 503);
});
app.get('/api/status', async c => {
  let catalog: AppStatus['catalog'] = { available: false, releaseId: null, planCount: 0 };
  try { catalog = await catalogStatus(c.env.CATALOG); } catch { /* A missing local database is an explicit unavailable state. */ }
  const definitions = connectorRegistry(c.env);
  const activeIds = new Set(definitions.filter(definition => definition.enabled).map(definition => definition.id));
  const connectors = definitions.map(({ id, key, organizationId, name, kind, apiType }) => {
    try {
      const config = connectorConfig(c.env, id);
      connectorRedirectUri(c.env, id, appOrigin(c.env, c.req.url));
      return { id, key, organizationId, name: config.name, kind, apiType, configured: config.configured, enabled: config.enabled,
        ...(config.testEnvironment ? { testEnvironment: true } : {}),
        ...(config.unavailableReason ? { reason: config.unavailableReason } : {}) };
    }
    catch (error) { return { id, key, organizationId, name, kind, apiType, configured: false, enabled: false, reason: error instanceof AppError && error.code === 'connector_configuration_invalid' ? error.message : 'Connection settings need attention.' }; }
  });
  const ai = { enabled: aiEnabled(c.env), ...(!aiEnabled(c.env) ? { reason: 'Awaiting approved AI configuration.' } : {}) };
  const issues = [...(!catalog.available ? ['Plan data is not published yet.'] : []), ...connectors.filter(x => activeIds.has(x.id) && !x.enabled).map(x => `${x.name} is not connected.`), ...(!ai.enabled ? ['The assistant is not configured.'] : [])];
  const productionReady = setting(c.env, 'APP_ENV') === 'production' && setting(c.env, 'PRODUCTION_RELEASE_APPROVED') === 'true'
    && setting(c.env, 'PRODUCTION_CATALOG_RELEASE_ID') === catalog.releaseId && issues.length === 0;
  return c.json({ year: 2026, connectors, ai, catalog, productionReady, issues } satisfies AppStatus);
});
app.post('/api/catalog/search', async c => c.json(await searchCatalog(c.env.CATALOG, catalogSearchSchema.parse(await readRequest(c.req.raw)))));
app.get('/api/geography/counties', async c => c.json(await getCountyOptions(c.env.CATALOG, stateSchema.parse(c.req.query('state')))));
app.post('/api/compare', async c => {
  const input = comparisonSchema.parse(await readRequest(c.req.raw));
  const catalogBudget = readBudget();
  const priceContexts = input.events.map(event => {
    const provider = input.providers.find(item => item.id === event.providerId);
    const medication = input.medications.find(item => item.id === event.medicationId);
    return { category: event.category, serviceCode: event.serviceCode, providerNpi: provider?.npi, providerLocation: provider?.location,
      rxnorm: medication?.rxnorm, ndc: medication?.ndc, date: event.date, daysSupply: event.daysSupply, dispensedQuantity: event.dispensedQuantity };
  });
  const rawPlans = await getPlans(c.env.CATALOG, input.planIds, input.releaseId, {
    countyFips: input.profile.countyFips, priceContexts,
    providerNpis: input.providers.flatMap(p => p.npi ? [p.npi] : []), rxnorms: input.medications.flatMap(m => m.rxnorm ? [m.rxnorm] : []),
    ndcs: input.medications.flatMap(m => m.ndc ? [m.ndc] : []), serviceCodes: input.events.flatMap(e => e.serviceCode ? [e.serviceCode] : []),
  }, catalogBudget);
  if (rawPlans.length !== new Set(input.planIds).size) throw new AppError('plan_unavailable', 'Some selected plans are unavailable in this catalog release. Search again.', 409);
  const birth = new Date(input.profile.dateOfBirth); const start = new Date(input.profile.coverageStart);
  const age = start.getUTCFullYear() - birth.getUTCFullYear() - (start.getUTCMonth() < birth.getUTCMonth() || start.getUTCMonth() === birth.getUTCMonth() && start.getUTCDate() < birth.getUTCDate() ? 1 : 0);
  const plans = await applyPremiumRates(c.env.CATALOG, rawPlans, { countyFips: input.profile.countyFips, zip: input.profile.zip, dateOfBirth: input.profile.dateOfBirth, age, tobacco: input.profile.tobacco === 'yes', coverageStart: input.profile.coverageStart, coverageEnd: input.profile.coverageEnd }, input.releaseId, catalogBudget);
  if (plans.some(p => p.state !== input.profile.state || !p.countyFips.includes(input.profile.countyFips))) throw new AppError('service_area', 'A selected plan does not serve the chosen county.', 400);
  if (plans.some(p => p.serviceAreas && !p.serviceAreas.some(area => area.countyFips === input.profile.countyFips && (area.wholeCounty || area.zipCodes?.includes(input.profile.zip))))) throw new AppError('service_area', 'A selected plan does not serve the chosen ZIP code.', 400);
  return c.json({ results: comparePlans(input, plans), eligibility: evaluateEligibility(input.profile) });
});
app.post('/api/assistant', async c => c.json(await runAssistant(c.env, assistantRequestSchema.parse(await readRequest(c.req.raw)))));
app.get('/api/connectors/:id/authorize', async c => {
  const { id } = connectorDefinition(c.env, c.req.param('id'));
  const origin = appOrigin(c.env, c.req.url);
  if (new URL(c.req.url).origin !== origin) throw new AppError('app_origin_mismatch', 'Open the application at its configured address before connecting.', 409);
  const config = await discoverConnector(c.env, id);
  return c.json({ connectionId: config.id, name: config.name, authorizationUrl: config.authorizationUrl, clientId: config.clientId, scopes: config.scopes, audience: config.base, responseMode: config.responseMode, redirectUri: connectorRedirectUri(c.env, id, origin), resources: config.resources });
});
app.post('/api/connectors/:id/token', async c => {
  const { id } = connectorDefinition(c.env, c.req.param('id'));
  return c.json(await exchangeCode(c.env, id, tokenRequestSchema.parse(await readRequest(c.req.raw, 16000)), appOrigin(c.env, c.req.url)));
});
app.post('/api/connectors/:id/resource', async c => {
  const { id } = connectorDefinition(c.env, c.req.param('id'));
  const authorization = c.req.header('Authorization') ?? '';
  if (!/^Bearer [^\s]{1,12000}$/.test(authorization)) throw new AppError('authorization_required', 'Connect to your provider before importing records.', 401);
  const input = resourceRequestSchema.parse(await readRequest(c.req.raw, 16000)); const token = authorization.slice(7);
  const page = await getResourcePage(c.env, id, input, token);
  return c.json({ page, ...await authorizeReferences(c.env, id, input.patientId, token, page) });
});
app.post('/api/connectors/:id/references', async c => {
  const { id } = connectorDefinition(c.env, c.req.param('id'));
  const authorization = c.req.header('Authorization') ?? '';
  if (!/^Bearer [^\s]{1,12000}$/.test(authorization)) throw new AppError('authorization_required', 'Connect before importing records.', 401);
  return c.json(await getReferences(c.env, id, referenceRequestSchema.parse(await readRequest(c.req.raw, 120000)), authorization.slice(7)));
});
app.on(['GET', 'POST'], ['/oauth/callback/:id', '/auth/callback/:id', '/auth/callback'], async c => {
  const definition = c.req.path === '/auth/callback'
    ? connectorRegistry(c.env).find(entry => entry.legacyCallbackPath === c.req.path)
    : connectorDefinition(c.env, c.req.param('id'));
  if (!definition) throw new AppError('connector_not_found', 'This connection is not registered.', 404);
  if (definition.apiType !== 'patient_access') throw new AppError('connector_not_configured', 'This API does not support patient sign-in.', 503);
  const { id } = definition;
  const callback = new URL(connectorRedirectUri(c.env, id, c.req.url));
  const received = new URL(c.req.url);
  if (received.origin !== callback.origin || received.pathname !== callback.pathname) throw new AppError('callback_mismatch', 'The sign-in response arrived at an unexpected callback address.', 400);
  if (c.req.method === 'POST' && c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new AppError('content_type', 'The callback requires form data.', 415);
  const params = c.req.method === 'POST' ? new URLSearchParams(await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 16000)) : new URL(c.req.url).searchParams;
  const nonce = crypto.randomUUID();
  const payload = JSON.stringify({ type: 'plan-shepherd:oauth', connector: id, code: params.get('code')?.slice(0, 4096), state: params.get('state')?.slice(0, 250), error: !!params.get('error') }).replace(/</g, '\\u003c');
  const origin = JSON.stringify(appOrigin(c.env, c.req.url));
  c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connecting securely</title><p>Returning to Plan Shepherd…</p><script nonce="${nonce}">history.replaceState(null,'','/oauth/complete');if(window.opener){window.opener.postMessage(${payload},${origin});window.close();}else{document.querySelector('p').textContent='Please return to Plan Shepherd and connect again.';}</script></html>`);
});
app.on('GET', ['/terms', '/terms/'], c => {
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return c.html(termsPage);
});
app.get('/api/health', c => c.json({ status: 'ok', version: '1.0.0' }));
app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Endpoint not found.' } }, 404));
app.get('*', async c => {
  // Keep local launches on the exact origin registered for OAuth, including host and port.
  if (c.req.path === '/' && setting(c.env, 'APP_ENV') === 'development') {
    const origin = appOrigin(c.env, c.req.url);
    if (new URL(c.req.url).origin !== origin) return c.redirect(`${origin}/`);
  }
  if (setting(c.env, 'APP_ENV') === 'production') c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; worker-src 'self' blob:");
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.ok && c.req.path.startsWith('/assets/') && !response.headers.get('Content-Type')?.includes('text/html')) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Pragma', undefined);
  }
  // Asset responses bypass Hono's response helpers, so apply the request's security headers explicitly.
  const headers = new Headers(response.headers);
  c.res.headers.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
export default app;
