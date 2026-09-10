import { connectorRegistry, withConnectorRegistry } from '../../src/server/connector-registry';

/** Patch reviewed connection metadata explicitly without creating environment overrides. */
export function withBundledConnections<T extends Record<string, unknown>>(
  env: T,
  patches: Record<string, Record<string, unknown>> = {},
): T {
  return withConnectorRegistry(env, connectorRegistry(env).map(definition => ({ ...definition, ...patches[definition.organizationId] })));
}
