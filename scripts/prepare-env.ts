import { chmod, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readEnvironment, runtimeEnvironmentKeys } from './env';
export async function prepareEnvironment(env: Record<string, string>, path = '.dev.vars'): Promise<void> {
  const keys = runtimeEnvironmentKeys(env).runtimeKeys.filter(key => env[key] !== undefined);
  if (!keys.length) return;
  await writeFile(path, keys.map(key => `${key}=${JSON.stringify(env[key])}`).join('\n') + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  process.stdout.write(`Prepared local Worker settings (${keys.length} values; credentials hidden).\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareEnvironment(await readEnvironment());
