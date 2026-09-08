import { pathToFileURL } from 'node:url';
import { readEnvironment } from './env';
import { appOrigin, connectorConfig, connectorRedirectUri } from '../src/server/config';
import { connectorRegistry } from '../src/server/connector-registry';
import { discoverConnector } from '../src/connectors/transport';
import { AppError } from '../src/server/http';

export type ConnectorCheck = { id: string; name: string; ok: boolean; message: string };

/** Public discovery only: no member sign-in, code exchange, tokens, or records. */
export async function checkConnectors(env: Record<string, unknown>): Promise<ConnectorCheck[]> {
  const definitions = connectorRegistry(env);
  const results: ConnectorCheck[] = new Array(definitions.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < definitions.length) {
      const index = next++;
      const definition = definitions[index];
      const { id, name } = definition;
      if (definition.enabled === false) {
        results[index] = { id, name, ok: true, message: 'disabled in the registry; discovery skipped.' };
        continue;
      }
      try {
        const config = connectorConfig(env, id);
        const redirect = connectorRedirectUri(env, id, appOrigin(env, 'http://127.0.0.1:5173'));
        if (!config.enabled) throw new AppError('connector_not_configured', config.unavailableReason ?? 'Connection is unavailable.');
        const discovered = await discoverConnector(env, id);
        results[index] = { id, name, ok: true, message: `ready to start sign-in\n  FHIR: ${config.base}\n  Callback: ${redirect}\n  Token authentication: ${config.tokenAuthMethod}\n  Authorization: ${discovered.authorizationUrl}\n  Token endpoint: ${discovered.tokenUrl}${config.authorizationUrl ? '\n  Using configured endpoints; availability is checked at sign-in.' : '\n  SMART discovery succeeded.'}` };
      } catch (error) {
        // Configuration/discovery AppErrors contain safe actionable messages. Never echo raw errors.
        results[index] = { id, name, ok: false, message: error instanceof AppError ? error.message : 'Check the connection configuration.' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, definitions.length) }, () => worker()));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await checkConnectors(await readEnvironment());
    for (const result of results) {
      const output = `${result.name} (${result.id}): ${result.message}\n`;
      if (result.ok) process.stdout.write(output);
      else { process.exitCode = 1; process.stderr.write(output); }
    }
    process.stdout.write('This check does not verify registration approval or a member import.\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof AppError ? error.message : 'Check the connector registry configuration.'}\n`);
  }
}
