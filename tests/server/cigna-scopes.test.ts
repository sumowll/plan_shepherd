import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/server/index';
import { connectorConfig } from '../../src/server/config';
import { exchangeCode, getResourcePage } from '../../src/connectors/transport';
import { verifyReceipt } from '../../src/connectors/receipt';

const secret = 'synthetic-cigna-signing-key-32-characters';
const scopes = 'openid fhirUser patient/*.read';
const accessToken = 'synthetic-cigna-access-token';
const patientId = 'authorized-patient';
const env = {
  APP_ENV: 'development', APP_ORIGIN: 'https://app.example',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret,
  CIGNA_CLIENT_ID: 'synthetic-cigna-client', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir',
  CIGNA_AUTHORIZATION_URL: 'https://payer.example/authorize', CIGNA_TOKEN_URL: 'https://payer.example/token',
  ATRIUS_CLIENT_ID: 'synthetic-atrius-client', ATRIUS_FHIR_BASE_URL: 'https://provider.example/fhir',
  ATRIUS_AUTHORIZATION_URL: 'https://provider.example/authorize', ATRIUS_TOKEN_URL: 'https://provider.example/token',
};
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
    expect(connectorConfig(env, 'cigna')).toMatchObject({ scopes, enabled: true });
    expect(connectorConfig(env, 'atrius').scopes).toBe('launch/patient patient/*.read');
  });

  it.each([scopes, 'openid fhirUser launch/patient patient/Patient.r patient/ExplanationOfBenefit.rs', 'patient/*.read'])('accepts explicitly configured patient read scopes: %s', configured => {
    expect(connectorConfig({ ...env, CIGNA_SCOPES: configured }, 'cigna').scopes).toBe(configured);
  });

  it.each(excessScopes)('rejects configured permission %s even alongside the allowed Cigna scopes', extra => {
    expect(() => connectorConfig({ ...env, CIGNA_SCOPES: `${scopes} ${extra}` }, 'cigna')).toThrow();
  });

  it.each(['openid', 'fhirUser'])('keeps %s unavailable to Atrius configuration and token grants', async identityScope => {
    expect(() => connectorConfig({ ...env, ATRIUS_SCOPES: `${identityScope} patient/*.read` }, 'atrius')).toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...tokenResponse, scope: `${identityScope} patient/*.read` })));
    await expect(exchangeCode(env, 'atrius', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([undefined, 'openid fhirUser patient/Patient.r patient/ExplanationOfBenefit.rs'])('provides default or configured scopes to the authorization flow: %s', async configured => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const response = await app.request('https://app.example/api/connectors/cigna/authorize', {
      headers: { Origin: env.APP_ORIGIN },
    }, { ...env, ...(configured ? { CIGNA_SCOPES: configured } : {}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authorizationUrl: env.CIGNA_AUTHORIZATION_URL, clientId: env.CIGNA_CLIENT_ID,
      scopes: configured ?? scopes, audience: env.CIGNA_FHIR_BASE_URL,
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('Cigna granted scopes and patient binding', () => {
  it.each(excessScopes)('rejects excess granted permission %s despite valid requested scopes', async extra => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...tokenResponse, scope: `${scopes} ${extra}` })));
    await expect(exchangeCode({ ...env, CIGNA_SCOPES: scopes }, 'cigna', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each([scopes, undefined])('accepts identity scopes with explicit patient context and discards ID tokens (granted scope: %s)', async granted => {
    const upstream = vi.fn().mockResolvedValue(jsonResponse({ ...tokenResponse, scope: granted, id_token: idToken, fhirUser: 'RelatedPerson/caregiver' }));
    vi.stubGlobal('fetch', upstream);
    const result = await exchangeCode({ ...env, CIGNA_SCOPES: scopes }, 'cigna', exchangeInput, env.APP_ORIGIN);
    expect(result).toEqual({ accessToken, patientId, expiresIn: 600, scopes, receipt: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(idToken);
    expect(JSON.stringify(result)).not.toContain('caregiver');
    await expect(verifyReceipt(secret, result.receipt, 'cigna', patientId, accessToken)).resolves.toBeUndefined();
    for (const [connector, patient, bearer] of [
      ['atrius', patientId, accessToken], ['cigna', 'another-patient', accessToken], ['cigna', patientId, 'another-token'],
    ]) await expect(verifyReceipt(secret, result.receipt, connector, patient, bearer)).rejects.toMatchObject({ code: 'invalid_session' });
    const [url, options] = upstream.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(env.CIGNA_TOKEN_URL);
    const body = new URLSearchParams(String(options.body));
    expect(body.get('redirect_uri')).toBe(`${env.APP_ORIGIN}/oauth/callback/cigna`);
    expect(body.get('client_id')).toBe(env.CIGNA_CLIENT_ID);
    expect(body.get('code_verifier')).toBe(exchangeInput.verifier);
  });

  it.each([undefined, '', 'Patient/another-patient'])('requires valid token.patient even when an ID token or fhirUser is provided: %s', async patient => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...tokenResponse, patient, id_token: idToken, fhirUser: 'Patient/another-patient',
    })));
    await expect(exchangeCode(env, 'cigna', exchangeInput, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'missing_patient_context' });
  });

  it('limits imported records to the patient named in the Cigna token response', async () => {
    const claim = { resourceType: 'ExplanationOfBenefit', id: 'claim1', patient: { reference: `Patient/${patientId}` } };
    const bundle = (resource: unknown) => ({ resourceType: 'Bundle', entry: [{ resource }] });
    const upstream = vi.fn().mockResolvedValueOnce(jsonResponse({ ...tokenResponse, id_token: idToken }))
      .mockResolvedValueOnce(jsonResponse(bundle(claim)))
      .mockResolvedValueOnce(jsonResponse(bundle({ ...claim, patient: { reference: 'Patient/another-patient' } })));
    vi.stubGlobal('fetch', upstream);
    const result = await exchangeCode(env, 'cigna', exchangeInput, env.APP_ORIGIN);
    const read = { receipt: result.receipt, patientId: result.patientId, resource: 'ExplanationOfBenefit' as const, from: '2025-01-01', to: '2025-12-31' };
    await expect(getResourcePage(env, 'cigna', read, accessToken)).resolves.toEqual(bundle(claim));
    await expect(getResourcePage(env, 'cigna', { ...read, patientId: 'another-patient' }, accessToken)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(getResourcePage(env, 'cigna', read, accessToken)).rejects.toMatchObject({ code: 'patient_mismatch' });
  });
});
