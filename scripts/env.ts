import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectorEnvironmentKeys, withConnectorRegistry } from '../src/server/connector-registry';
import type { ConnectorTarget } from './connector-credentials';
import { parseEnv } from './dotenv';
export { parseEnv } from './dotenv';

export function rejectExternalConnectorMetadata(env: Record<string, unknown>): void {
  if (Object.keys(env).some(name => name === 'CONNECTOR_REGISTRY'
    || /_(?:SCOPES|FHIR_BASE_URL|AUTHORIZATION_URL|TOKEN_URL|REDIRECT_URI|TOKEN_AUTH_METHOD|RESPONSE_MODE)$/.test(name))) {
    throw new Error('Connection metadata must be managed in config/connectors.json through the connector setup command.');
  }
}
export interface ReadEnvironmentOptions {
  secretsFile?: string;
  registry?: unknown;
  target?: ConnectorTarget;
  environment?: Record<string, string | undefined>;
}
export async function readEnvironment(path = '.env', options: ReadEnvironmentOptions = {}): Promise<Record<string, string>> {
  let file: Record<string, string> = {};
  const target = options.target ?? 'development';
  const localPath = target === 'development' ? options.secretsFile ?? path : path;
  try { file = parseEnv(await readFile(localPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || target === 'development' && options.secretsFile) throw error; }
  const env = options.registry === undefined ? {} : withConnectorRegistry({}, options.registry);
  const shell = Object.fromEntries(Object.entries(options.environment ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  rejectExternalConnectorMetadata(file);
  rejectExternalConnectorMetadata(shell);
  if (target !== 'development') {
    // Readiness/catalog tools retain local application settings, never development connection credentials.
    const connectionKeys = new Set(connectorEnvironmentKeys(env).runtimeKeys);
    file = Object.fromEntries(Object.entries(file).filter(([key]) => !connectionKeys.has(key) && !/_CLIENT_(?:ID|SECRET)$/.test(key)));
    let selected: Record<string, string> = {};
    try { selected = parseEnv(await readFile(options.secretsFile ?? join(dirname(path), `.env.secrets.${target}`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.secretsFile) throw new Error('Cannot load the selected secrets file.'); }
    rejectExternalConnectorMetadata(selected);
    file = { ...file, ...selected };
  }
  return { ...env, ...file, ...shell };
}
export const RUNTIME_KEYS = ['APP_ENV','APP_ORIGIN','PLAN_YEAR','PATIENT_PROCESSING_APPROVED','AI_PROCESSING_APPROVED','AI_RETENTION_VERIFIED','SESSION_SIGNING_KEY','AI_BASE_URL','AI_API_KEY','AI_MODEL','PRODUCTION_RELEASE_APPROVED','PRODUCTION_CATALOG_RELEASE_ID'] as const;

/** Registry references extend the binding allowlist; unrelated shell secrets stay tooling-only. */
export function runtimeEnvironmentKeys(env: Record<string, unknown>): { runtimeKeys: string[]; secretKeys: string[] } {
  if (env.CONNECTOR_REGISTRY !== undefined) throw new Error('Connection definitions must come from config/connectors.json; remove CONNECTOR_REGISTRY.');
  const connectorKeys = connectorEnvironmentKeys(env);
  return {
    runtimeKeys: [...new Set([...RUNTIME_KEYS, ...connectorKeys.runtimeKeys, ...connectorKeys.secretKeys])],
    secretKeys: [...new Set(['AI_API_KEY', 'SESSION_SIGNING_KEY', ...connectorKeys.secretKeys])],
  };
}
