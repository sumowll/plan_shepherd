import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { withProductionConfig } from '../../scripts/deployment';
import { verifyProduction } from '../../scripts/verify-production';
import { STATES } from '../../src/catalog/schema';
import { PLAN_FAMILIES } from '../../src/shared/contracts';
import { assistantRequestSchema, validateProposals } from '../../src/server/assistant';
import definitions from '../../config/connectors.json';
import { withConnectorRegistry } from '../../src/server/connector-registry';
import { connectorConfig } from '../../src/server/config';

const env = { APP_ENV: 'production', APP_ORIGIN: 'https://app.example.com', PLAN_YEAR: '2026', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 'synthetic-signing-key-for-unit-tests-only', EPIC_CLIENT_ID: 'synthetic-epic-client', CIGNA_PATIENT_ACCESS_CLIENT_ID: 'approved', AETNA_PATIENT_ACCESS_CLIENT_ID: 'synthetic-aetna-client', AI_PROCESSING_APPROVED: 'true', AI_RETENTION_VERIFIED: 'true', AI_API_KEY: 'synthetic-test-key', AI_MODEL: 'test-model', CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-tooling-token', CATALOG_DATABASE_ID: '11111111-1111-4111-8111-111111111111' };
const credentials = { ATRIUS_CLIENT_SECRET: 'synthetic-atrius-secret', BCH_CLIENT_SECRET: 'synthetic-bch-secret', CIGNA_CLIENT_SECRET: 'synthetic-cigna-secret', AETNA_CLIENT_SECRET: 'synthetic-aetna-secret' };
Object.assign(env, credentials);
const callbackSettings = (id: string, redirectUri: string) => withConnectorRegistry(env, definitions.map(definition => `${definition.organizationId}-${definition.apiType.replaceAll('_', '-')}` === id ? { ...definition, redirectUri } : definition));
const readiness = () => ({ reviewedAt: new Date(Date.now() - 1000).toISOString(), reviewer: 'Synthetic test reviewer', catalogReleaseId: 'test-release', liveAtriusImportVerified: true, liveCignaEmployerImportVerified: true, aiRetentionVerified: true, cloudflareServiceScopeVerified: true, callbackRetentionReviewed: true, independentCalculationReviewPassed: true, loadTestPassed: true, incidentAndRollbackRunbookReviewed: true, coverage: STATES.flatMap(state => PLAN_FAMILIES.map(family => ({ state, family, status: 'verified', evidence: 'Synthetic unit-test evidence; not a production attestation' }))) });

describe('production configuration', () => {
  it('keeps independent connector secret bindings when public client IDs are shared', async () => {
    expect(connectorConfig(env, 'atrius-health-patient-access')).toMatchObject({ clientId: env.EPIC_CLIENT_ID, clientSecret: credentials.ATRIUS_CLIENT_SECRET });
    expect(connectorConfig(env, 'bch-patient-access')).toMatchObject({ clientId: env.EPIC_CLIENT_ID, clientSecret: credentials.BCH_CLIENT_SECRET });
    await withProductionConfig(env, async (config, secrets) => {
      const publicSettings = JSON.parse(await readFile(config, 'utf8')).vars;
      const secretSettings = JSON.parse(await readFile(secrets, 'utf8'));
      expect(secretSettings).toMatchObject(credentials);
      for (const name of Object.keys(credentials)) expect(publicSettings).not.toHaveProperty(name);
      expect(connectorConfig({ ...publicSettings, ...secretSettings }, 'atrius-health-patient-access').clientSecret).toBe(credentials.ATRIUS_CLIENT_SECRET);
      expect(connectorConfig({ ...publicSettings, ...secretSettings }, 'bch-patient-access').clientSecret).toBe(credentials.BCH_CLIENT_SECRET);
    });
  });
  it('uploads connector client secrets as secrets, never plain Worker variables', async () => {
    await withProductionConfig({ ...env, ...credentials }, async (config, secrets) => {
      const plain = await readFile(config, 'utf8');
      for (const value of Object.values(credentials)) expect(plain).not.toContain(value);
      expect(JSON.parse(await readFile(secrets, 'utf8'))).toMatchObject(credentials);
    });
  });
  it('puts the real DB and public settings in config while keeping secrets separate and cleaning both files', async () => {
    let configFile = ''; let secretsFile = '';
    await withProductionConfig(env, async (config, secrets) => {
      configFile = config; secretsFile = secrets;
      const text = await readFile(config, 'utf8'); const parsed = JSON.parse(text);
      expect(parsed.d1_databases[0].database_id).toBe(env.CATALOG_DATABASE_ID);
      expect(parsed.vars.APP_ENV).toBe('production'); expect(parsed.vars.PRODUCTION_RELEASE_APPROVED).toBe('true');
      expect(parsed.vars.PRODUCTION_CATALOG_RELEASE_ID).toBe('test-release');
      expect(parsed.vars).toMatchObject({ CIGNA_PATIENT_ACCESS_CLIENT_ID: env.CIGNA_PATIENT_ACCESS_CLIENT_ID, AETNA_PATIENT_ACCESS_CLIENT_ID: env.AETNA_PATIENT_ACCESS_CLIENT_ID });
      expect(connectorConfig(parsed.vars, 'cigna-patient-access').clientId).toBe(env.CIGNA_PATIENT_ACCESS_CLIENT_ID);
      expect(connectorConfig(parsed.vars, 'aetna-patient-access').clientId).toBe(env.AETNA_PATIENT_ACCESS_CLIENT_ID);
      for (const value of [env.AI_API_KEY, env.SESSION_SIGNING_KEY, env.CLOUDFLARE_API_TOKEN]) expect(text).not.toContain(value);
      expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({ AI_API_KEY: env.AI_API_KEY, SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY, ...credentials });
      expect((await stat(secrets)).mode & 0o777).toBe(0o600);
    }, { approvedReleaseId: 'test-release' });
    await expect(stat(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(secretsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cleans temporary secrets when a deployment callback fails', async () => {
    let file = '';
    await expect(withProductionConfig(env, async (_config, secrets) => { file = secrets; throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires complete current, nonduplicate evidence, not future-dated approvals', async () => {
    expect(await verifyProduction(env, readiness())).toEqual([]);
    const future = { ...readiness(), reviewedAt: new Date(Date.now() + 86400000).toISOString() };
    expect(await verifyProduction(env, future)).toContain('Production readiness must be reviewed within the past 30 days and cannot be future-dated.');
    const duplicate = readiness(); duplicate.coverage.push(duplicate.coverage[0]);
    expect(await verifyProduction(env, duplicate)).toContain('Coverage evidence contains duplicate state/family entries.');
    expect(await verifyProduction({ ...env, APP_ORIGIN: 'https://app.example.com/patient' }, readiness())).not.toEqual([]);
  });
  it.each([
    ['atrius-health-patient-access', 'http://localhost:3000/auth/callback'],
    ['atrius-health-patient-access', 'https://other.example.com/oauth/callback/atrius-health-patient-access'],
    ['atrius-health-patient-access', `${env.APP_ORIGIN}/oauth/callback/epic`],
    ['cigna-patient-access', `${env.APP_ORIGIN}/auth/callback`],
    ['cigna-patient-access', `${env.APP_ORIGIN}/oauth/callback/cigna-patient-access?extra=value`],
  ])('rejects production readiness for an invalid %s manifest callback', async (id, redirectUri) => {
    expect(await verifyProduction(callbackSettings(id, redirectUri), readiness())).toContain(`${id} callback must match the production application origin and a supported callback path.`);
  });
  it('accepts the legacy Atrius callback when explicitly selected in the manifest', async () => {
    expect(await verifyProduction(callbackSettings('atrius-health-patient-access', `${env.APP_ORIGIN}/auth/callback`), readiness())).toEqual([]);
    expect(await verifyProduction(callbackSettings('atrius-health-patient-access', ''), readiness())).toEqual([]);
  });
});
describe('AI evidence support', () => {
  const proposal = { kind: 'provider' as const, name: 'Invented Doctor', category: null, date: null, quantity: null, strength: null, form: null, location: null, evidenceIds: ['record'] };
  it('rejects invented fields even if they cite an existing evidence ID', () => {
    expect(validateProposals({ topic: 'providers', proposals: [proposal] }, new Map([['record', { text: 'Actual Doctor', method: 'structured_import' }]]))).toEqual([]);
    expect(validateProposals({ topic: 'providers', proposals: [{ ...proposal, name: 'Actual Doctor' }] }, new Map([['record', { text: 'Actual Doctor', method: 'structured_import' }]]))).toHaveLength(1);
  });
  it('rejects namespace collisions between records and user conversation', () => {
    const evidence = { id: 'chat:0', source: 'record', text: 'untrusted', method: 'structured_import', confirmed: false };
    expect(assistantRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hello' }], evidence: [evidence] }).success).toBe(false);
  });
  it('does not turn historical care into future intent', () => {
    const event = { ...proposal, kind: 'expected_care' as const, name: 'Therapy', category: 'therapy' as const, date: '2026-06-01', quantity: 1 };
    expect(validateProposals({ topic: 'expected_care', proposals: [event] }, new Map([['record', { text: 'Therapy 2026-06-01 quantity 1', method: 'structured_import' }]]))).toEqual([]);
    expect(validateProposals({ topic: 'expected_care', proposals: [event] }, new Map([['record', { text: 'Therapy 2026-06-01 quantity 1', method: 'user_entered' }]]))).toHaveLength(1);
  });
});
