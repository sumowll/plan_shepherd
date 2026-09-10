import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { parseEnv, rejectExternalConnectorMetadata, runtimeEnvironmentKeys } from './env';
import { projectRoot } from './deployment';
import { connectorConfig, connectorRedirectUri, safeHttpsUrl } from '../src/server/config';
import { connectorEnvironmentKeys, connectorRegistry, withConnectorRegistry } from '../src/server/connector-registry';

export type DeploymentTarget = 'preview' | 'production';
export type DeploymentOptions = {
  target: DeploymentTarget;
  configPath?: string;
  secretsFile?: string;
  dryRun: boolean;
  uploadOnly: boolean;
  skipBuild: boolean;
};

export function parseDeploymentOptions(args: string[]): DeploymentOptions {
  const options: DeploymentOptions = { target: 'production', dryRun: false, uploadOnly: false, skipBuild: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error('Deployment options must not be repeated.');
    seen.add(arg);
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--upload-only') options.uploadOnly = true;
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--target' || arg === '--config' || arg === '--secrets-file') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--target') {
        if (value !== 'preview' && value !== 'production') throw new Error('Deployment target must be preview or production.');
        options.target = value;
      } else if (arg === '--config') options.configPath = value;
      else options.secretsFile = value;
    } else throw new Error('Unknown deployment option. Run npm run deploy -- --help.');
  }
  if (options.target === 'production' && (options.uploadOnly || options.skipBuild)) {
    throw new Error('Production requires a complete validated build and deployment; --upload-only and --skip-build are preview-only.');
  }
  return options;
}

const configSchema = z.looseObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  account_id: z.string().regex(/^[a-f\d]{32}$/i),
  main: z.string().min(1),
  assets: z.looseObject({ directory: z.string().min(1) }),
  vars: z.record(z.string(), z.string()),
  d1_databases: z.array(z.looseObject({ binding: z.string(), database_id: z.string(), migrations_dir: z.string().optional() })).optional(),
  routes: z.array(z.looseObject({ pattern: z.string(), custom_domain: z.boolean().optional() })).optional(),
  secrets: z.object({ required: z.array(z.string()) }).optional(),
});
export type DeploymentConfig = z.infer<typeof configSchema>;
export type DeploymentSettings = {
  target: DeploymentTarget;
  config: DeploymentConfig;
  secrets: Record<string, string>;
  env: Record<string, string>;
};

export async function readJsonConfig(path: string): Promise<unknown> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch { throw new Error('Cannot read the selected Wrangler configuration.'); }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true });
  // Parser diagnostics may quote a misplaced secret. Report no file contents.
  if (errors.length) throw new Error('The selected Wrangler configuration must be valid JSON or JSONC.');
  return parsed;
}

/** Public app config comes from Wrangler; credentials come from the selected dotenv file or CI. */
export async function readDeploymentSettings(
  options: Pick<DeploymentOptions, 'target' | 'configPath' | 'secretsFile'>,
  environment: Record<string, string | undefined> = process.env,
  registry?: unknown,
): Promise<DeploymentSettings> {
  const configPath = resolve(projectRoot, options.configPath ?? `wrangler.${options.target}.jsonc`);
  const parsed = configSchema.safeParse(await readJsonConfig(configPath));
  if (!parsed.success) throw new Error('The deployment config requires a Worker name, account_id, main, assets.directory, and string vars.');
  const config = parsed.data;
  if (config.env !== undefined) throw new Error('Use a separate configuration file for each deployment target, without nested env overrides.');
  if (config.unsafe !== undefined || config.build !== undefined) throw new Error('Deployment config cannot contain unsafe overrides or custom build commands; use the shared validated build.');
  if (config.keep_vars === true) throw new Error('Remove keep_vars: the selected configuration owns deployed variables.');
  const registryEnv = registry === undefined ? {} : withConnectorRegistry({}, registry);
  rejectExternalConnectorMetadata(config.vars);
  rejectExternalConnectorMetadata(Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)));
  const { runtimeKeys, secretKeys } = runtimeEnvironmentKeys(registryEnv);
  const connectorKeys = connectorEnvironmentKeys(registryEnv);
  const connectorSecretNames = new Set(connectorKeys.secretKeys);
  const clientIdNames = new Set(connectorKeys.runtimeKeys.filter(key => !connectorSecretNames.has(key)));
  const secretNames = new Set(secretKeys);
  for (const key of Object.keys(config.vars)) {
    if (secretNames.has(key) || /_CLIENT_SECRET$/.test(key)) throw new Error(`Move ${key} out of vars and into the secrets file or CI secrets.`);
    if (!runtimeKeys.includes(key)) throw new Error('The deployment config contains an unknown runtime variable. Deployment credentials belong in the shell or CI.');
  }
  let file: Record<string, string> = {};
  try { file = parseEnv(await readFile(resolve(projectRoot, options.secretsFile ?? `.env.secrets.${options.target}`), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.secretsFile) {
      throw new Error('Cannot load the selected secrets file. Use an existing dotenv file containing only application secret keys.');
    }
  }
  rejectExternalConnectorMetadata(file);
  if (Object.keys(file).some(key => !secretNames.has(key) && !clientIdNames.has(key)
    && (runtimeKeys.includes(key) || key.startsWith('CLOUDFLARE_') || ['PRODUCTION_READINESS_FILE', 'CATALOG_DATABASE_ID'].includes(key)))) {
    throw new Error('The secrets file contains an unknown or non-secret key. Use application secrets and connector credentials; keep public application settings in Wrangler and deployment credentials in the shell or CI.');
  }
  // Unreferenced entries (including retired custom bindings) stay saved but are never uploaded.
  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = environment[key] ?? file[key];
    if (value !== undefined) secrets[key] = value;
  }
  for (const key of clientIdNames) {
    const value = environment[key] ?? file[key];
    if (value !== undefined) config.vars[key] = value;
  }
  const env: Record<string, string> = { ...registryEnv, ...config.vars, ...secrets, CLOUDFLARE_ACCOUNT_ID: config.account_id, CLOUDFLARE_WORKER_NAME: config.name };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'PRODUCTION_READINESS_FILE']) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  const database = config.d1_databases?.find(binding => binding.binding === 'CATALOG');
  if (database) env.CATALOG_DATABASE_ID = database.database_id;
  config.main = resolve(dirname(configPath), config.main);
  config.assets.directory = resolve(dirname(configPath), config.assets.directory);
  for (const binding of config.d1_databases ?? []) {
    if (binding.migrations_dir) binding.migrations_dir = resolve(dirname(configPath), binding.migrations_dir);
  }
  delete config.$schema;
  return { target: options.target, config, secrets, env };
}

/** Deployments always validate resolved settings; inspection can report unavailable connections. */
export async function loadDeploymentSettings(
  options: Pick<DeploymentOptions, 'target' | 'configPath' | 'secretsFile'>,
  environment: Record<string, string | undefined> = process.env,
  registry?: unknown,
): Promise<DeploymentSettings> {
  const settings = await readDeploymentSettings(options, environment, registry);
  validateDeploymentSettings(settings.target, settings.config, settings.env, settings.secrets);
  return settings;
}

function validateDeploymentSettings(target: DeploymentTarget, config: DeploymentConfig, env: Record<string, string>, secrets: Record<string, string>): void {
  let origin: URL;
  try {
    origin = safeHttpsUrl(env.APP_ORIGIN ?? '');
    if (origin.origin !== env.APP_ORIGIN) throw new Error();
  } catch { throw new Error('APP_ORIGIN must be a public HTTPS origin without a path or trailing slash.'); }
  if (env.APP_ENV !== 'production' || env.PLAN_YEAR !== '2026') throw new Error('Hosted deployments require APP_ENV=production and PLAN_YEAR=2026 in config vars.');
  for (const key of ['PATIENT_PROCESSING_APPROVED', 'AI_PROCESSING_APPROVED', 'AI_RETENTION_VERIFIED', 'PRODUCTION_RELEASE_APPROVED']) {
    if (!['true', 'false'].includes(env[key])) throw new Error(`${key} must explicitly be true or false in config vars.`);
    if (target === 'preview' && env[key] !== 'false') throw new Error(`${key} must remain false for a hosted preview. Use the production release workflow to enable processing.`);
  }
  if (env.PRODUCTION_RELEASE_APPROVED !== 'false' || env.PRODUCTION_CATALOG_RELEASE_ID !== '') {
    throw new Error('Release approval and catalog release ID are generated from verified production evidence; keep their config defaults false and empty.');
  }
  if (target === 'preview' && config.d1_databases?.length) throw new Error('Hosted previews must not attach a catalog database.');
  for (const route of config.routes ?? []) {
    if (route.custom_domain && route.pattern !== origin.hostname) throw new Error('The configured custom domain must match APP_ORIGIN.');
  }
  for (const key of config.secrets?.required ?? []) {
    if (!secrets[key]?.trim()) throw new Error(`Required secret ${key} is missing or blank.`);
  }
  for (const key of ['SESSION_SIGNING_KEY', 'AI_API_KEY']) {
    if (key in secrets && !secrets[key].trim()) throw new Error(`${key} must not be blank; omit an unchanged optional secret.`);
  }
  if (env.SESSION_SIGNING_KEY !== undefined && env.SESSION_SIGNING_KEY.trim().length < 32) throw new Error('SESSION_SIGNING_KEY must contain at least 32 characters.');
  if (env.PATIENT_PROCESSING_APPROVED === 'true' && !env.SESSION_SIGNING_KEY) throw new Error('SESSION_SIGNING_KEY is required for patient connections.');
  if (env.AI_BASE_URL) { try { safeHttpsUrl(env.AI_BASE_URL); } catch { throw new Error('AI_BASE_URL must be a public HTTPS endpoint.'); } }
  if (env.AI_PROCESSING_APPROVED === 'true' && (!env.AI_API_KEY?.trim() || !env.AI_MODEL?.trim() || env.AI_RETENTION_VERIFIED !== 'true')) {
    throw new Error('Enabled AI requires AI_API_KEY, AI_MODEL and AI_RETENTION_VERIFIED=true.');
  }
  for (const definition of connectorRegistry(env)) {
    if (!definition.enabled) continue;
    try {
      const connector = connectorConfig(env, definition.id);
      connectorRedirectUri(env, definition.id, origin.origin);
      if (target === 'production' && connector.tokenAuthMethod !== 'none' && !connector.clientSecret?.trim()) throw new Error();
      if (env.PATIENT_PROCESSING_APPROVED === 'true' && !connector.enabled) throw new Error();
    } catch { throw new Error(`${definition.key} has incomplete or invalid connector settings. Check its client ID, authentication method, secret, FHIR endpoint and callback.`); }
  }
}
