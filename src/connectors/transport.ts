import { z } from 'zod';
import { connectorConfig, safeHttpsUrl, setting, type ConnectorId } from '../server/config';
import { AppError, boundedJson, safeFetch } from '../server/http';
import { signReceipt, verifyReceipt } from './receipt';

const endpointsSchema = z.object({ authorization_endpoint: z.string().url(), token_endpoint: z.string().url() });
export async function discoverConnector(env: Record<string, unknown>, id: ConnectorId) {
  const config = connectorConfig(env, id);
  if (!config.enabled) throw new AppError('connector_not_configured', 'This connection is not enabled. You can enter your information manually.', 503);
  if (config.authorizationUrl && config.tokenUrl) return config;
  const response = await safeFetch(`${config.base}/.well-known/smart-configuration`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new AppError('discovery_failed', 'The provider’s authorization settings could not be retrieved.', 502);
  const discovery = endpointsSchema.parse(await boundedJson(response, 64000));
  return { ...config, authorizationUrl: safeHttpsUrl(discovery.authorization_endpoint).href, tokenUrl: safeHttpsUrl(discovery.token_endpoint).href };
}
export const tokenRequestSchema = z.object({ code: z.string().min(1).max(4096), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) });
export async function exchangeCode(env: Record<string, unknown>, id: ConnectorId, input: z.infer<typeof tokenRequestSchema>, origin: string) {
  const config = await discoverConnector(env, id);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: `${origin}/oauth/callback/${id}`, client_id: config.clientId, code_verifier: input.verifier });
  const response = await safeFetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  if (!response.ok) throw new AppError('authorization_failed', 'Authorization was not completed. Please reconnect to your provider.', 401);
  const token = z.object({ access_token: z.string().min(1).max(12000), token_type: z.string(), expires_in: z.number().positive().optional(), patient: z.string().max(250).optional(), scope: z.string().optional() }).parse(await boundedJson(response, 64000));
  if (token.token_type.toLowerCase() !== 'bearer' || !token.patient || !/^[A-Za-z0-9.-]+$/.test(token.patient)) throw new AppError('missing_patient_context', 'The approved connection must return a SMART patient context. Check its registration and scopes.', 502);
  const granted = token.scope ?? config.scopes;
  if (!granted.split(/\s+/).every(s => s === 'launch/patient' || /^patient\/(?:\*|[A-Za-z]+)\.(?:read|rs|r|s)$/.test(s))) throw new AppError('unsafe_scope', 'This connection returned permissions outside the patient read-only registration.', 502);
  const expiresIn = token.expires_in ?? 300;
  const receipt = await signReceipt(setting(env, 'SESSION_SIGNING_KEY'), id, token.patient, token.access_token, expiresIn);
  return { accessToken: token.access_token, patientId: token.patient, expiresIn, scopes: granted, receipt };
}
export const resourceRequestSchema = z.object({ receipt: z.string().min(1).max(4096), patientId: z.string().regex(/^[A-Za-z0-9.-]{1,250}$/), resource: z.enum(['Patient', 'Encounter', 'ExplanationOfBenefit', 'MedicationRequest', 'MedicationDispense', 'Condition']), next: z.string().max(8000).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
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
