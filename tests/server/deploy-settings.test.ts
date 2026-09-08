import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeploymentSettings, parseDeploymentOptions } from '../../scripts/deploy-settings';
import { connectorConfig } from '../../src/server/config';

const directories: string[] = [];
const origin = 'https://app.example.com';
const signingKey = 'synthetic-session-signing-key-for-tests';
const publicVars = {
  APP_ENV: 'production', APP_ORIGIN: origin, PLAN_YEAR: '2026',
  BCH_REDIRECT_URI: `${origin}/auth/callback/bch`,
  PATIENT_PROCESSING_APPROVED: 'false', AI_PROCESSING_APPROVED: 'false',
  AI_RETENTION_VERIFIED: 'false', PRODUCTION_RELEASE_APPROVED: 'false',
  PRODUCTION_CATALOG_RELEASE_ID: '',
};

async function fixture(configOverrides: Record<string, unknown> = {}, secretText = '') {
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
    load: (environment: Record<string, string | undefined> = {}) => loadDeploymentSettings({ target: 'preview', configPath, secretsFile }, environment),
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
      CLOUDFLARE_WORKER_NAME: 'wrong-worker', CONNECTOR_REGISTRY: 'invalid-local-registry',
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

  it('allows registry-defined secrets while keeping deployment credentials tooling-only', async () => {
    const registry = [{ id: 'test-hospital', name: 'Test Hospital', kind: 'provider',
      clientIdEnv: 'HOSPITAL_CLIENT_ID', clientSecretEnv: 'HOSPITAL_APP_SECRET',
      fhirBaseUrl: 'https://hospital.example.com/fhir', tokenAuthMethod: 'client_secret_basic' }];
    const { BCH_REDIRECT_URI: _bchRedirectUri, ...registryVars } = publicVars;
    const setup = await fixture({ vars: { ...registryVars, CONNECTOR_REGISTRY: JSON.stringify(registry), HOSPITAL_CLIENT_ID: 'synthetic-client' } },
      'HOSPITAL_APP_SECRET=synthetic-file-secret\n');
    const settings = await setup.load({ HOSPITAL_APP_SECRET: 'synthetic-ci-secret', CLOUDFLARE_API_TOKEN: 'synthetic-tooling-token' });
    expect(settings.secrets).toEqual({ HOSPITAL_APP_SECRET: 'synthetic-ci-secret' });
    expect(settings.env.CLOUDFLARE_API_TOKEN).toBe('synthetic-tooling-token');
    expect(JSON.stringify(settings.config)).not.toContain('synthetic-ci-secret');
    expect(JSON.stringify(settings.config)).not.toContain('synthetic-tooling-token');
    expect(settings.secrets).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });

  it.each(['CLOUDFLARE_API_TOKEN', 'APP_ORIGIN', 'UNKNOWN_APP_SECRET'])('rejects %s in an application secret file', async key => {
    const setup = await fixture({}, `${key}=synthetic-value\n`);
    await expect(setup.load()).rejects.toThrow('unknown or non-secret key');
  });

  it('rejects secret values in public vars without echoing their values', async () => {
    const setup = await fixture({ vars: { ...publicVars, SESSION_SIGNING_KEY: signingKey } });
    const error = await setup.load().then(() => null, error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('Move SESSION_SIGNING_KEY out of vars');
    expect(error?.message).not.toContain(signingKey);
  });

  it('fails when an explicitly selected secret file is missing', async () => {
    const setup = await fixture();
    await expect(loadDeploymentSettings({ target: 'preview', configPath: setup.configPath,
      secretsFile: join(setup.directory, 'does-not-exist') }, {})).rejects.toThrow('Cannot load the selected secrets file');
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

  it('preserves an explicit blank canonical client secret over a legacy alias', async () => {
    const setup = await fixture({ vars: { ...publicVars, EPIC_CLIENT_ID: 'synthetic-client' } },
      'EPIC_CLIENT_SECRET=synthetic-legacy-secret\nATRIUS_CLIENT_SECRET=synthetic-old-canonical-secret\n');
    const settings = await setup.load({ ATRIUS_CLIENT_SECRET: '' });
    expect(settings.secrets.ATRIUS_CLIENT_SECRET).toBe('');
    expect(settings.secrets.EPIC_CLIENT_SECRET).toBe('synthetic-legacy-secret');
    expect(connectorConfig(settings.env, 'atrius')).toMatchObject({ clientSecret: '', tokenAuthMethod: 'none' });
  });

  it('rejects a connector callback on another origin even while processing is disabled', async () => {
    const setup = await fixture({ vars: { ...publicVars, ATRIUS_REDIRECT_URI: 'https://other.example.com/oauth/callback/atrius' } });
    await expect(setup.load()).rejects.toThrow('atrius has incomplete or invalid connector settings');
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

  it.each([['--unknown'], ['--target', 'staging'], ['--config'], ['--dry-run', '--dry-run']])('rejects invalid options %j', (...args) => {
    expect(() => parseDeploymentOptions(args)).toThrow();
  });
});
