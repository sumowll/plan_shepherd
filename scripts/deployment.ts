import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RUNTIME_KEYS } from './env';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const SECRET_KEYS = new Set(['AI_API_KEY', 'SESSION_SIGNING_KEY']);
export function deploymentEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env, WRANGLER_LOG_PATH: join(projectRoot, '.cache/wrangler'), WRANGLER_SEND_METRICS: 'false' };
}
export function runWrangler(args: string[], env: Record<string, string>): void {
  const result = spawnSync(process.execPath, [join(projectRoot, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: projectRoot, env: deploymentEnvironment(env), stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Wrangler did not complete. Review its diagnostic output; no credentials were printed by this script.');
}
/** A private temporary configuration resolves paths explicitly and is removed even on failure. */
export async function withProductionConfig<T>(env: Record<string, string>, action: (configPath: string, secretsPath: string) => Promise<T>, options: { built?: boolean; approvedReleaseId?: string } = {}): Promise<T> {
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('A valid CLOUDFLARE_ACCOUNT_ID is required.');
  if (!/^[a-f\d-]{36}$/i.test(env.CATALOG_DATABASE_ID ?? '') || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(env.CATALOG_DATABASE_ID)) throw new Error('A provisioned CATALOG_DATABASE_ID is required.');
  const source = options.built ? join(projectRoot, 'dist/plan_shepherd/wrangler.json') : join(projectRoot, 'wrangler.jsonc');
  const config = JSON.parse(await readFile(source, 'utf8'));
  delete config.$schema; delete config.configPath; delete config.userConfigPath;
  config.main = resolve(dirname(source), config.main);
  config.assets.directory = resolve(dirname(source), config.assets.directory);
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  config.name = env.CLOUDFLARE_WORKER_NAME || 'plan-shepherd';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name)) throw new Error('Invalid CLOUDFLARE_WORKER_NAME.');
  config.d1_databases = [{ binding: 'CATALOG', database_name: 'plan-shepherd-catalog', database_id: env.CATALOG_DATABASE_ID, migrations_dir: join(projectRoot, 'migrations') }];
  config.vars = Object.fromEntries(RUNTIME_KEYS.filter(key => !SECRET_KEYS.has(key) && !key.startsWith('PRODUCTION_') && env[key] !== undefined).map(key => [key, env[key]]));
  config.vars.APP_ENV = 'production'; config.vars.PLAN_YEAR = '2026';
  config.vars.PRODUCTION_RELEASE_APPROVED = options.approvedReleaseId ? 'true' : 'false';
  config.vars.PRODUCTION_CATALOG_RELEASE_ID = options.approvedReleaseId ?? '';
  config.observability = { enabled: false, logs: { enabled: false }, traces: { enabled: false } };
  config.logpush = false; config.preview_urls = false;
  if (env.CLOUDFLARE_CUSTOM_DOMAIN === 'true') {
    const origin = new URL(env.APP_ORIGIN);
    config.routes = [{ pattern: origin.hostname, custom_domain: true }]; config.workers_dev = false;
  } else { config.routes = []; config.workers_dev = true; }
  const cache = join(projectRoot, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'deployment-'));
  try {
    const configPath = join(directory, 'wrangler.json'); const secretsPath = join(directory, 'secrets.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(secretsPath, JSON.stringify(Object.fromEntries([...SECRET_KEYS].filter(key => !!env[key]).map(key => [key, env[key]]))), { mode: 0o600 });
    return await action(configPath, secretsPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
