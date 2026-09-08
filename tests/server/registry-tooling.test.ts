import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEnvironment } from '../../scripts/prepare-env';
import { parseEnv } from '../../scripts/env';
import { withProductionConfig } from '../../scripts/deployment';
import { checkConnectors } from '../../scripts/check-connectors';
import { verifyProduction } from '../../scripts/verify-production';
import { connectorConfig } from '../../src/server/config';
import * as transport from '../../src/connectors/transport';
import { STATES } from '../../src/catalog/schema';
import { PLAN_FAMILIES } from '../../src/shared/contracts';

const hospital = { id: 'hospital-123', name: 'Example Hospital', kind: 'provider', scopeProfile: 'smart', fhirBaseUrl: 'https://ehr.example.com/fhir', clientIdEnv: 'HOSPITAL_APP_ID', clientSecretEnv: 'HOSPITAL_APP_SECRET' };
const env = { APP_ENV: 'production', APP_ORIGIN: 'https://app.example.com', PLAN_YEAR: '2026', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 'synthetic-signing-key-for-unit-tests-only', HOSPITAL_APP_ID: 'synthetic-hospital-client', HOSPITAL_APP_SECRET: 'synthetic-hospital-secret', AI_PROCESSING_APPROVED: 'true', AI_RETENTION_VERIFIED: 'true', AI_API_KEY: 'synthetic-ai-key', AI_MODEL: 'test-model', CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-tooling-token', CATALOG_DATABASE_ID: '11111111-1111-4111-8111-111111111111', CONNECTOR_REGISTRY: JSON.stringify([hospital]) };
const readiness = () => ({ reviewedAt: new Date(Date.now() - 1000).toISOString(), reviewer: 'Synthetic test reviewer', catalogReleaseId: 'test-release', liveAtriusImportVerified: true, liveCignaEmployerImportVerified: true, aiRetentionVerified: true, cloudflareServiceScopeVerified: true, callbackRetentionReviewed: true, independentCalculationReviewPassed: true, loadTestPassed: true, incidentAndRollbackRunbookReviewed: true, coverage: STATES.flatMap(state => PLAN_FAMILIES.map(family => ({ state, family, status: 'verified', evidence: 'Synthetic test evidence' }))) });
afterEach(() => vi.restoreAllMocks());

describe('registry-aware environment tooling', () => {
  it('prepares private local bindings for custom registrations and preserves the registry override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-registry-'));
    try {
      const path = join(directory, '.dev.vars');
      await prepareEnvironment({ ...env, UNRELATED_SECRET: 'synthetic-unrelated-secret' }, path);
      const contents = await readFile(path, 'utf8');
      const bindings = parseEnv(contents);
      expect(bindings.CONNECTOR_REGISTRY).toBe(env.CONNECTOR_REGISTRY);
      expect(connectorConfig(bindings, hospital.id)).toMatchObject({ enabled: true, clientId: env.HOSPITAL_APP_ID, clientSecret: env.HOSPITAL_APP_SECRET });
      expect(contents).not.toContain(env.CLOUDFLARE_API_TOKEN);
      expect(contents).not.toContain('synthetic-unrelated-secret');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('deploys custom and legacy credential references as secrets with no public credential values', async () => {
    const settings = { ...env, CONNECTOR_REGISTRY: JSON.stringify([{ ...hospital, legacyEnvPrefixes: ['OLD_HOSPITAL'] }]), OLD_HOSPITAL_CLIENT_SECRET: 'synthetic-old-secret' };
    await withProductionConfig(settings, async (configPath, secretsPath) => {
      const contents = await readFile(configPath, 'utf8');
      const publicSettings = JSON.parse(contents).vars;
      const secretSettings = JSON.parse(await readFile(secretsPath, 'utf8'));
      expect(publicSettings.CONNECTOR_REGISTRY).toBe(settings.CONNECTOR_REGISTRY);
      expect(publicSettings.HOSPITAL_APP_ID).toBe(env.HOSPITAL_APP_ID);
      expect(publicSettings).not.toHaveProperty('HOSPITAL_APP_SECRET');
      expect(publicSettings).not.toHaveProperty('OLD_HOSPITAL_CLIENT_SECRET');
      expect(contents).not.toContain(env.HOSPITAL_APP_SECRET);
      expect(contents).not.toContain(settings.OLD_HOSPITAL_CLIENT_SECRET);
      expect(secretSettings).toMatchObject({ HOSPITAL_APP_SECRET: env.HOSPITAL_APP_SECRET, OLD_HOSPITAL_CLIENT_SECRET: settings.OLD_HOSPITAL_CLIENT_SECRET });
      expect(connectorConfig({ ...publicSettings, ...secretSettings }, hospital.id)).toMatchObject({ enabled: true, clientSecret: env.HOSPITAL_APP_SECRET });
    });
  });

  it('preserves custom production-prefixed credential bindings while controlling release flags', async () => {
    const settings = { ...env,
      CONNECTOR_REGISTRY: JSON.stringify([{ ...hospital, clientIdEnv: 'PRODUCTION_HOSPITAL_CLIENT_ID', clientSecretEnv: 'PRODUCTION_HOSPITAL_CLIENT_SECRET' }]),
      PRODUCTION_HOSPITAL_CLIENT_ID: env.HOSPITAL_APP_ID, PRODUCTION_HOSPITAL_CLIENT_SECRET: env.HOSPITAL_APP_SECRET,
      PRODUCTION_RELEASE_APPROVED: 'true', PRODUCTION_CATALOG_RELEASE_ID: 'unreviewed-release',
    };
    await withProductionConfig(settings, async (configPath, secretsPath) => {
      const publicSettings = JSON.parse(await readFile(configPath, 'utf8')).vars;
      const secretSettings = JSON.parse(await readFile(secretsPath, 'utf8'));
      expect(publicSettings.PRODUCTION_HOSPITAL_CLIENT_ID).toBe(env.HOSPITAL_APP_ID);
      expect(publicSettings).not.toHaveProperty('PRODUCTION_HOSPITAL_CLIENT_SECRET');
      expect(secretSettings.PRODUCTION_HOSPITAL_CLIENT_SECRET).toBe(env.HOSPITAL_APP_SECRET);
      expect(publicSettings.PRODUCTION_RELEASE_APPROVED).toBe('false');
      expect(publicSettings.PRODUCTION_CATALOG_RELEASE_ID).toBe('');
    });
  });

  it('rejects an oversized UTF-8 registry override before preparing local files or deployment files', async () => {
    const settings = { ...env, CONNECTOR_REGISTRY: JSON.stringify(Array.from({ length: 11 }, (_, index) => ({ ...hospital, id: `hospital-${index}`, name: 'é'.repeat(150) }))) };
    expect(settings.CONNECTOR_REGISTRY.length).toBeLessThan(5120);
    expect(Buffer.byteLength(settings.CONNECTOR_REGISTRY, 'utf8')).toBeGreaterThan(5120);
    const directory = await mkdtemp(join(tmpdir(), 'plan-shepherd-registry-'));
    const action = vi.fn();
    try {
      const path = join(directory, '.dev.vars');
      await expect(prepareEnvironment(settings, path)).rejects.toThrow('config/connectors.json');
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(withProductionConfig(settings, action)).rejects.toThrow('config/connectors.json');
      expect(action).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('registry-wide connection checks', () => {
  it('checks arbitrary IDs in registry order with no more than four discoveries in flight', async () => {
    const definitions = Array.from({ length: 11 }, (_, index) => ({ ...hospital, id: `hospital-${index}` }));
    let active = 0; let maximum = 0;
    const discovery = vi.spyOn(transport, 'discoverConnector').mockImplementation(async (settings, id) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { ...connectorConfig(settings, id), authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token' };
    });
    const results = await checkConnectors({ ...env, CONNECTOR_REGISTRY: definitions });
    expect(results.map(result => result.id)).toEqual(definitions.map(definition => definition.id));
    expect(results.every(result => result.ok)).toBe(true);
    expect(results[10].message).toContain('/oauth/callback/hospital-10');
    expect(discovery).toHaveBeenCalledTimes(11);
    expect(maximum).toBe(4);
  });

  it('lists disabled registrations without discovering them or failing the check', async () => {
    const discovery = vi.spyOn(transport, 'discoverConnector');
    const results = await checkConnectors({ ...env, CONNECTOR_REGISTRY: [{ id: 'optional-payer', name: 'Optional Payer', kind: 'payer', enabled: false }] });
    expect(results).toEqual([{ id: 'optional-payer', name: 'Optional Payer', ok: true, message: 'disabled in the registry; discovery skipped.' }]);
    expect(discovery).not.toHaveBeenCalled();
  });

  it('reports safe failures against the actual registry name without echoing unknown errors', async () => {
    vi.spyOn(transport, 'discoverConnector').mockRejectedValue(new Error(env.HOSPITAL_APP_SECRET));
    const results = await checkConnectors(env);
    expect(results).toEqual([{ id: hospital.id, name: hospital.name, ok: false, message: 'Check the connection configuration.' }]);
    expect(JSON.stringify(results)).not.toContain(env.HOSPITAL_APP_SECRET);
  });
});

describe('registry-aware production readiness', () => {
  it('requires enabled custom registrations and skips disabled optional registrations', async () => {
    const settings = { ...env, CONNECTOR_REGISTRY: JSON.stringify([hospital, { id: 'optional-payer', name: 'Optional Payer', kind: 'payer', enabled: false }]) };
    expect(await verifyProduction(settings, readiness())).toEqual([]);
    expect(await verifyProduction({ ...settings, HOSPITAL_APP_ID: '' }, readiness())).toContain('hospital-123 requires approved production configuration.');
    expect(await verifyProduction({ ...settings, CONNECTOR_REGISTRY: JSON.stringify([{ ...hospital, redirectUri: 'https://other.example.com/oauth/callback/hospital-123' }]) }, readiness())).toContain('hospital-123 callback must match the production application origin and a supported callback path.');
  });

  it('fails safely for invalid registries and preserves the existing live-import release attestations', async () => {
    const failures = await verifyProduction({ ...env, CONNECTOR_REGISTRY: env.HOSPITAL_APP_SECRET }, readiness());
    expect(failures).toContain('The connector registry has invalid configuration.');
    expect(JSON.stringify(failures)).not.toContain(env.HOSPITAL_APP_SECRET);
    expect(await verifyProduction(env, { ...readiness(), liveAtriusImportVerified: false })).toContain('Complete the independently reviewed production-readiness record.');
    expect(await verifyProduction(env, { ...readiness(), liveCignaEmployerImportVerified: false })).toContain('Complete the independently reviewed production-readiness record.');
  });
});
