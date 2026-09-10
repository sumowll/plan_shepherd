import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeploymentSettings, parseDeploymentOptions, readDeploymentSettings } from '../../scripts/deploy-settings';
import { connectionIdentity } from '../helpers/connection-identity';
import { connectorConfig } from '../../src/server/config';

const directories: string[] = [];
const origin = 'https://app.example.com';
const signingKey = 'synthetic-session-signing-key-for-tests';
const publicVars = {
  APP_ENV: 'production', APP_ORIGIN: origin, PLAN_YEAR: '2026',
  PATIENT_PROCESSING_APPROVED: 'false', AI_PROCESSING_APPROVED: 'false',
  AI_RETENTION_VERIFIED: 'false', PRODUCTION_RELEASE_APPROVED: 'false',
  PRODUCTION_CATALOG_RELEASE_ID: '',
};

async function fixture(configOverrides: Record<string, unknown> = {}, secretText = '', registry: unknown = []) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-deploy-settings-'));
  directories.push(directory);
  const configPath = join(directory, 'wrangler.preview.jsonc');
  const secretsFile = join(directory, '.env.secrets.preview');
  const config = {
    name: 'synthetic-preview', account_id: '1'.repeat(32), main: './worker.js',
    assets: { directory: './assets' }, vars: { ...publicVars },
    routes: [{ pattern: 'app.example.com', custom_domain: true }],
    ...configOverrides,
  };
  await writeFile(configPath, `// Synthetic configuration; JSONC comments are supported.\n${JSON.stringify(config)}`);
  await writeFile(secretsFile, secretText, { mode: 0o600 });
  return { directory, configPath, secretsFile,
    load: (environment: Record<string, string | undefined> = {}) => loadDeploymentSettings({ target: 'preview', configPath, secretsFile }, environment, registry),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('deployment configuration sources', () => {
  it('keeps public config authoritative despite shell overrides and adjacent local dotenv files', async () => {
    const setup = await fixture();
    await writeFile(join(setup.directory, '.env'), 'APP_ORIGIN=http://localhost:3000\nSESSION_SIGNING_KEY=local-only-secret\n');
    const settings = await setup.load({
      APP_ORIGIN: 'http://localhost:3000', APP_ENV: 'development',
      PATIENT_PROCESSING_APPROVED: 'true', CLOUDFLARE_ACCOUNT_ID: '2'.repeat(32),
      CLOUDFLARE_WORKER_NAME: 'wrong-worker',
    });
    expect(settings.config.vars).toEqual(publicVars);
    expect(settings.config.name).toBe('synthetic-preview');
    expect(settings.env.CLOUDFLARE_ACCOUNT_ID).toBe('1'.repeat(32));
    expect(settings.env.CLOUDFLARE_WORKER_NAME).toBe('synthetic-preview');
    expect(settings.secrets).toEqual({});
    expect(settings.config.main).toBe(join(setup.directory, 'worker.js'));
    expect(settings.config.assets.directory).toBe(join(setup.directory, 'assets'));
  });

  it('takes recognized CI secrets over the selected secret file and keeps omitted keys absent', async () => {
    const setup = await fixture({}, `SESSION_SIGNING_KEY=${signingKey}\nAI_API_KEY=synthetic-file-key\n`);
    const settings = await setup.load({ AI_API_KEY: 'synthetic-ci-key', UNRELATED_API_KEY: 'tooling-only' });
    expect(settings.secrets).toEqual({ SESSION_SIGNING_KEY: signingKey, AI_API_KEY: 'synthetic-ci-key' });
    expect(settings.secrets).not.toHaveProperty('CIGNA_CLIENT_SECRET');
    expect(settings.env).not.toHaveProperty('UNRELATED_API_KEY');
    expect(JSON.stringify(settings.config)).not.toContain(signingKey);
    expect(JSON.stringify(settings.config)).not.toContain('synthetic-ci-key');
  });

  it('loads referenced client IDs and secrets only from the selected target dotenv file', async () => {
    const registry = [{ ...connectionIdentity('test-hospital'), name: 'Test Hospital', kind: 'provider',
      clientIdEnv: 'HOSPITAL_APP_ID', clientSecretEnv: 'HOSPITAL_APP_SECRET',
      fhirBaseUrl: 'https://hospital.example.com/fhir', tokenAuthMethod: 'client_secret_basic' }];
    const previewText = '# Keep this preview registration\nHOSPITAL_APP_ID=preview-client\nHOSPITAL_APP_SECRET="preview-secret=#quoted"\n';
    const productionText = 'HOSPITAL_APP_ID=production-client\nHOSPITAL_APP_SECRET=production-secret\n';
    const setup = await fixture({}, previewText, registry);
    const productionFile = join(setup.directory, '.env.secrets.production');
    await writeFile(productionFile, productionText, { mode: 0o600 });
    await writeFile(join(setup.directory, '.env'), 'HOSPITAL_APP_ID=development-client\nHOSPITAL_APP_SECRET=development-secret\n');
    const settings = await setup.load({ CLOUDFLARE_API_TOKEN: 'synthetic-tooling-token' });
    expect(settings.config.vars.HOSPITAL_APP_ID).toBe('preview-client');
    expect(settings.secrets).toEqual({ HOSPITAL_APP_SECRET: 'preview-secret=#quoted' });
    expect(connectorConfig(settings.env, registry[0].id)).toMatchObject({ clientId: 'preview-client', clientSecret: 'preview-secret=#quoted' });
    expect(settings.env.CLOUDFLARE_API_TOKEN).toBe('synthetic-tooling-token');
    for (const value of ['preview-secret', 'production-client', 'development-client', 'synthetic-tooling-token', 'CONNECTOR_REGISTRY']) expect(JSON.stringify(settings.config)).not.toContain(value);
    const production = await loadDeploymentSettings({ target: 'production', configPath: setup.configPath, secretsFile: productionFile }, {}, registry);
    expect(connectorConfig(production.env, registry[0].id)).toMatchObject({ clientId: 'production-client', clientSecret: 'production-secret' });
    expect(await readFile(setup.secretsFile, 'utf8')).toBe(previewText);
    expect(await readFile(productionFile, 'utf8')).toBe(productionText);
  });

  it('uses Wrangler client ID defaults, then target file credentials, then recognized CI overrides', async () => {
    const registry = [{ ...connectionIdentity('hospital'), name: 'Hospital', kind: 'provider',
      clientIdEnv: 'HOSPITAL_CLIENT_ID', clientSecretEnv: 'HOSPITAL_APP_SECRET',
      fhirBaseUrl: 'https://hospital.example.com/fhir', tokenAuthMethod: 'client_secret_basic' }];
    const setup = await fixture({ vars: { ...publicVars, HOSPITAL_CLIENT_ID: 'wrangler-default' } }, '', registry);
    expect((await setup.load()).config.vars.HOSPITAL_CLIENT_ID).toBe('wrangler-default');
    const text = 'HOSPITAL_CLIENT_ID=file-client\nHOSPITAL_APP_SECRET=file-secret\n';
    await writeFile(setup.secretsFile, text);
    expect(connectorConfig((await setup.load()).env, registry[0].id)).toMatchObject({ clientId: 'file-client', clientSecret: 'file-secret' });
    const settings = await setup.load({ HOSPITAL_CLIENT_ID: 'ci-client', HOSPITAL_APP_SECRET: 'ci-secret' });
    expect(connectorConfig(settings.env, registry[0].id)).toMatchObject({ clientId: 'ci-client', clientSecret: 'ci-secret' });
    expect(settings.config.vars.HOSPITAL_CLIENT_ID).toBe('ci-client');
    expect(settings.config.vars).not.toHaveProperty('HOSPITAL_APP_SECRET');
    expect(await readFile(setup.secretsFile, 'utf8')).toBe(text);
  });

  it('loads derived client ID bindings from the selected dotenv file', async () => {
    const registry = [{ ...connectionIdentity('test-patient', 1, 'test-health'), name: 'Test Health', kind: 'provider', fhirBaseUrl: 'https://hospital.example.com/fhir' }];
    const setup = await fixture({}, 'TEST_HEALTH_PATIENT_ACCESS_CLIENT_ID=configured-client\n', registry);
    const settings = await setup.load();
    expect(settings.config.vars.TEST_HEALTH_PATIENT_ACCESS_CLIENT_ID).toBe('configured-client');
    expect(connectorConfig(settings.env, registry[0].id).clientId).toBe('configured-client');
    expect(settings.secrets).not.toHaveProperty('TEST_HEALTH_PATIENT_ACCESS_CLIENT_ID');
  });

  it('preserves inactive connector credentials in the file without adding runtime bindings', async () => {
    const text = `# Retained recovery entries\nRETIRED_CLIENT_ID=old-client\nRETIRED_CLIENT_SECRET=old-secret\nRETIRED_PRIVATE_KEY=old-custom-secret\nSESSION_SIGNING_KEY=${signingKey}\n`;
    const setup = await fixture({}, text);
    const settings = await setup.load({ RETIRED_CLIENT_ID: 'unused-ci-client', RETIRED_CLIENT_SECRET: 'unused-ci-secret' });
    expect(settings.secrets).toEqual({ SESSION_SIGNING_KEY: signingKey });
    for (const key of ['RETIRED_CLIENT_ID', 'RETIRED_CLIENT_SECRET', 'RETIRED_PRIVATE_KEY']) {
      expect(settings.env).not.toHaveProperty(key);
      expect(settings.config.vars).not.toHaveProperty(key);
    }
    expect(await readFile(setup.secretsFile, 'utf8')).toBe(text);
  });

  it.each(['CONNECTOR_REGISTRY', 'CIGNA_SCOPES', 'ATRIUS_FHIR_BASE_URL', 'ATRIUS_REDIRECT_URI'])('rejects metadata override %s in Wrangler, secret files, and CI', async name => {
    for (const source of ['vars', 'secret', 'shell']) {
      const setup = await fixture(source === 'vars' ? { vars: { ...publicVars, [name]: 'sensitive-value' } } : {}, source === 'secret' ? `${name}=sensitive-value\n` : '');
      const error = await setup.load(source === 'shell' ? { [name]: 'sensitive-value' } : {}).then(() => null, error => error as Error);
      expect(error?.message).toContain('config/connectors.json');
      expect(error?.message).not.toContain('sensitive-value');
    }
  });

  it.each(['CLOUDFLARE_API_TOKEN', 'APP_ORIGIN', 'PRODUCTION_READINESS_FILE'])('rejects %s in an application secret file', async key => {
    const setup = await fixture({}, `${key}=synthetic-value\n`);
    await expect(setup.load()).rejects.toThrow('unknown or non-secret key');
  });

  it.each(['SESSION_SIGNING_KEY', 'HOSPITAL_APP_SECRET', 'RETIRED_CLIENT_SECRET'])('rejects %s in public vars without echoing its value', async key => {
    const registry = [{ ...connectionIdentity('hospital'), name: 'Hospital', kind: 'provider',
      fhirBaseUrl: 'https://hospital.example.com/fhir', clientSecretEnv: 'HOSPITAL_APP_SECRET' }];
    const setup = await fixture({ vars: { ...publicVars, [key]: signingKey } }, '', registry);
    const error = await setup.load().then(() => null, error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`Move ${key} out of vars`);
    expect(error?.message).not.toContain(signingKey);
  });

  it('fails when an explicitly selected secret file is missing', async () => {
    const setup = await fixture();
    await expect(loadDeploymentSettings({ target: 'preview', configPath: setup.configPath,
      secretsFile: join(setup.directory, 'does-not-exist') }, {}, [])).rejects.toThrow('Cannot load the selected secrets file');
  });

  it('redacts malformed JSONC and malformed secret-file contents', async () => {
    const setup = await fixture({}, 'NOT A VALID LINE synthetic-secret-that-must-not-appear');
    const secretError = await setup.load().then(() => null, error => error as Error);
    expect(secretError).toBeInstanceOf(Error);
    expect(secretError?.message).toContain('Cannot load the selected secrets file');
    expect(secretError?.message).not.toContain('synthetic-secret-that-must-not-appear');
    await writeFile(setup.configPath, '{"name": "synthetic-secret-that-must-not-appear');
    const configError = await setup.load().then(() => null, error => error as Error);
    expect(configError).toBeInstanceOf(Error);
    expect(configError?.message).toContain('valid JSON or JSONC');
    expect(configError?.message).not.toContain('synthetic-secret-that-must-not-appear');
  });
});

describe('deployment validation', () => {
  it.each(['unsafe', 'build', 'env'])('rejects %s configuration that could bypass the selected deployment checks', async key => {
    const setup = await fixture({ [key]: {} });
    await expect(setup.load()).rejects.toThrow();
  });
  it.each(['', 'SESSION_SIGNING_KEY=\n'])('rejects missing or blank required secrets', async secretText => {
    const setup = await fixture({ secrets: { required: ['SESSION_SIGNING_KEY'] } }, secretText);
    await expect(setup.load()).rejects.toThrow('Required secret SESSION_SIGNING_KEY is missing or blank');
  });

  it.each([
    ['SESSION_SIGNING_KEY=\n', 'SESSION_SIGNING_KEY must not be blank'],
    ['SESSION_SIGNING_KEY=too-short\n', 'SESSION_SIGNING_KEY must contain at least 32 characters'],
    ['AI_API_KEY=\n', 'AI_API_KEY must not be blank'],
  ])('rejects invalid non-connector secrets: %s', async (secretText, message) => {
    const setup = await fixture({}, secretText);
    await expect(setup.load()).rejects.toThrow(message);
  });

  it('allows unavailable preview credentials but requires production confidential secrets without target fallback', async () => {
    const registry = [{ ...connectionIdentity('hospital'), name: 'Hospital', kind: 'provider', fhirBaseUrl: 'https://hospital.example.com/fhir',
      clientSecretEnv: 'HOSPITAL_PRIVATE_KEY', tokenAuthMethod: 'client_secret_basic' }];
    const setup = await fixture({}, '', registry);
    const developmentText = 'HOSPITAL_PATIENT_ACCESS_CLIENT_ID=local-client\nHOSPITAL_PRIVATE_KEY=local-secret\n';
    await writeFile(join(setup.directory, '.env'), developmentText);
    const productionFile = join(setup.directory, '.env.secrets.production');
    await writeFile(productionFile, 'HOSPITAL_PATIENT_ACCESS_CLIENT_ID=production-client\nHOSPITAL_PRIVATE_KEY=production-secret\n', { mode: 0o600 });
    const preview = await setup.load();
    expect(connectorConfig(preview.env, registry[0].id).enabled).toBe(false);
    expect(preview.secrets).toEqual({});
    expect(preview.env).not.toHaveProperty('HOSPITAL_PATIENT_ACCESS_CLIENT_ID');
    const previewText = 'HOSPITAL_PATIENT_ACCESS_CLIENT_ID=preview-client\nHOSPITAL_PRIVATE_KEY=preview-secret\n';
    const productionText = `SESSION_SIGNING_KEY=${signingKey}\n`;
    await writeFile(setup.secretsFile, previewText);
    await writeFile(productionFile, productionText);
    const options = { target: 'production' as const, configPath: setup.configPath, secretsFile: productionFile };
    const inspection = await readDeploymentSettings(options, {}, registry);
    expect(inspection.env.SESSION_SIGNING_KEY).toBe(signingKey);
    expect(connectorConfig(inspection.env, registry[0].id).enabled).toBe(false);
    expect(inspection.env).not.toHaveProperty('HOSPITAL_PATIENT_ACCESS_CLIENT_ID');
    expect(inspection.secrets).not.toHaveProperty('HOSPITAL_PRIVATE_KEY');
    await expect(loadDeploymentSettings(options, {}, registry)).rejects.toThrow('hospital has incomplete or invalid connector settings');
    expect(await readFile(setup.secretsFile, 'utf8')).toBe(previewText);
    expect(await readFile(productionFile, 'utf8')).toBe(productionText);
    expect(await readFile(join(setup.directory, '.env'), 'utf8')).toBe(developmentText);
  });

  it('rejects a manifest callback on another origin while processing is disabled', async () => {
    const registry = [{ ...connectionIdentity('hospital'), name: 'Hospital', kind: 'provider', fhirBaseUrl: 'https://hospital.example.com/fhir',
      redirectUri: 'https://other.example.com/oauth/callback/hospital' }];
    const setup = await fixture({}, '', registry);
    await expect(setup.load()).rejects.toThrow('hospital has incomplete or invalid connector settings');
  });

  it.each(['PATIENT_PROCESSING_APPROVED', 'AI_PROCESSING_APPROVED', 'AI_RETENTION_VERIFIED', 'PRODUCTION_RELEASE_APPROVED'])('rejects enabled preview flag %s', async key => {
    const setup = await fixture({ vars: { ...publicVars, [key]: 'true' } });
    await expect(setup.load()).rejects.toThrow(`${key} must remain false for a hosted preview`);
  });

  it('rejects catalog bindings in a preview', async () => {
    const setup = await fixture({ d1_databases: [{ binding: 'CATALOG', database_id: '11111111-1111-4111-8111-111111111111' }] });
    await expect(setup.load()).rejects.toThrow('Hosted previews must not attach a catalog database');
  });
});

describe('deployment command options', () => {
  it('defaults to the full production workflow and permits preview-only modes explicitly', () => {
    expect(parseDeploymentOptions([])).toEqual({ target: 'production', dryRun: false, uploadOnly: false, skipBuild: false });
    expect(parseDeploymentOptions(['--target', 'preview', '--dry-run', '--upload-only', '--skip-build', '--config', 'example.jsonc', '--secrets-file', 'example.secrets']))
      .toEqual({ target: 'preview', dryRun: true, uploadOnly: true, skipBuild: true, configPath: 'example.jsonc', secretsFile: 'example.secrets' });
  });

  it.each(['--upload-only', '--skip-build'])('rejects %s for production', option => {
    expect(() => parseDeploymentOptions([option])).toThrow('Production requires a complete validated build');
  });

  it.each([['--connector-credentials-file', 'private.json'], ['--unknown'], ['--target', 'staging'], ['--config'], ['--dry-run', '--dry-run']])('rejects invalid options %j', (...args) => {
    expect(() => parseDeploymentOptions(args)).toThrow();
  });
});
