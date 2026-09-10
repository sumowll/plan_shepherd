import { withBundledConnections } from '../helpers/connector-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledConnectionId } from '../helpers/connection-identity';
import app from '../../src/server/index';
import { connectorConfig } from '../../src/server/config';
import { exchangeCode, getResourcePage } from '../../src/connectors/transport';
import { verifyReceipt } from '../../src/connectors/receipt';

const cignaId = bundledConnectionId('cigna-patient-access');
const secret = 'synthetic-cigna-signing-key-32-characters';
const scopes = 'openid fhirUser patient/*.read';
const accessToken = 'synthetic-cigna-access-token';
const patientId = 'authorized-patient';
const payer = { fhirBaseUrl: 'https://payer.example/fhir', authorizationUrl: 'https://payer.example/authorize', tokenUrl: 'https://payer.example/token' };
const env = withBundledConnections({ APP_ENV: 'development', APP_ORIGIN: 'https://app.example',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret, CIGNA_PATIENT_ACCESS_CLIENT_ID: 'synthetic-cigna-client', EPIC_CLIENT_ID: 'synthetic-atrius-client',
}, { cigna: { ...payer, tokenAuthMethod: 'none', clientSecretEnv: undefined },
  'atrius-health': { fhirBaseUrl: 'https://provider.example/fhir', authorizationUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token', tokenAuthMethod: 'none', clientSecretEnv: undefined } });
const exchangeInput = { code: 'one-time-code', verifier: 'v'.repeat(43) };
const tokenResponse = { access_token: accessToken, token_type: 'Bearer', patient: patientId, expires_in: 600, scope: scopes };
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const excessScopes = [
  'patient/*.write', 'patient/*.cruds', 'patient/Encounter.u', 'user/*.read', 'system/*.rs',
  'offline_access', 'online_access', 'profile', 'email', 'fhiruser', 'unknown',
];
// The identity is deliberately unverified and represents somebody other than the authorized patient.
const idToken = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'caregiver', fhirUser: 'https://payer.example/fhir/RelatedPerson/caregiver' })).toString('base64url')}.`;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Cigna identity scope configuration', () => {
  it('defaults Cigna to the portal scopes while preserving the Atrius default', () => {
    expect(connectorConfig(env, 'cigna-patient-access')).toMatchObject({ scopes, enabled: true });
    expect(connectorConfig(env, 'atrius-health-patient-access').scopes).toBe('launch/patient patient/*.read');
  });

  it.each([scopes, 'openid fhirUser launch/patient patient/Patient.r patient/ExplanationOfBenefit.rs', 'patient/*.read'])('accepts explicitly configured patient read scopes: %s', configured => {
    expect(connectorConfig(withBundledConnections(env, { cigna: { scopes: configured } }), 'cigna-patient-access').scopes).toBe(configured);
  });

  it.each(excessScopes)('rejects configured permission %s even alongside the allowed Cigna scopes', extra => {
    expect(() => connectorConfig(withBundledConnections(env, { cigna: { scopes: `${scopes} ${extra}` } }), 'cigna-patient-access')).toThrow();
  });

  it.each(['openid', 'fhirUser'])('permits %s for Atrius only when explicitly requested', async identityScope => {
    const requested = `${identityScope} patient/*.read`;
    const settings = withBundledConnections(env, { 'atrius-health': { scopes: requested } });
    expect(connectorConfig(settings, 'atrius-health-patient-access')).toMatchObject({ scopes: requested, enabled: true });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse({ ...tokenResponse, scope: requested })));
    await expect(exchangeCode(settings, 'atrius-health-patient-access', exchangeInput, env.APP_ORIGIN)).resolves.toMatchObject({ patientId, scopes: requested });
    await expect(exchangeCode(env, 'atrius-health-patient-access', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([undefined, 'openid fhirUser patient/Patient.r patient/ExplanationOfBenefit.rs'])('provides default or configured scopes to the authorization flow: %s', async configured => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const response = await app.request('https://app.example/api/connectors/cigna-patient-access/authorize', {
      headers: { Origin: env.APP_ORIGIN },
    }, withBundledConnections(env, { cigna: { scopes: configured ?? scopes } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authorizationUrl: payer.authorizationUrl, clientId: env.CIGNA_PATIENT_ACCESS_CLIENT_ID,
      scopes: configured ?? scopes, audience: payer.fhirBaseUrl,
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('Cigna granted scopes and patient binding', () => {
  it.each(excessScopes)('rejects excess granted permission %s despite valid requested scopes', async extra => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...tokenResponse, scope: `${scopes} ${extra}` })));
    await expect(exchangeCode(withBundledConnections(env, { cigna: { scopes } }), 'cigna-patient-access', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([scopes, undefined])('accepts identity scopes with explicit patient context and discards ID tokens (granted scope: %s)', async granted => {
    const upstream = vi.fn().mockResolvedValue(jsonResponse({ ...tokenResponse, scope: granted, id_token: idToken, fhirUser: 'RelatedPerson/caregiver' }));
    vi.stubGlobal('fetch', upstream);
    const result = await exchangeCode(withBundledConnections(env, { cigna: { scopes } }), 'cigna-patient-access', exchangeInput, env.APP_ORIGIN);
    expect(result).toEqual({ accessToken, patientId, expiresIn: 600, scopes, receipt: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(idToken);
    expect(JSON.stringify(result)).not.toContain('caregiver');
    await expect(verifyReceipt(secret, result.receipt, cignaId, patientId, accessToken)).resolves.toBeUndefined();
    for (const [connector, patient, bearer] of [
      ['atrius-health-patient-access', patientId, accessToken], [cignaId, 'another-patient', accessToken], [cignaId, patientId, 'another-token'],
    ]) await expect(verifyReceipt(secret, result.receipt, connector, patient, bearer)).rejects.toMatchObject({ code: 'invalid_session' });
    const [url, options] = upstream.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(payer.tokenUrl);
    const body = new URLSearchParams(String(options.body));
    expect(body.get('redirect_uri')).toBe(`${env.APP_ORIGIN}/oauth/callback/cigna-patient-access`);
    expect(body.get('client_id')).toBe(env.CIGNA_PATIENT_ACCESS_CLIENT_ID);
    expect(body.get('code_verifier')).toBe(exchangeInput.verifier);
  });

  it.each([undefined, '', 'Patient/another-patient'])('requires valid token.patient even when an ID token or fhirUser is provided: %s', async patient => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...tokenResponse, patient, id_token: idToken, fhirUser: 'Patient/another-patient',
    })));
    await expect(exchangeCode(env, 'cigna-patient-access', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'missing_patient_context' });
  });

  it('limits imported records to the patient named in the Cigna token response', async () => {
    const claim = { resourceType: 'ExplanationOfBenefit', id: 'claim1', patient: { reference: `Patient/${patientId}` } };
    const bundle = (resource: unknown) => ({ resourceType: 'Bundle', entry: [{ resource }] });
    const upstream = vi.fn().mockResolvedValueOnce(jsonResponse({ ...tokenResponse, id_token: idToken }))
      .mockResolvedValueOnce(jsonResponse(bundle(claim)))
      .mockResolvedValueOnce(jsonResponse(bundle({ ...claim, patient: { reference: 'Patient/another-patient' } })));
    vi.stubGlobal('fetch', upstream);
    const result = await exchangeCode(env, 'cigna-patient-access', exchangeInput, env.APP_ORIGIN);
    const read = { receipt: result.receipt, patientId: result.patientId, resource: 'ExplanationOfBenefit' as const, from: '2025-01-01', to: '2025-12-31' };
    await expect(getResourcePage(env, 'cigna-patient-access', read, accessToken)).resolves.toEqual(bundle(claim));
    await expect(getResourcePage(env, 'cigna-patient-access', { ...read, patientId: 'another-patient' }, accessToken)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(getResourcePage(env, 'cigna-patient-access', read, accessToken)).rejects.toMatchObject({ code: 'patient_mismatch' });
  });
});
