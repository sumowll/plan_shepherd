import { z } from 'zod';
import definitions from '../../config/connectors.json';
import { connectorIdSchema, importResourceSchema } from '../shared/connectors';
import { AppError } from './http';

const bindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const applicationBindings = new Set([
  'APP_ENV', 'APP_ORIGIN', 'PLAN_YEAR', 'PATIENT_PROCESSING_APPROVED', 'AI_PROCESSING_APPROVED', 'AI_RETENTION_VERIFIED',
  'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'SESSION_SIGNING_KEY', 'SHORT_TERM_FEED_TOKEN',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'CLOUDFLARE_CUSTOM_DOMAIN',
  'CATALOG', 'CATALOG_DATABASE_ID', 'ASSETS', 'API_RATE_LIMITER', 'CONNECTOR_REGISTRY',
  'PRODUCTION_RELEASE_APPROVED', 'PRODUCTION_CATALOG_RELEASE_ID', 'PRODUCTION_READINESS_FILE',
]);
const credentialBinding = bindingName.refine(value => !applicationBindings.has(value));
const definitionSchema = z.object({
  id: connectorIdSchema,
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['provider', 'payer']),
  scopeProfile: z.enum(['smart', 'epic', 'cigna']).default('smart'),
  enabled: z.boolean().default(true),
  fhirBaseUrl: z.string().max(2000).optional(),
  authorizationUrl: z.string().max(2000).optional(),
  tokenUrl: z.string().max(2000).optional(),
  clientId: z.string().max(2000).optional(),
  clientIdEnv: credentialBinding.optional(),
  clientSecretEnv: credentialBinding.optional(),
  tokenAuthMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']).optional(),
  scopes: z.string().max(4000).optional(),
  responseMode: z.enum(['query', 'form_post']).optional(),
  redirectUri: z.string().max(2000).optional(),
  resources: z.array(importResourceSchema).min(1).max(6).refine(values => values[0] === 'Patient' && new Set(values).size === values.length).optional(),
  testEnvironment: z.boolean().default(false),
  testFhirBaseUrls: z.array(z.string().max(2000)).max(20).default([]),
  legacyEnvPrefixes: z.array(bindingName).max(3).default([]),
  // The one historical alias remains data in the registry, with unique ownership.
  legacyCallbackPath: z.literal('/auth/callback').optional(),
}).strict();
export type ConnectorDefinition = z.infer<typeof definitionSchema>;
export const CONNECTOR_SETTING_NAMES = ['CLIENT_ID', 'CLIENT_SECRET', 'TOKEN_AUTH_METHOD', 'REDIRECT_URI', 'FHIR_BASE_URL', 'AUTHORIZATION_URL', 'TOKEN_URL', 'SCOPES', 'RESPONSE_MODE'] as const;
type Registry = { entries: readonly ConnectorDefinition[]; byId: ReadonlyMap<string, ConnectorDefinition> };

function invalidRegistry(): never {
  // Never surface raw validation issues: an invalid registry may contain a secret
  // mistakenly pasted into a field, or an unexpected clientSecret property.
  throw new AppError('connector_registry_invalid', 'Connection registry settings need attention.', 503);
}
function compileRegistry(input: unknown): Registry {
  const parsed = z.array(definitionSchema).max(10000).safeParse(input);
  if (!parsed.success) return invalidRegistry();
  const byId = new Map<string, ConnectorDefinition>();
  const aliases = new Set<string>();
  const secretKeys = new Set(['ATRIUS_CLIENT_SECRET', 'EPIC_CLIENT_SECRET', 'CIGNA_CLIENT_SECRET']);
  const publicKeys = new Set<string>();
  for (const entry of parsed.data) {
    if (byId.has(entry.id) || entry.legacyCallbackPath && aliases.has(entry.legacyCallbackPath)) return invalidRegistry();
    if (entry.clientId !== undefined && entry.clientIdEnv !== undefined) return invalidRegistry();
    if (entry.legacyCallbackPath) aliases.add(entry.legacyCallbackPath);
    if (entry.clientSecretEnv) secretKeys.add(entry.clientSecretEnv);
    if (entry.clientIdEnv) publicKeys.add(entry.clientIdEnv);
    for (const prefix of entry.legacyEnvPrefixes) for (const suffix of CONNECTOR_SETTING_NAMES) {
      (suffix === 'CLIENT_SECRET' ? secretKeys : publicKeys).add(`${prefix}_${suffix}`);
    }
    byId.set(entry.id, Object.freeze({ ...entry,
      resources: entry.resources ? Object.freeze([...entry.resources]) as typeof entry.resources : undefined,
      legacyEnvPrefixes: Object.freeze([...entry.legacyEnvPrefixes]) as typeof entry.legacyEnvPrefixes,
      testFhirBaseUrls: Object.freeze([...entry.testFhirBaseUrls]) as typeof entry.testFhirBaseUrls,
    }));
  }
  if ([...publicKeys].some(key => secretKeys.has(key))) return invalidRegistry();
  return { entries: Object.freeze([...byId.values()]), byId };
}

// Only server modules import this file. A large registry is bundled once and
// indexed once; it is not duplicated in Worker bindings or frontend assets.
const bundled = compileRegistry(definitions);
let overrideCache: { source: string; registry: Registry } | undefined;
const objectOverrides = new WeakMap<object, Registry>();
function registry(env: Record<string, unknown>): Registry {
  const source = env.CONNECTOR_REGISTRY;
  if (source === undefined) return bundled;
  if (typeof source === 'string') {
    if (overrideCache?.source === source) return overrideCache.registry;
    let input: unknown;
    try { input = JSON.parse(source); } catch { return invalidRegistry(); }
    const compiled = compileRegistry(input);
    // Immutable configuration only; no credentials, tokens, or request state.
    overrideCache = { source, registry: compiled };
    return compiled;
  }
  if (typeof source !== 'object' || source === null) return invalidRegistry();
  const cached = objectOverrides.get(source);
  if (cached) return cached;
  const compiled = compileRegistry(source);
  // Bindings are immutable configuration snapshots. Replace the input object
  // when changing it; weak keys allow old snapshots to be collected.
  objectOverrides.set(source, compiled);
  return compiled;
}
export function connectorRegistry(env: Record<string, unknown>): readonly ConnectorDefinition[] { return registry(env).entries; }
export function connectorDefinition(env: Record<string, unknown>, id: string): ConnectorDefinition {
  const definition = connectorIdSchema.safeParse(id).success ? registry(env).byId.get(id) : undefined;
  if (!definition) throw new AppError('connector_not_found', 'This connection is not registered.', 404);
  return definition;
}
export function connectorEnvironmentKeys(env: Record<string, unknown>): { runtimeKeys: string[]; secretKeys: string[] } {
  const runtime = new Set<string>(); const secrets = new Set<string>();
  for (const definition of connectorRegistry(env)) {
    if (definition.clientIdEnv) runtime.add(definition.clientIdEnv);
    if (definition.clientSecretEnv) { runtime.add(definition.clientSecretEnv); secrets.add(definition.clientSecretEnv); }
    for (const prefix of definition.legacyEnvPrefixes) for (const suffix of CONNECTOR_SETTING_NAMES) {
      runtime.add(`${prefix}_${suffix}`);
      if (suffix === 'CLIENT_SECRET') secrets.add(`${prefix}_${suffix}`);
    }
  }
  return { runtimeKeys: [...runtime], secretKeys: [...secrets] };
}
