import { z } from 'zod';

export type RuntimeEnv = Cloudflare.Env & Record<string, unknown>;
export type ConnectorId = 'atrius' | 'cigna';
const httpsUrl = z.string().url().refine(value => {
  const u = new URL(value);
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
export function connectorConfig(env: Record<string, unknown>, id: ConnectorId) {
  const prefix = id.toUpperCase();
  const base = setting(env, `${prefix}_FHIR_BASE_URL`, id === 'atrius' ? 'https://iatrius.atriushealth.org/FHIR/api/FHIR/R4' : '').replace(/\/$/, '');
  const clientId = setting(env, `${prefix}_CLIENT_ID`);
  const authorizationUrl = setting(env, `${prefix}_AUTHORIZATION_URL`);
  const tokenUrl = setting(env, `${prefix}_TOKEN_URL`);
  const scopes = setting(env, `${prefix}_SCOPES`, 'launch/patient patient/*.read');
  if (!scopes.split(/\s+/).every(s => s === 'launch/patient' || /^patient\/(?:\*|[A-Za-z]+)\.(?:read|rs|r|s)$/.test(s))) throw new Error('Only patient read scopes and launch/patient are supported');
  return {
    id, name: id === 'atrius' ? 'Atrius Health' : 'Cigna', base, clientId, scopes,
    configured: !!clientId && httpsUrl.safeParse(base).success,
    enabled: !!clientId && httpsUrl.safeParse(base).success && approved(env, 'PATIENT_PROCESSING_APPROVED') && setting(env, 'SESSION_SIGNING_KEY').length >= 32,
    authorizationUrl: authorizationUrl ? httpsUrl.parse(authorizationUrl) : '',
    tokenUrl: tokenUrl ? httpsUrl.parse(tokenUrl) : '',
    responseMode: setting(env, `${prefix}_RESPONSE_MODE`) === 'form_post' ? 'form_post' as const : 'query' as const,
  };
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
