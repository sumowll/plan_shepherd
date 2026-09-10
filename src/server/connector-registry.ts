import { z } from 'zod';
import definitions from '../../config/connectors.json';
import { connectorApiTypeSchema, connectorIdSchema, connectorKeySchema, grantedScopeFormatSchema, importResourceSchema } from '../shared/connectors';
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
  key: connectorKeySchema.optional(),
  organizationId: connectorKeySchema,
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['provider', 'payer']),
  apiType: connectorApiTypeSchema,
  grantedScopeFormat: grantedScopeFormatSchema.default('smart'),
  enabled: z.boolean().default(true),
  fhirBaseUrl: z.string().max(2000).optional(),
  authorizationUrl: z.string().max(2000).optional(),
  tokenUrl: z.string().max(2000).optional(),
  clientId: z.string().max(2000).optional(),
  clientIdEnv: credentialBinding.optional(),
  clientSecretEnv: credentialBinding.optional(),
  clientSecretAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  tokenAuthMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']).optional(),
  scopes: z.string().max(4000).optional(),
  responseMode: z.enum(['query', 'form_post']).optional(),
  redirectUri: z.string().max(2000).optional(),
  callbackPath: z.string().max(200).regex(/^\/(?:oauth\/callback\/[a-z0-9-]+|auth\/callback(?:\/[a-z0-9-]+)?)$/).optional(),
  resources: z.array(importResourceSchema).min(1).max(6).refine(values => values[0] === 'Patient' && new Set(values).size === values.length).optional(),
  testEnvironment: z.boolean().default(false),
  testFhirBaseUrls: z.array(z.string().max(2000)).max(20).default([]),
  // The one historical alias remains data in the registry, with unique ownership.
  legacyCallbackPath: z.literal('/auth/callback').optional(),
}).strict();
// Compiled definitions always have a routing key, even when omitted in JSON.
export type ConnectorDefinition = z.infer<typeof definitionSchema> & { key: string };
type Registry = { entries: readonly ConnectorDefinition[]; byId: ReadonlyMap<string, ConnectorDefinition>; byKey: ReadonlyMap<string, ConnectorDefinition> };

function invalidRegistry(): never {
  // Never surface raw validation issues: an invalid registry may contain a secret
  // mistakenly pasted into a field, or an unexpected clientSecret property.
  throw new AppError('connector_registry_invalid', 'Connection registry settings need attention.', 503);
}
function compileRegistry(input: unknown): Registry {
  const parsed = z.array(definitionSchema).max(10000).safeParse(input);
  if (!parsed.success) return invalidRegistry();
  const byId = new Map<string, ConnectorDefinition>();
  const byKey = new Map<string, ConnectorDefinition>();
  const aliases = new Set<string>();
  const secretKeys = new Set<string>();
  const publicKeys = new Set<string>();
  for (const entry of parsed.data) {
    const key = entry.key ?? `${entry.organizationId}-${entry.apiType.replaceAll('_', '-')}`;
    if (!connectorKeySchema.safeParse(key).success || byId.has(entry.id) || byKey.has(key) || entry.legacyCallbackPath && aliases.has(entry.legacyCallbackPath)) return invalidRegistry();
    if (entry.clientId !== undefined && entry.clientIdEnv !== undefined) return invalidRegistry();
    if (entry.redirectUri !== undefined && entry.callbackPath !== undefined) return invalidRegistry();
    // Resolve once so runtime lookup, deployment bindings and collision checks
    // all use the same client registration. Explicit literals skip env lookup.
    const clientIdEnv = entry.clientId === undefined
      ? entry.clientIdEnv ?? `${entry.organizationId}_${entry.apiType}_CLIENT_ID`.replaceAll('-', '_').toUpperCase()
      : undefined;
    if (clientIdEnv !== undefined && !credentialBinding.safeParse(clientIdEnv).success) return invalidRegistry();
    if (entry.legacyCallbackPath) aliases.add(entry.legacyCallbackPath);
    if (entry.clientSecretEnv) secretKeys.add(entry.clientSecretEnv);
    if (clientIdEnv) publicKeys.add(clientIdEnv);
    const definition = Object.freeze({ ...entry, key, clientIdEnv,
      resources: entry.resources ? Object.freeze([...entry.resources]) as typeof entry.resources : undefined,
      testFhirBaseUrls: Object.freeze([...entry.testFhirBaseUrls]) as typeof entry.testFhirBaseUrls,
    });
    byId.set(entry.id, definition);
    byKey.set(key, definition);
  }
  if ([...publicKeys].some(key => secretKeys.has(key))) return invalidRegistry();
  return { entries: Object.freeze([...byId.values()]), byId, byKey };
}

// Only server modules import this file. A large registry is bundled once and
// indexed once; it is not duplicated in Worker bindings or frontend assets.
const bundled = compileRegistry(definitions);
const injectedRegistry = Symbol('connector registry');
type RegistryEnvironment = Record<string, unknown> & { [injectedRegistry]?: Registry };

// Programmatic dependency injection for validation and tests. The symbol is
// copied with the environment but cannot be supplied by an environment variable.
export function withConnectorRegistry<T extends Record<string, unknown>>(env: T, input: unknown): T {
  return Object.assign({}, env, { [injectedRegistry]: compileRegistry(input) });
}
export function validateConnectorRegistry(input: unknown): readonly ConnectorDefinition[] {
  return compileRegistry(input).entries;
}
function registry(env: Record<string, unknown>): Registry {
  if (env.CONNECTOR_REGISTRY !== undefined) return invalidRegistry();
  return (env as RegistryEnvironment)[injectedRegistry] ?? bundled;
}
export function connectorRegistry(env: Record<string, unknown>): readonly ConnectorDefinition[] { return registry(env).entries; }
export function connectorDefinition(env: Record<string, unknown>, identifier: string): ConnectorDefinition {
  const id = connectorIdSchema.safeParse(identifier);
  const definition = id.success ? registry(env).byId.get(id.data)
    : connectorKeySchema.safeParse(identifier).success ? registry(env).byKey.get(identifier) : undefined;
  if (!definition) throw new AppError('connector_not_found', 'This connection is not registered.', 404);
  return definition;
}
export function connectorEnvironmentKeys(env: Record<string, unknown>): { runtimeKeys: string[]; secretKeys: string[] } {
  const runtime = new Set<string>(); const secrets = new Set<string>();
  for (const definition of connectorRegistry(env)) {
    if (definition.clientIdEnv) runtime.add(definition.clientIdEnv);
    if (definition.clientSecretEnv) { runtime.add(definition.clientSecretEnv); secrets.add(definition.clientSecretEnv); }
  }
  return { runtimeKeys: [...runtime], secretKeys: [...secrets] };
}
