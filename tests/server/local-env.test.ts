import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEnvironment } from '../../scripts/prepare-env';
import { parseEnv } from '../../scripts/env';
import { connectorConfig } from '../../src/server/config';

describe('local connector configuration', () => {
  it('carries separate connector credentials into private Worker bindings, including explicit empty values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plan-shepherd-env-'));
    try {
      const path = join(dir, '.dev.vars');
      const env = { APP_ENV: 'development', EPIC_CLIENT_ID: 'synthetic-epic-client', EPIC_CLIENT_SECRET: 'synthetic-epic-secret', EPIC_TOKEN_AUTH_METHOD: 'client_secret_basic', EPIC_REDIRECT_URI: 'http://localhost:3000/auth/callback', CIGNA_CLIENT_ID: 'synthetic-cigna-client', CIGNA_CLIENT_SECRET: 'synthetic-cigna-secret', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir', CLOUDFLARE_API_TOKEN: 'tooling-only', SESSION_SIGNING_KEY: 's'.repeat(48), PATIENT_PROCESSING_APPROVED: 'true' };
      await prepareEnvironment(env, path);
      const text = await readFile(path, 'utf8');
      const bindings = parseEnv(text);
      expect(text).not.toContain('tooling-only');
      expect(connectorConfig(bindings, 'epic')).toMatchObject({ enabled: true, clientId: env.EPIC_CLIENT_ID, clientSecret: env.EPIC_CLIENT_SECRET });
      expect(connectorConfig(bindings, 'atrius-health')).toMatchObject({ configured: false, clientId: '', clientSecret: '' });
      expect(connectorConfig(bindings, 'cigna')).toMatchObject({ enabled: true, clientSecret: env.CIGNA_CLIENT_SECRET });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await prepareEnvironment({ ...env, ATRIUS_CLIENT_ID: '' }, path);
      const updated = parseEnv(await readFile(path, 'utf8'));
      expect(updated.ATRIUS_CLIENT_ID).toBe('');
      expect(connectorConfig(updated, 'atrius-health').configured).toBe(false);
      expect(connectorConfig(updated, 'epic')).toMatchObject({ configured: true, clientSecret: env.EPIC_CLIENT_SECRET });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
