import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEnvironment } from '../../scripts/prepare-env';
import { parseEnv, readEnvironment } from '../../scripts/env';
import { connectorConfig } from '../../src/server/config';
import { withConnectorRegistry } from '../../src/server/connector-registry';
import { connectionIdentity } from '../helpers/connection-identity';

const definition = { ...connectionIdentity('north-patient', 1, 'north-health'), name: 'North Health', kind: 'provider',
  fhirBaseUrl: 'https://north.example/fhir', clientSecretEnv: 'NORTH_PRIVATE_KEY' };
const globals = 'APP_ENV=development\nSESSION_SIGNING_KEY=' + 's'.repeat(48) + '\nPATIENT_PROCESSING_APPROVED=true\n';
const local = globals + '# Keep this saved input.\nNORTH_HEALTH_PATIENT_ACCESS_CLIENT_ID=local-client\nNORTH_PRIVATE_KEY="local $secret # with spaces"\nUNUSED_CLIENT_ID=unused-client\n';
const options = { registry: [definition], environment: {} };

async function fixture(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-env-'));
  try {
    await writeFile(join(directory, '.env'), local, { mode: 0o600 });
    await writeFile(join(directory, '.env.secrets.production'), 'NORTH_HEALTH_PATIENT_ACCESS_CLIENT_ID=production-client\nNORTH_PRIVATE_KEY=production-secret\n', { mode: 0o600 });
    await action(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('local connector configuration', () => {
  it('loads saved dotenv credentials and generates private bindings without changing source files', async () => {
    await fixture(async directory => {
      const env = await readEnvironment(join(directory, '.env'), { ...options, environment: { CLOUDFLARE_API_TOKEN: 'tooling-only' } });
      expect(connectorConfig(env, definition.id)).toMatchObject({ clientId: 'local-client', clientSecret: 'local $secret # with spaces', enabled: true });
      const path = join(directory, '.dev.vars');
      await prepareEnvironment(env, path);
      const contents = await readFile(path, 'utf8');
      const bindings = parseEnv(contents);
      expect(bindings).toMatchObject({ NORTH_HEALTH_PATIENT_ACCESS_CLIENT_ID: 'local-client', NORTH_PRIVATE_KEY: 'local $secret # with spaces' });
      expect(connectorConfig(withConnectorRegistry(bindings, [definition]), definition.id).enabled).toBe(true);
      for (const value of ['production-client', 'unused-client', 'tooling-only', 'CONNECTOR_REGISTRY']) expect(contents).not.toContain(value);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(local);
      expect(await readFile(join(directory, '.env.secrets.production'), 'utf8')).toContain('production-secret');
    });
  });

  it('allows explicit credential and application shell overrides without writing them back', async () => {
    await fixture(async directory => {
      const env = await readEnvironment(join(directory, '.env'), { ...options,
        environment: { NORTH_PRIVATE_KEY: 'shell-secret', APP_ORIGIN: 'http://localhost:4000' } });
      expect(connectorConfig(env, definition.id).clientSecret).toBe('shell-secret');
      expect(env.APP_ORIGIN).toBe('http://localhost:4000');
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(local);
    });
  });

  it.each(['CONNECTOR_REGISTRY', 'NORTH_SCOPES', 'NORTH_FHIR_BASE_URL', 'NORTH_TOKEN_AUTH_METHOD'])('rejects metadata %s from dotenv and shell without exposing values', async name => {
    await fixture(async directory => {
      const path = join(directory, '.env');
      for (const source of ['file', 'shell']) {
        await writeFile(path, globals + (source === 'file' ? `${name}=sensitive-value\n` : ''));
        const result = await readEnvironment(path, { ...options, environment: source === 'shell' ? { [name]: 'sensitive-value' } : {} }).then(() => null, error => error as Error);
        expect(result?.message).toContain('config/connectors.json');
        expect(result?.message).not.toContain('sensitive-value');
      }
    });
  });

  it('uses only production credentials for production tooling and never falls back to local credentials', async () => {
    await fixture(async directory => {
      const path = join(directory, '.env');
      const env = await readEnvironment(path, { ...options, target: 'production' });
      expect(connectorConfig(env, definition.id)).toMatchObject({ clientId: 'production-client', clientSecret: 'production-secret' });
      expect(env.SESSION_SIGNING_KEY).toBe('s'.repeat(48));
      expect(env).not.toHaveProperty('UNUSED_CLIENT_ID');
      await rm(join(directory, '.env.secrets.production'));
      const missing = await readEnvironment(path, { ...options, target: 'production' });
      expect(missing).not.toHaveProperty('NORTH_HEALTH_PATIENT_ACCESS_CLIENT_ID');
      expect(missing).not.toHaveProperty('NORTH_PRIVATE_KEY');
      expect(connectorConfig(missing, definition.id).enabled).toBe(false);
    });
  });

  it('does not load adjacent production secrets during local development', async () => {
    await fixture(async directory => {
      const path = join(directory, '.env');
      await writeFile(path, globals);
      const env = await readEnvironment(path, options);
      expect(env).not.toHaveProperty('NORTH_PRIVATE_KEY');
      expect(connectorConfig(env, definition.id).enabled).toBe(false);
    });
  });

  it('requires an explicitly selected dotenv file to exist', async () => {
    await fixture(async directory => {
      const secretsFile = join(directory, 'missing.env');
      await expect(readEnvironment(join(directory, '.env'), { ...options, secretsFile })).rejects.toThrow();
      await expect(readEnvironment(join(directory, '.env'), { ...options, target: 'production', secretsFile })).rejects.toThrow('Cannot load the selected secrets file');
    });
  });

  it('clears stale generated credentials when no values remain without altering saved inputs', async () => {
    await fixture(async directory => {
      const path = join(directory, '.dev.vars');
      await writeFile(path, 'EPIC_CLIENT_ID=stale\n');
      await prepareEnvironment({}, path);
      expect(parseEnv(await readFile(path, 'utf8'))).toEqual({});
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(local);
    });
  });
});
