import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploy } from '../../scripts/deploy';
import { buildApplication, runProjectCommand } from '../../scripts/build';
import { deploymentEnvironment, runWrangler, withDeploymentFiles } from '../../scripts/deployment';
import { queryD1 } from '../../scripts/d1-query';
import { runtimeEnvironmentKeys } from '../../scripts/env';

vi.mock('../../scripts/build', () => ({ buildApplication: vi.fn(), runProjectCommand: vi.fn() }));
vi.mock('../../scripts/d1-query', () => ({ queryD1: vi.fn() }));
vi.mock('../../scripts/deployment', async importOriginal => ({
  ...await importOriginal<typeof import('../../scripts/deployment')>(), runWrangler: vi.fn(),
}));

const directories: string[] = [];
const signingKey = 'synthetic-session-signing-key-for-command-tests';
const publicVars = {
  APP_ENV: 'production', APP_ORIGIN: 'https://app.example.com', PLAN_YEAR: '2026',
  PATIENT_PROCESSING_APPROVED: 'false', AI_PROCESSING_APPROVED: 'false', AI_RETENTION_VERIFIED: 'false',
  PRODUCTION_RELEASE_APPROVED: 'false', PRODUCTION_CATALOG_RELEASE_ID: '',
};
type Upload = { args: string[]; env: Record<string, string>; config: Record<string, unknown>;
  secrets: Record<string, string>; paths: string[]; emptyEnv: string };
const uploads: Upload[] = [];

async function fixture(production = false) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-deploy-command-'));
  directories.push(directory);
  const configPath = join(directory, 'wrangler.jsonc');
  const secretsFile = join(directory, '.env.secrets');
  const workerPath = join(directory, 'worker.js');
  await writeFile(workerPath, 'export default { fetch() { return new Response("synthetic"); } };');
  await mkdir(join(directory, 'assets'));
  const config = {
    name: 'synthetic-preview', account_id: '1'.repeat(32), main: './worker.js', assets: { directory: './assets' },
    vars: production ? { ...publicVars, PATIENT_PROCESSING_APPROVED: 'true', AI_PROCESSING_APPROVED: 'true',
      AI_RETENTION_VERIFIED: 'true', AI_MODEL: 'synthetic-model', CONNECTOR_REGISTRY: '[]' } : { ...publicVars, BCH_REDIRECT_URI: `${publicVars.APP_ORIGIN}/auth/callback/bch` },
    ...(production ? { d1_databases: [{ binding: 'CATALOG', database_id: '11111111-1111-4111-8111-111111111111' }] } : {}),
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(secretsFile, `SESSION_SIGNING_KEY=${signingKey}\n${production ? 'AI_API_KEY=synthetic-ai-key\n' : ''}`, { mode: 0o600 });
  return { directory, workerPath, args: ['--target', production ? 'production' : 'preview', '--config', configPath, '--secrets-file', secretsFile] };
}

beforeEach(() => {
  uploads.length = 0;
  vi.clearAllMocks();
  for (const key of [...runtimeEnvironmentKeys(publicVars).secretKeys, 'CLOUDFLARE_API_TOKEN', 'PRODUCTION_READINESS_FILE']) vi.stubEnv(key, undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.mocked(buildApplication).mockResolvedValue(undefined);
  vi.mocked(runWrangler).mockImplementation((args, env) => {
    const paths = ['--config', '--secrets-file', '--env-file'].map(option => {
      const index = args.indexOf(option);
      if (index < 0 || !args[index + 1]) throw new Error(`Missing explicit ${option}`);
      return args[index + 1];
    });
    uploads.push({ args, env, paths, config: JSON.parse(readFileSync(paths[0], 'utf8')),
      secrets: JSON.parse(readFileSync(paths[1], 'utf8')), emptyEnv: readFileSync(paths[2], 'utf8') });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('deployment orchestration', () => {
  it('dry-runs with an explicit empty env file, separate secrets, and no app secrets in tool env or output', async () => {
    const setup = await fixture();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-deployment-token');
    await deploy([...setup.args, '--dry-run']);
    expect(buildApplication).toHaveBeenCalledExactlyOnceWith(true);
    expect(runProjectCommand).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(upload.args[0]).toBe('deploy');
    expect(upload.args).toContain('--dry-run');
    expect(upload.emptyEnv).toBe('');
    expect(upload.secrets).toEqual({ SESSION_SIGNING_KEY: signingKey });
    expect(upload.env).toEqual({ CLOUDFLARE_API_TOKEN: 'synthetic-deployment-token' });
    expect(upload.config).toMatchObject({ vars: publicVars, logpush: false, preview_urls: false,
      observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } } });
    expect(JSON.stringify(upload.config)).not.toContain(signingKey);
    const output = vi.mocked(process.stdout.write).mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('Nothing was uploaded or deployed');
    expect(output).not.toContain(signingKey);
    expect(output).not.toContain('synthetic-deployment-token');
    for (const path of upload.paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(queryD1).not.toHaveBeenCalled();
  });

  it('uses versions upload for a preview upload and still runs tests when skipping the build', async () => {
    const setup = await fixture();
    await deploy([...setup.args, '--upload-only', '--skip-build']);
    expect(buildApplication).not.toHaveBeenCalled();
    expect(runProjectCommand).toHaveBeenCalledExactlyOnceWith(['node_modules/vitest/vitest.mjs', 'run']);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].args.slice(0, 2)).toEqual(['versions', 'upload']);
    expect(uploads[0].args).not.toContain('--dry-run');
    expect(uploads[0].emptyEnv).toBe('');
  });

  it('does not upload missing build output even when the caller skips the build', async () => {
    const setup = await fixture();
    await rm(setup.workerPath);
    await expect(deploy([...setup.args, '--skip-build'])).rejects.toThrow('Compiled Worker or client assets are missing');
    expect(runProjectCommand).toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('does not upload after a failed build', async () => {
    const setup = await fixture();
    vi.mocked(buildApplication).mockRejectedValueOnce(new Error('Synthetic validation failure'));
    await expect(deploy(setup.args)).rejects.toThrow('Synthetic validation failure');
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('blocks production before D1 queries, builds, or uploads when readiness evidence is missing', async () => {
    const setup = await fixture(true);
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-deployment-token');
    vi.stubEnv('PRODUCTION_READINESS_FILE', join(setup.directory, 'missing-readiness.json'));
    await expect(deploy(setup.args)).rejects.toThrow('Complete the independently reviewed production-readiness record');
    expect(queryD1).not.toHaveBeenCalled();
    expect(buildApplication).not.toHaveBeenCalled();
    expect(runProjectCommand).not.toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
  });
});

describe('private deployment files', () => {
  it('creates owner-only config, secrets, and empty dotenv files and removes all three after success', async () => {
    const paths: string[] = [];
    const result = await withDeploymentFiles({ vars: publicVars }, { SESSION_SIGNING_KEY: signingKey, ATRIUS_CLIENT_SECRET: '' },
      async (configPath, secretsPath, emptyEnvPath) => {
        paths.push(configPath, secretsPath, emptyEnvPath);
        for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(emptyEnvPath, 'utf8')).toBe('');
        expect(await readFile(configPath, 'utf8')).not.toContain(signingKey);
        expect(JSON.parse(await readFile(secretsPath, 'utf8'))).toEqual({ SESSION_SIGNING_KEY: signingKey, ATRIUS_CLIENT_SECRET: '' });
        return 'synthetic-success';
      });
    expect(result).toBe('synthetic-success');
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes private files after a deployment callback throws', async () => {
    const paths: string[] = [];
    await expect(withDeploymentFiles({ vars: publicVars }, { SESSION_SIGNING_KEY: signingKey },
      async (...createdPaths) => { paths.push(...createdPaths); throw new Error('Synthetic deployment failure'); }))
      .rejects.toThrow('Synthetic deployment failure');
    expect(paths).toHaveLength(3);
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('deployment subprocess environment', () => {
  it('excludes inherited application, arbitrary, and Vite secrets while pinning deployment controls', () => {
    for (const key of ['ATRIUS_CLIENT_SECRET', 'HOSPITAL_PRIVATE_SECRET', 'VITE_HOSPITAL_SECRET', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']) {
      vi.stubEnv(key, `synthetic-${key}`);
    }
    vi.stubEnv('CLOUDFLARE_ENV', 'wrong-environment');
    vi.stubEnv('CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH', 'wrong-config.jsonc');
    vi.stubEnv('CLOUDFLARE_INCLUDE_PROCESS_ENV', 'true');
    const env = deploymentEnvironment({});
    for (const key of ['ATRIUS_CLIENT_SECRET', 'HOSPITAL_PRIVATE_SECRET', 'VITE_HOSPITAL_SECRET', 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '', CLOUDFLARE_ENV: '',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      CLOUDFLARE_VITE_FORCE_LOCAL: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' });
    expect(env.PATH).toBe(process.env.PATH);
    expect(JSON.stringify(env)).not.toContain('synthetic-');
    expect(deploymentEnvironment({ CLOUDFLARE_API_TOKEN: 'synthetic-explicit-token' }).CLOUDFLARE_API_TOKEN).toBe('synthetic-explicit-token');
  });
});
