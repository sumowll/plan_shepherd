import { z } from 'zod';
import { AppError } from './http';
import { connectorDefinition } from './connector-registry';
import type { ImportResource, ScopeProfile } from '../shared/connectors';

export type RuntimeEnv = Cloudflare.Env & Record<string, unknown>;
export type { ConnectorId } from '../shared/connectors';
const httpsUrl = z.string().url().refine(value => {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  // Registrations use public DNS names. Reject every numeric/IPv6 host and local suffix;
  // outbound targets are administrator configuration, never user-supplied URLs.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search
    && host.includes('.') && !/^[\d.]+$/.test(host) && !host.includes(':') && !host.includes('[')
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) && (!u.port || u.port === '443');
}, 'An approved public HTTPS endpoint is required');

export function setting(env: Record<string, unknown>, name: string, fallback = ''): string {
  const value = env[name];
  return typeof value === 'string' ? value : fallback;
}
export function approved(env: Record<string, unknown>, name: string): boolean { return setting(env, name) === 'true'; }
export function connectorSetting(env: Record<string, unknown>, id: string, name: string, fallback = ''): string {
  const definition = connectorDefinition(env, id);
  // Compatibility bindings are declared in the registry in precedence order.
  // Explicit blanks still win over the next legacy prefix.
  for (const prefix of definition.legacyEnvPrefixes) {
    const key = `${prefix}_${name}`;
    if (typeof env[key] === 'string') return setting(env, key);
  }
  return fallback;
}
export function connectorScopesAllowed(profile: ScopeProfile, scopes: string): boolean {
  return !!scopes.trim() && scopes.trim().split(/\s+/).every(scope => scope === 'launch/patient'
    || /^patient\/(?:\*|[A-Za-z]+)\.(?:read|rs|r|s)$/.test(scope)
    || (profile !== 'epic' && (scope === 'openid' || scope === 'fhirUser')));
}
export function connectorConfig(env: Record<string, unknown>, id: string) {
  const definition = connectorDefinition(env, id);
  const { name, kind, scopeProfile } = definition;
  const base = connectorSetting(env, id, 'FHIR_BASE_URL', definition.fhirBaseUrl).replace(/\/$/, '');
  const clientId = definition.clientIdEnv ? setting(env, definition.clientIdEnv) : connectorSetting(env, id, 'CLIENT_ID', definition.clientId);
  const clientSecret = definition.clientSecretEnv ? setting(env, definition.clientSecretEnv) : connectorSetting(env, id, 'CLIENT_SECRET');
  const authorizationUrl = connectorSetting(env, id, 'AUTHORIZATION_URL', definition.authorizationUrl);
  const tokenUrl = connectorSetting(env, id, 'TOKEN_URL', definition.tokenUrl);
  const scopes = connectorSetting(env, id, 'SCOPES', definition.scopes ?? (scopeProfile === 'cigna' ? 'openid fhirUser patient/*.read' : 'launch/patient patient/*.read'));
  if (!connectorScopesAllowed(scopeProfile, scopes)) throw new AppError('connector_configuration_invalid', `${name} sign-in permissions need configuration.`, 503);
  const defaultAuthMethod = clientSecret || definition.clientSecretEnv ? scopeProfile === 'cigna' ? 'client_secret_post' : 'client_secret_basic' : 'none';
  const authMethod = z.enum(['none', 'client_secret_basic', 'client_secret_post']).safeParse(connectorSetting(env, id, 'TOKEN_AUTH_METHOD', definition.tokenAuthMethod ?? defaultAuthMethod));
  if (!authMethod.success) throw new AppError('connector_configuration_invalid', `${name} token authentication method is unsupported.`, 503);
  if (!!authorizationUrl !== !!tokenUrl) throw new AppError('connector_configuration_invalid', `${name} sign-in and token addresses must be configured together.`, 503);
  if (authorizationUrl && (!httpsUrl.safeParse(authorizationUrl).success || !httpsUrl.safeParse(tokenUrl).success)) throw new AppError('connector_configuration_invalid', `${name} sign-in and token addresses need secure connection configuration.`, 503);
  const configured = !!clientId.trim() && httpsUrl.safeParse(base).success && (authMethod.data === 'none' || !!clientSecret);
  const unavailableReason = !definition.enabled ? `${name} is currently disabled.`
    : !clientId.trim() ? `${name} app registration is missing a client ID.`
    : !base ? `${name} FHIR API address is missing.`
    : !httpsUrl.safeParse(base).success ? `${name} FHIR API address must be a public HTTPS URL.`
    : authMethod.data !== 'none' && !clientSecret ? `${name} app registration requires a client secret.`
    : !approved(env, 'PATIENT_PROCESSING_APPROVED') ? 'Patient record connections have not been enabled for this environment.'
    : setting(env, 'SESSION_SIGNING_KEY').length < 32 ? 'Secure connection sessions have not been configured.'
    : undefined;
  return {
    // This is server-only configuration. Public routes must project individual safe fields.
    id, name, kind, scopeProfile, base, clientId, clientSecret, tokenAuthMethod: authMethod.data, scopes,
    resources: [...(definition.resources ?? (kind === 'provider' ? ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'] : ['Patient', 'ExplanationOfBenefit']))] as ImportResource[],
    testEnvironment: definition.testEnvironment || definition.testFhirBaseUrls.some(url => url.replace(/\/$/, '') === base),
    configured, enabled: !unavailableReason, unavailableReason, authorizationUrl, tokenUrl,
    responseMode: connectorSetting(env, id, 'RESPONSE_MODE', definition.responseMode) === 'form_post' ? 'form_post' as const : 'query' as const,
  };
}
export function connectorRedirectUri(env: Record<string, unknown>, id: string, origin: string): string {
  const definition = connectorDefinition(env, id);
  const { name } = definition;
  const canonicalOrigin = appOrigin(env, origin);
  const configured = connectorSetting(env, id, 'REDIRECT_URI', definition.redirectUri);
  const fallback = `${canonicalOrigin}/oauth/callback/${id}`;
  if (!configured) return fallback;
  let redirect: URL;
  try { redirect = new URL(configured); }
  catch { throw new AppError('connector_configuration_invalid', `${name} callback address must match this application.`, 503); }
  const allowedPath = redirect.pathname === `/oauth/callback/${id}` || redirect.pathname === definition.legacyCallbackPath;
  if (redirect.origin !== canonicalOrigin || !['http:', 'https:'].includes(redirect.protocol) || !allowedPath || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new AppError('connector_configuration_invalid', `${name} callback address must match this application.`, 503);
  }
  // OAuth registrations compare exact strings, including explicit default ports.
  return configured;
}
export function appOrigin(env: Record<string, unknown>, requestUrl: string): string {
  const configured = setting(env, 'APP_ORIGIN');
  if (configured) return new URL(configured).origin;
  if (setting(env, 'APP_ENV') === 'production') throw new Error('APP_ORIGIN must be configured');
  return new URL(requestUrl).origin;
}
export function aiEnabled(env: Record<string, unknown>): boolean {
  return approved(env, 'AI_PROCESSING_APPROVED') && approved(env, 'AI_RETENTION_VERIFIED') && !!setting(env, 'AI_API_KEY') && !!setting(env, 'AI_MODEL');
}
export function safeHttpsUrl(value: string): URL { return new URL(httpsUrl.parse(value)); }
