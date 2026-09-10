import { withConnectorRegistry } from '../../src/server/connector-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverConnector, exchangeCode, getResourcePage } from '../../src/connectors/transport';
import { bundledConnectionId, connectionIdentity } from '../helpers/connection-identity';
import { signReceipt, verifyReceipt } from '../../src/connectors/receipt';
import { authorizeReferences, getReferences } from '../../src/connectors/references';

const secret = 'synthetic-registry-signing-key-32-characters';
const patientId = 'patient-123';
const token = 'synthetic-access-token';
const input = { code: 'one-time-code', verifier: 'v'.repeat(43) };
const read = { patientId, resource: 'Encounter' as const, from: '2025-01-01', to: '2025-12-31' };
const hospital = {
  ...connectionIdentity('hospital-north', 1, 'north-health'), name: 'North Hospital', kind: 'provider', grantedScopeFormat: 'resource_operations',
  fhirBaseUrl: 'https://hospital.example/fhir', clientId: 'hospital-client',
  authorizationUrl: 'https://hospital.example/authorize', tokenUrl: 'https://hospital.example/token',
  resources: ['Patient', 'Encounter'], scopes: 'launch/patient patient/*.read',
};
const payer = {
  ...connectionIdentity('plan-sandbox', 2, 'example-payer'), name: 'Plan Sandbox', kind: 'payer', grantedScopeFormat: 'read_search',
  fhirBaseUrl: 'https://payer.example/fhir', clientId: 'payer-client',
  authorizationUrl: 'https://payer.example/authorize', tokenUrl: 'https://payer.example/token',
  resources: ['Patient', 'ExplanationOfBenefit'], scopes: 'openid fhirUser patient/*.read',
};
const env = withConnectorRegistry({ APP_ENV: 'development', APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret }, [hospital, payer]);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const tokenResponse = (scope: string) => json({ access_token: token, token_type: 'Bearer', patient: patientId, expires_in: 600, scope });
const encounter = { resourceType: 'Encounter', id: 'encounter-1', subject: { reference: `Patient/${patientId}` }, participant: [{ individual: { reference: 'Practitioner/pr1' } }] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('registry authorization and patient isolation', () => {
  it('exchanges arbitrary connector IDs with their own client, token endpoint, callback, and granted scope format', async () => {
    const upstream = vi.fn().mockImplementation((url: string) => tokenResponse(url === hospital.tokenUrl ? 'Patient.read Encounter.search' : 'openid read search'));
    vi.stubGlobal('fetch', upstream);
    for (const definition of [hospital, payer]) {
      const result = await exchangeCode(env, definition.key, input, env.APP_ORIGIN);
      await expect(verifyReceipt(secret, result.receipt, definition.id, patientId, token)).resolves.toBeUndefined();
      const otherId = definition.id === hospital.id ? payer.id : hospital.id;
      await expect(verifyReceipt(secret, result.receipt, otherId, patientId, token)).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(verifyReceipt(secret, result.receipt, definition.id, 'other-patient', token)).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(verifyReceipt(secret, result.receipt, definition.id, patientId, 'other-token')).rejects.toMatchObject({ code: 'invalid_session' });
      const [url, options] = upstream.mock.calls.at(-1) as [string, RequestInit];
      const body = new URLSearchParams(String(options.body));
      expect(url).toBe(definition.tokenUrl);
      expect(body.get('client_id')).toBe(definition.clientId);
      expect(body.get('redirect_uri')).toBe(`${env.APP_ORIGIN}/oauth/callback/${definition.key}`);
      expect(body.get('code_verifier')).toBe(input.verifier);
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('accepts the key or UUID for receipts and reference reads after a key rename', async () => {
    const upstream = vi.fn().mockImplementation((url: string | URL) => String(url) === hospital.tokenUrl
      ? tokenResponse('Patient.read Encounter.search')
      : json({ resourceType: 'Practitioner', id: 'pr1' }));
    vi.stubGlobal('fetch', upstream);
    const session = await exchangeCode(env, hospital.key, input, env.APP_ORIGIN);
    const authorized = await authorizeReferences(env, hospital.key, patientId, token, encounter);
    const renamed = { ...hospital, key: 'north-patient-access', name: 'North Health' };
    const settings = withConnectorRegistry({ ...env }, [renamed, payer]);
    for (const identifier of [renamed.key, hospital.id]) {
      await expect(getReferences(settings, identifier, { receipt: session.receipt, patientId, references: authorized.references }, token))
        .resolves.toMatchObject({ resources: [{ resourceType: 'Practitioner', id: 'pr1' }], incomplete: false });
    }
  });

  it.each([
    ['smart', 'patient/Patient.r patient/Encounter.rs', true],
    ['smart', 'Patient.read', false],
    ['smart', 'openid read search', false],
    ['resource_operations', 'Patient.read Encounter.search', true],
    ['resource_operations', 'patient/Patient.r patient/Encounter.rs', true],
    ['resource_operations', 'openid read search', false],
    ['read_search', 'read search', true],
    ['read_search', 'patient/Patient.r patient/Encounter.rs', true],
    ['read_search', 'Patient.read', false],
    ['read_search', 'read search offline_access', false],
  ] as const)('uses %s for arbitrary IDs with grant %s (allowed: %s)', async (grantedScopeFormat, scope, allowed) => {
    const registryEnv = withConnectorRegistry({ ...env }, [{ ...hospital, grantedScopeFormat }]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => tokenResponse(scope)));
    const exchange = exchangeCode(registryEnv, hospital.id, input, env.APP_ORIGIN);
    if (allowed) await expect(exchange).resolves.toMatchObject({ scopes: scope, patientId });
    else await expect(exchange).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([
    ['smart', 'patient/*.read'],
    ['resource_operations', 'Patient.read Encounter.search'],
    ['read_search', 'read search'],
  ] as const)('accepts only explicitly requested identity grants with %s permissions', async (grantedScopeFormat, grants) => {
    for (const identity of ['openid', 'fhirUser']) {
      const otherIdentity = identity === 'openid' ? 'fhirUser' : 'openid';
      for (const requested of ['patient/*.read', `${otherIdentity} patient/*.read`, `${identity} patient/*.read`]) {
        const settings = withConnectorRegistry({ ...env }, [{ ...hospital, grantedScopeFormat, scopes: requested }]);
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => tokenResponse(`${identity} ${grants}`)));
        const exchange = exchangeCode(settings, hospital.id, input, env.APP_ORIGIN);
        if (requested.includes(identity)) await expect(exchange).resolves.toMatchObject({ patientId, scopes: `${identity} ${grants}` });
        else await expect(exchange).rejects.toMatchObject({ code: 'unsafe_scope' });
      }
    }
  });

  it('rejects identity grants absent from the registered scopes despite stale environment metadata', async () => {
    const settings = withConnectorRegistry({ ...env, PLAN_SCOPES: 'openid fhirUser patient/*.read' }, [{ ...payer, scopes: 'patient/*.read' }]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => tokenResponse('openid read search')));
    await expect(exchangeCode(settings, payer.id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([
    ['resource_operations', 'Patient.read Encounter.search'],
    ['read_search', 'read search'],
  ] as const)('keeps %s native grants unavailable in requested permissions', async (grantedScopeFormat, scopes) => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = withConnectorRegistry({ ...env }, [{ ...hospital, grantedScopeFormat, scopes }]);
    await expect(exchangeCode(settings, hospital.id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'connector_configuration_invalid' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['smart', 'resource_operations', 'read_search'] as const)('requires patient context and discards ID tokens for %s identity grants', async grantedScopeFormat => {
    const scopes = 'openid fhirUser patient/*.read';
    const settings = withConnectorRegistry({ ...env }, [{ ...hospital, grantedScopeFormat, scopes }]);
    for (const context of [undefined, patientId]) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ access_token: token, token_type: 'Bearer', patient: context,
        scope: scopes, id_token: 'unverified-identity-token', fhirUser: 'Patient/other-patient' })));
      const exchange = exchangeCode(settings, hospital.id, input, env.APP_ORIGIN);
      if (!context) await expect(exchange).rejects.toMatchObject({ code: 'missing_patient_context' });
      else {
        const result = await exchange;
        expect(result.patientId).toBe(patientId);
        expect(JSON.stringify(result)).not.toContain('unverified-identity-token');
        expect(JSON.stringify(result)).not.toContain('other-patient');
      }
    }
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

  it('keeps receipts and reference capabilities isolated between two connections in the same organization', async () => {
    const second = { ...hospital, ...connectionIdentity('north-secondary-access', 3, hospital.organizationId) };
    const settings = withConnectorRegistry({ ...env }, [hospital, second]);
    const hospitalReceipt = await signReceipt(secret, hospital.id, patientId, token, 600);
    const secondReceipt = await signReceipt(secret, second.id, patientId, token, 600);
    const authorized = await authorizeReferences(settings, hospital.key, patientId, token, encounter);
    expect(authorized.references).toHaveLength(1);
    const upstream = vi.fn().mockImplementation(() => json({ resourceType: 'Practitioner', id: 'pr1' }));
    vi.stubGlobal('fetch', upstream);
    await expect(getResourcePage(settings, second.key, { ...read, receipt: hospitalReceipt }, token)).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(getReferences(settings, second.key, { receipt: secondReceipt, patientId, references: authorized.references }, token)).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(upstream).not.toHaveBeenCalled();
    await expect(getReferences(settings, hospital.id, { receipt: hospitalReceipt, patientId, references: authorized.references }, token)).resolves.toMatchObject({ resources: [{ resourceType: 'Practitioner', id: 'pr1' }], incomplete: false });
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

  it.each(['epic', 'f51b8aa0-94ce-492b-bc06-fcaafdc1ece0'])('rejects the removed duplicate Epic identifier %s before network access', async identifier => {
    const settings = { APP_ENV: env.APP_ENV, APP_ORIGIN: env.APP_ORIGIN, PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret, EPIC_CLIENT_ID: 'shared-epic-app' };
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const receipt = await signReceipt(secret, bundledConnectionId('atrius-health-patient-access'), patientId, token, 600);
    await expect(discoverConnector(settings, identifier)).rejects.toMatchObject({ status: 404 });
    await expect(exchangeCode(settings, identifier, input, env.APP_ORIGIN)).rejects.toMatchObject({ status: 404 });
    await expect(getResourcePage(settings, identifier, { ...read, receipt }, token)).rejects.toMatchObject({ status: 404 });
    await expect(getReferences(settings, identifier, { receipt, patientId, references: [] }, token)).rejects.toMatchObject({ status: 404 });
    await expect(authorizeReferences(settings, identifier, patientId, token, encounter)).rejects.toMatchObject({ status: 404 });
    expect(upstream).not.toHaveBeenCalled();
  });
});
