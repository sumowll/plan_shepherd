import { pathToFileURL } from 'node:url';
import { readEnvironment, type ReadEnvironmentOptions } from './env';
import { loadDeploymentSettings } from './deploy-settings';
import { appOrigin, connectorConfig, connectorRedirectUri } from '../src/server/config';
import { connectorRegistry } from '../src/server/connector-registry';
import { discoverConnector } from '../src/connectors/transport';
import { AppError } from '../src/server/http';
import type { ConnectorApiType } from '../src/shared/connectors';

export type ConnectorCheck = { id: string; key: string; organizationId: string; name: string; apiType: ConnectorApiType; ok: boolean; message: string };
export function parseConnectorCheckOptions(args: string[]): ReadEnvironmentOptions {
  const options: ReadEnvironmentOptions = { target: 'development' };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[++index];
    if (seen.has(arg) || !value || value.startsWith('--')) throw new Error('Invalid connector check options.');
    seen.add(arg);
    if (arg === '--target' && ['development', 'preview', 'production'].includes(value)) options.target = value as ReadEnvironmentOptions['target'];
    else if (arg === '--secrets-file') options.secretsFile = value;
    else throw new Error('Use --target development|preview|production and optionally --secrets-file path.');
  }
  if (options.secretsFile && !seen.has('--target')) throw new Error('--secrets-file requires an explicit --target.');
  return options;
}

/** Public discovery only: no member sign-in, code exchange, tokens, or records. */
export async function checkConnectors(env: Record<string, unknown>): Promise<ConnectorCheck[]> {
  const definitions = connectorRegistry(env);
  const results: ConnectorCheck[] = new Array(definitions.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < definitions.length) {
      const index = next++;
      const definition = definitions[index];
      const { id, key, organizationId, name, apiType } = definition;
      if (definition.enabled === false) {
        results[index] = { id, key, organizationId, name, apiType, ok: true, message: 'disabled in the registry; discovery skipped.' };
        continue;
      }
      try {
        const config = connectorConfig(env, id);
        const redirect = connectorRedirectUri(env, id, appOrigin(env, 'http://127.0.0.1:5173'));
        if (!config.enabled) throw new AppError('connector_not_configured', config.unavailableReason ?? 'Connection is unavailable.');
        const discovered = await discoverConnector(env, id);
        results[index] = { id, key, organizationId, name, apiType, ok: true, message: `ready to start sign-in\n  FHIR: ${config.base}\n  Callback: ${redirect}\n  Token authentication: ${config.tokenAuthMethod}\n  Authorization: ${discovered.authorizationUrl}\n  Token endpoint: ${discovered.tokenUrl}${config.authorizationUrl ? '\n  Using configured endpoints; availability is checked at sign-in.' : '\n  SMART discovery succeeded.'}` };
      } catch (error) {
        // Configuration/discovery AppErrors contain safe actionable messages. Never echo raw errors.
        results[index] = { id, key, organizationId, name, apiType, ok: false, message: error instanceof AppError ? error.message : 'Check the connection configuration.' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, definitions.length) }, () => worker()));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseConnectorCheckOptions(process.argv.slice(2));
    const env = options.target === 'preview' || options.target === 'production'
      ? (await loadDeploymentSettings({ target: options.target, secretsFile: options.secretsFile })).env
      : await readEnvironment('.env', options);
    const results = await checkConnectors(env);
    for (const result of results) {
      const output = `${result.name} (${result.key}, ${result.apiType})\n  Connection: ${result.id}\n  Organization: ${result.organizationId}\n  ${result.message}\n`;
      if (result.ok) process.stdout.write(output);
      else { process.exitCode = 1; process.stderr.write(output); }
    }
    process.stdout.write('This check does not verify registration approval or a member import.\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof AppError ? error.message : 'Check the connector registry configuration.'}\n`);
  }
}
