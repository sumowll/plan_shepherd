import { z } from 'zod';
import { connectorConfig, connectorRedirectUri, connectorScopesAllowed, safeHttpsUrl, setting, type ConnectorId } from '../server/config';
import { AppError, boundedJson, safeFetch } from '../server/http';
import { importResourceSchema, type ScopeProfile } from '../shared/connectors';
import { signReceipt, verifyReceipt } from './receipt';

const endpointsSchema = z.object({ authorization_endpoint: z.string().url(), token_endpoint: z.string().url() });
const capabilitySchema = z.object({
  resourceType: z.enum(['CapabilityStatement', 'Conformance']),
  rest: z.array(z.object({
    mode: z.string().optional(),
    security: z.object({ extension: z.array(z.object({
      url: z.string(), extension: z.array(z.object({ url: z.string(), valueUri: z.string().optional() })).optional(),
    })).optional() }).optional(),
  })),
});
function capabilityEndpoints(data: unknown): unknown {
  const capability = capabilitySchema.safeParse(data);
  if (!capability.success) return undefined;
  for (const rest of capability.data.rest) {
    if (rest.mode === 'client') continue;
    for (const extension of rest.security?.extension ?? []) {
      if (!['http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris', 'http://hl7.org/fhir/StructureDefinition/oauth-uris'].includes(extension.url)) continue;
      const authorization = extension.extension?.filter(value => value.url === 'authorize') ?? [];
      const token = extension.extension?.filter(value => value.url === 'token') ?? [];
      if (authorization.length === 1 && token.length === 1) return { authorization_endpoint: authorization[0].valueUri, token_endpoint: token[0].valueUri };
    }
  }
  return undefined;
}
export async function discoverConnector(env: Record<string, unknown>, id: ConnectorId) {
  const config = connectorConfig(env, id);
  if (!config.enabled) throw new AppError('connector_not_configured', config.unavailableReason ?? 'This connection is not enabled.', 503);
  if (config.authorizationUrl && config.tokenUrl) return config;
  let response = await safeFetch(`${config.base}/.well-known/smart-configuration`, { headers: { Accept: 'application/json' } });
  let fromCapability = false;
  // Older SMART servers publish OAuth URIs only in their FHIR CapabilityStatement.
  // Do not mask outages or malformed discovery documents by silently changing sources.
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel();
    response = await safeFetch(`${config.base}/metadata`, { headers: { Accept: 'application/fhir+json, application/json' } });
    fromCapability = true;
  }
  if (!response.ok) throw new AppError('discovery_failed', 'The provider’s authorization settings could not be retrieved.', 502);
  const data = await boundedJson(response, fromCapability ? 2 * 1024 * 1024 : 64000);
  const discovery = endpointsSchema.safeParse(fromCapability ? capabilityEndpoints(data) : data);
  if (!discovery.success) throw new AppError('discovery_failed', 'The provider did not publish its sign-in settings. This connection’s API address or sign-in configuration needs attention.', 502);
  try { return { ...config, authorizationUrl: safeHttpsUrl(discovery.data.authorization_endpoint).href, tokenUrl: safeHttpsUrl(discovery.data.token_endpoint).href }; }
  catch { throw new AppError('discovery_failed', 'The provider published unsupported authorization endpoints. Check the connection configuration.', 502); }
}
export function grantedConnectorScopesAllowed(scopeProfile: ScopeProfile, scopes: string): boolean {
  const values = scopes.trim().split(/\s+/);
  // Epic returns registered API operations; Cigna may return read/search grants.
  // The token must still identify a patient, and every resource remains patient-bound.
  return !!scopes.trim() && values.every(scope => connectorScopesAllowed(scopeProfile, scope)
    || scopeProfile === 'epic' && /^[A-Z][A-Za-z]+\.(?:read|search)$/.test(scope)
    || scopeProfile === 'cigna' && (scope === 'read' || scope === 'search'));
}
export const tokenRequestSchema = z.object({ code: z.string().min(1).max(4096), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) });
export async function exchangeCode(env: Record<string, unknown>, id: ConnectorId, input: z.infer<typeof tokenRequestSchema>, origin: string) {
  const redirectUri = connectorRedirectUri(env, id, origin);
  const config = await discoverConnector(env, id);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: redirectUri, code_verifier: input.verifier });
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
  if (config.tokenAuthMethod === 'client_secret_basic') {
    // RFC 6749 section 2.3.1 requires form encoding each credential before Base64.
    const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
    headers.set('Authorization', `Basic ${btoa(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`)}`);
  } else {
    body.set('client_id', config.clientId);
    if (config.tokenAuthMethod === 'client_secret_post') body.set('client_secret', config.clientSecret);
  }
  const response = await safeFetch(config.tokenUrl, { method: 'POST', headers, body });
  if (!response.ok) throw new AppError('authorization_failed', 'Authorization was not completed. Please reconnect to your provider.', 401);
  // Cigna identity scopes support its registration. ID tokens are discarded;
  // patient authorization still comes exclusively from the token response's patient context.
  const token = z.object({ access_token: z.string().min(1).max(12000), token_type: z.string(), expires_in: z.number().positive().optional(), patient: z.string().max(250).optional(), scope: z.string().optional() }).parse(await boundedJson(response, 64000));
  if (token.token_type.toLowerCase() !== 'bearer' || !token.patient || !/^[A-Za-z0-9.-]+$/.test(token.patient)) throw new AppError('missing_patient_context', 'The approved connection must return a SMART patient context. Check its registration and scopes.', 502);
  const granted = (token.scope ?? config.scopes).trim().split(/\s+/).join(' ');
  if (!grantedConnectorScopesAllowed(config.scopeProfile, granted)) throw new AppError('unsafe_scope', 'This connection returned permissions outside its supported patient read and identity scopes.', 502);
  const expiresIn = token.expires_in ?? 300;
  const receipt = await signReceipt(setting(env, 'SESSION_SIGNING_KEY'), id, token.patient, token.access_token, expiresIn);
  return { accessToken: token.access_token, patientId: token.patient, expiresIn, scopes: granted, receipt };
}
export const resourceRequestSchema = z.object({ receipt: z.string().min(1).max(4096), patientId: z.string().regex(/^[A-Za-z0-9.-]{1,250}$/), resource: importResourceSchema, next: z.string().max(8000).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export function assertPatientOwnership(page: unknown, patientId: string, base?: string, expectedResource?: string): void {
  if (!page || typeof page !== 'object') throw new AppError('invalid_fhir', 'The provider returned an invalid FHIR response.', 502);
  const data = page as Record<string, unknown>;
  const rows = data.resourceType === 'Bundle' && Array.isArray(data.entry) ? data.entry.map(x => x && typeof x === 'object' ? x.resource : undefined) : [data];
  let patientFound = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const allowed = ['Patient','Practitioner','PractitionerRole','Organization','Location','Medication','OperationOutcome', ...(expectedResource ? [expectedResource] : ['Encounter','ExplanationOfBenefit','MedicationRequest','MedicationDispense','Condition'])];
    if (!allowed.includes(String(r.resourceType))) throw new AppError('unexpected_resource', 'The provider returned an unexpected type of record.', 502);
    if (r.resourceType === 'Patient') { if (r.id !== patientId) throw new AppError('patient_mismatch', 'The provider returned records for a different patient.', 502); patientFound = true; continue; }
    if (['Encounter','ExplanationOfBenefit','MedicationRequest','MedicationDispense','Condition'].includes(String(r.resourceType))) {
      const subject = (r.patient ?? r.subject) as { reference?: unknown } | undefined;
      const ref = typeof subject?.reference === 'string' ? subject.reference : '';
      if (ref !== `Patient/${patientId}` && (!base || ref !== `${base.replace(/\/$/, '')}/Patient/${patientId}`)) throw new AppError('patient_mismatch', 'Record ownership could not be verified against the authorized patient.', 502);
    }
  }
  if (expectedResource === 'Patient' && !patientFound) throw new AppError('missing_patient', 'The connection did not return the authorized patient identity.', 502);
}
export function allowedResourceUrl(base: string, input: Omit<z.infer<typeof resourceRequestSchema>, 'receipt'>): URL {
  const baseUrl = new URL(`${base.replace(/\/$/, '')}/`);
  let url: URL;
  if (input.next) {
    url = new URL(input.next, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname) || url.username || url.password || url.hash) throw new AppError('invalid_page', 'The provider returned an invalid continuation link.', 502);
    const path = url.pathname.slice(baseUrl.pathname.length);
    if (!(path === input.resource || path === '_getpages' || path === '')) throw new AppError('invalid_page', 'The continuation link points to an unexpected resource.', 502);
    if (url.searchParams.has('patient') && url.searchParams.get('patient') !== input.patientId) throw new AppError('invalid_page', 'The continuation link changed the selected patient.', 502);
  } else {
    url = new URL(input.resource === 'Patient' ? `Patient/${encodeURIComponent(input.patientId)}` : input.resource, baseUrl);
    if (input.resource !== 'Patient') {
      url.searchParams.set('patient', input.patientId);
      url.searchParams.set('_count', '100');
      // Search parameters differ by resource and server capability. Unsupported filters must be reported, not silently dropped.
      const parameter = input.resource === 'MedicationDispense' ? 'whenhandedover' : input.resource === 'MedicationRequest' ? 'authoredon' : input.resource === 'ExplanationOfBenefit' ? 'service-date' : 'date';
      if (input.resource !== 'Condition') { url.searchParams.append(parameter, `ge${input.from}`); url.searchParams.append(parameter, `le${input.to}`); }
    }
  }
  return url;
}
export async function getResourcePage(env: Record<string, unknown>, id: ConnectorId, input: z.infer<typeof resourceRequestSchema>, accessToken: string) {
  const config = connectorConfig(env, id);
  if (!config.enabled) throw new AppError('connector_not_configured', 'This connection is not enabled.', 503);
  await verifyReceipt(setting(env, 'SESSION_SIGNING_KEY'), input.receipt, id, input.patientId, accessToken);
  if (!config.resources.includes(input.resource)) throw new AppError('resource_unavailable', 'This resource is not enabled for the approved connection.', 422);
  const target = allowedResourceUrl(config.base, input);
  const response = await safeFetch(target, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' } });
  if (response.status === 401) throw new AppError('session_expired', 'Your provider authorization expired. Reconnect to continue.', 401);
  if (response.status === 403 || response.status === 404 || response.status === 400) throw new AppError('resource_unavailable', 'This resource or date filter is unavailable through the approved connection.', 422);
  if (response.status === 429) throw new AppError('provider_rate_limit', 'Your provider has temporarily limited requests. Please retry shortly.', 429);
  if (!response.ok) throw new AppError('provider_error', 'The provider could not return this part of your record.', 502);
  const page = await boundedJson(response, 8 * 1024 * 1024);
  assertPatientOwnership(page, input.patientId, config.base, input.resource);
  return page;
}
