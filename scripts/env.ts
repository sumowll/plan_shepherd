import { readFile } from 'node:fs/promises';
import { connectorEnvironmentKeys } from '../src/server/connector-registry';
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new Error('Invalid environment file line. Use KEY=value; multiline values are not supported.');
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value) as string; } catch { throw new Error(`Invalid quoted value for ${match[1]}`); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (/[\r\n\0]/.test(value)) throw new Error(`Multiline or null value for ${match[1]} is not allowed`);
    values[match[1]] = value;
  }
  return values;
}
export async function readEnvironment(path = '.env'): Promise<Record<string, string>> {
  let file: Record<string, string> = {};
  try { file = parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
}
export const RUNTIME_KEYS = ['APP_ENV','APP_ORIGIN','PLAN_YEAR','PATIENT_PROCESSING_APPROVED','AI_PROCESSING_APPROVED','AI_RETENTION_VERIFIED','SESSION_SIGNING_KEY','CONNECTOR_REGISTRY','AI_BASE_URL','AI_API_KEY','AI_MODEL','PRODUCTION_RELEASE_APPROVED','PRODUCTION_CATALOG_RELEASE_ID'] as const;

/** Registry references extend the binding allowlist; unrelated shell secrets stay tooling-only. */
export function runtimeEnvironmentKeys(env: Record<string, unknown>): { runtimeKeys: string[]; secretKeys: string[] } {
  if (typeof env.CONNECTOR_REGISTRY === 'string' && Buffer.byteLength(env.CONNECTOR_REGISTRY, 'utf8') > 5120) {
    throw new Error('CONNECTOR_REGISTRY exceeds the Worker variable size limit. Put large registries in config/connectors.json and remove the environment override.');
  }
  const connectorKeys = connectorEnvironmentKeys(env);
  return {
    runtimeKeys: [...new Set([...RUNTIME_KEYS, ...connectorKeys.runtimeKeys, ...connectorKeys.secretKeys])],
    secretKeys: [...new Set(['AI_API_KEY', 'SESSION_SIGNING_KEY', ...connectorKeys.secretKeys])],
  };
}
