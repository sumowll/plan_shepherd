import { connectorDefinition } from '../../src/server/connector-registry';

/** Stable synthetic UUIDs make fixtures independent of connection names and keys. */
export function connectionIdentity(key: string, index = 1, organizationId = key) {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    key,
    organizationId,
    apiType: 'patient_access' as const,
  };
}

export function bundledConnectionId(key: string): string {
  return connectorDefinition({}, key).id;
}
