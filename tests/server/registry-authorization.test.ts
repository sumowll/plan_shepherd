import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverConnector, exchangeCode, getResourcePage } from '../../src/connectors/transport';
import { signReceipt, verifyReceipt } from '../../src/connectors/receipt';
import { authorizeReferences, getReferences } from '../../src/connectors/references';

const secret = 'synthetic-registry-signing-key-32-characters';
const patientId = 'patient-123';
const token = 'synthetic-access-token';
const input = { code: 'one-time-code', verifier: 'v'.repeat(43) };
const read = { patientId, resource: 'Encounter' as const, from: '2025-01-01', to: '2025-12-31' };
const hospital = {
  id: 'hospital-north', name: 'North Hospital', kind: 'provider', scopeProfile: 'epic',
  fhirBaseUrl: 'https://hospital.example/fhir', clientId: 'hospital-client',
  authorizationUrl: 'https://hospital.example/authorize', tokenUrl: 'https://hospital.example/token',
  resources: ['Patient', 'Encounter'], scopes: 'launch/patient patient/*.read',
};
const payer = {
  id: 'plan-sandbox', name: 'Plan Sandbox', kind: 'payer', scopeProfile: 'cigna',
  fhirBaseUrl: 'https://payer.example/fhir', clientId: 'payer-client',
  authorizationUrl: 'https://payer.example/authorize', tokenUrl: 'https://payer.example/token',
  resources: ['Patient', 'ExplanationOfBenefit'], scopes: 'openid fhirUser patient/*.read',
};
const env = {
  APP_ENV: 'development', APP_ORIGIN: 'https://app.example',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret,
  CONNECTOR_REGISTRY: [hospital, payer],
};
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const tokenResponse = (scope: string) => json({ access_token: token, token_type: 'Bearer', patient: patientId, expires_in: 600, scope });
const encounter = { resourceType: 'Encounter', id: 'encounter-1', subject: { reference: `Patient/${patientId}` }, participant: [{ individual: { reference: 'Practitioner/pr1' } }] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('registry authorization and patient isolation', () => {
  it('exchanges arbitrary connector IDs with their own client, token endpoint, callback, and scope profile', async () => {
    const upstream = vi.fn().mockImplementation((url: string) => tokenResponse(url === hospital.tokenUrl ? 'Patient.read Encounter.search' : 'openid read search'));
    vi.stubGlobal('fetch', upstream);
    for (const definition of [hospital, payer]) {
      const result = await exchangeCode(env, definition.id, input, env.APP_ORIGIN);
      await expect(verifyReceipt(secret, result.receipt, definition.id, patientId, token)).resolves.toBeUndefined();
      const otherId = definition.id === hospital.id ? payer.id : hospital.id;
      await expect(verifyReceipt(secret, result.receipt, otherId, patientId, token)).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(verifyReceipt(secret, result.receipt, definition.id, 'other-patient', token)).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(verifyReceipt(secret, result.receipt, definition.id, patientId, 'other-token')).rejects.toMatchObject({ code: 'invalid_session' });
      const [url, options] = upstream.mock.calls.at(-1) as [string, RequestInit];
      const body = new URLSearchParams(String(options.body));
      expect(url).toBe(definition.tokenUrl);
      expect(body.get('client_id')).toBe(definition.clientId);
      expect(body.get('redirect_uri')).toBe(`${env.APP_ORIGIN}/oauth/callback/${definition.id}`);
      expect(body.get('code_verifier')).toBe(input.verifier);
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['smart', 'patient/Patient.r patient/Encounter.rs', true],
    ['smart', 'Patient.read', false],
    ['smart', 'openid read search', false],
    ['epic', 'Patient.read Encounter.search', true],
    ['epic', 'openid read search', false],
    ['cigna', 'openid fhirUser read search', true],
    ['cigna', 'Patient.read', false],
    ['cigna', 'openid read search offline_access', false],
  ] as const)('uses the %s scope profile for arbitrary IDs with grant %s (allowed: %s)', async (scopeProfile, scope, allowed) => {
    const registryEnv = { ...env, CONNECTOR_REGISTRY: [{ ...hospital, scopeProfile }] };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => tokenResponse(scope)));
    const exchange = exchangeCode(registryEnv, hospital.id, input, env.APP_ORIGIN);
    if (allowed) await expect(exchange).resolves.toMatchObject({ scopes: scope, patientId });
    else await expect(exchange).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it('enforces configured resource support and signed session isolation before fetching pages', async () => {
    const receipt = await signReceipt(secret, hospital.id, patientId, token, 600);
    const upstream = vi.fn().mockImplementation(() => json({ resourceType: 'Bundle', entry: [{ resource: encounter }] }));
    vi.stubGlobal('fetch', upstream);
    await expect(getResourcePage(env, hospital.id, { ...read, receipt }, token)).resolves.toMatchObject({ resourceType: 'Bundle' });
    expect(String(upstream.mock.calls[0][0])).toContain(`${hospital.fhirBaseUrl}/Encounter?patient=${patientId}`);
    upstream.mockClear();
    await expect(getResourcePage(env, hospital.id, { ...read, receipt, resource: 'ExplanationOfBenefit' }, token)).rejects.toMatchObject({ code: 'resource_unavailable' });
    await expect(getResourcePage(env, payer.id, { ...read, receipt, resource: 'ExplanationOfBenefit' }, token)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps reference capabilities isolated even when a patient has valid sessions for both connectors', async () => {
    const hospitalReceipt = await signReceipt(secret, hospital.id, patientId, token, 600);
    const payerReceipt = await signReceipt(secret, payer.id, patientId, token, 600);
    const authorized = await authorizeReferences(env, hospital.id, patientId, token, encounter);
    expect(authorized.references).toHaveLength(1);
    const upstream = vi.fn().mockImplementation(() => json({ resourceType: 'Practitioner', id: 'pr1' }));
    vi.stubGlobal('fetch', upstream);
    await expect(getReferences(env, payer.id, { receipt: payerReceipt, patientId, references: authorized.references }, token)).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(upstream).not.toHaveBeenCalled();
    await expect(getReferences(env, hospital.id, { receipt: hospitalReceipt, patientId, references: authorized.references }, token)).resolves.toMatchObject({ resources: [{ resourceType: 'Practitioner', id: 'pr1' }], incomplete: false });
    expect(String(upstream.mock.calls[0][0])).toBe(`${hospital.fhirBaseUrl}/Practitioner/pr1`);
  });

  it('rejects unknown IDs in discovery, token, resource, and reference operations before network access', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const receipt = await signReceipt(secret, hospital.id, patientId, token, 600);
    await expect(discoverConnector(env, 'unregistered-hospital')).rejects.toMatchObject({ status: 404 });
    await expect(exchangeCode(env, 'unregistered-hospital', input, env.APP_ORIGIN)).rejects.toMatchObject({ status: 404 });
    await expect(getResourcePage(env, 'unregistered-hospital', { ...read, receipt }, token)).rejects.toMatchObject({ status: 404 });
    await expect(getReferences(env, 'unregistered-hospital', { receipt, patientId, references: [] }, token)).rejects.toMatchObject({ status: 404 });
    await expect(authorizeReferences(env, 'unregistered-hospital', patientId, token, encounter)).rejects.toMatchObject({ status: 404 });
    expect(upstream).not.toHaveBeenCalled();
  });
});
