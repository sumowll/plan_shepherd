import { withBundledConnections } from '../helpers/connector-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverConnector, exchangeCode } from '../../src/connectors/transport';
import { connectorConfig } from '../../src/server/config';

const provider = { fhirBaseUrl: 'https://provider.example/fhir', authorizationUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token' };
const payer = { fhirBaseUrl: 'https://payer.example/fhir', authorizationUrl: 'https://payer.example/authorize', tokenUrl: 'https://payer.example/token' };
const env = withBundledConnections({ APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(32),
  EPIC_CLIENT_ID: 'provider-client', CIGNA_PATIENT_ACCESS_CLIENT_ID: 'payer-client',
}, { 'atrius-health': { ...provider, tokenAuthMethod: 'none', clientSecretEnv: undefined }, cigna: { ...payer, tokenAuthMethod: 'none', clientSecretEnv: undefined } });
const input = { code: 'one-time-code', verifier: 'v'.repeat(43) };
const token = { access_token: 'synthetic-access', token_type: 'Bearer', patient: 'authorized-patient', expires_in: 600 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const metadata = {
  resourceType: 'CapabilityStatement', rest: [{ mode: 'server', security: { extension: [{
    url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
    extension: [{ url: 'authorize', valueUri: provider.authorizationUrl }, { url: 'token', valueUri: provider.tokenUrl }],
  }] } }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('server-side authorization code exchange', () => {
  it.each(['none', 'client_secret_basic', 'client_secret_post'])('sends exactly one configured authentication method: %s', method => {
    const fetch = vi.fn().mockResolvedValue(json(token)); vi.stubGlobal('fetch', fetch);
    return exchangeCode(withBundledConnections({ ...env, EPIC_CLIENT_ID: 'client:with space', ATRIUS_CLIENT_SECRET: 'secret:+/é' }, { 'atrius-health': { tokenAuthMethod: method, clientSecretEnv: 'ATRIUS_CLIENT_SECRET', redirectUri: 'https://app.example/auth/callback' } }), 'atrius-health-patient-access', input, env.APP_ORIGIN).then(result => {
      const [target, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(String(options.body));
      const headers = new Headers(options.headers);
      expect(target).toBe(provider.tokenUrl);
      expect(body.get('redirect_uri')).toBe('https://app.example/auth/callback');
      expect(body.get('code_verifier')).toBe(input.verifier);
      expect(body.get('code')).toBe(input.code);
      expect(options.redirect).toBe('manual');
      if (method === 'client_secret_basic') {
        expect(atob(headers.get('Authorization')!.slice('Basic '.length))).toBe('client%3Awith+space:secret%3A%2B%2F%C3%A9');
        expect(body.has('client_id')).toBe(false);
        expect(body.has('client_secret')).toBe(false);
      } else {
        expect(headers.has('Authorization')).toBe(false);
        expect(body.get('client_id')).toBe('client:with space');
        expect(body.get('client_secret')).toBe(method === 'client_secret_post' ? 'secret:+/é' : null);
      }
      expect(JSON.stringify(result)).not.toContain('secret');
    });
  });

  it('uses the Cigna portal’s client-secret POST convention when a secret is present', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...token, scope: 'search read openid' })); vi.stubGlobal('fetch', fetch);
    const result = await exchangeCode(withBundledConnections({ ...env, CIGNA_CLIENT_SECRET: 'payer-secret' }, { cigna: { tokenAuthMethod: 'client_secret_post', clientSecretEnv: 'CIGNA_CLIENT_SECRET' } }), 'cigna-patient-access', input, env.APP_ORIGIN);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(new URLSearchParams(String(options.body)).get('client_secret')).toBe('payer-secret');
    expect(new Headers(options.headers).has('Authorization')).toBe(false);
    expect(result.patientId).toBe(token.patient);
    expect(result.scopes).toBe('search read openid');
  });

  it('never sends an authorization code when the callback or secret is misconfigured', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(exchangeCode(withBundledConnections(env, { 'atrius-health': { redirectUri: 'https://other.example/auth/callback' } }), 'atrius-health-patient-access', input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'connector_configuration_invalid' });
    await expect(exchangeCode(withBundledConnections(env, { 'atrius-health': { tokenAuthMethod: 'client_secret_basic', clientSecretEnv: 'ATRIUS_CLIENT_SECRET' } }), 'atrius-health-patient-access', input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'connector_not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts documented Epic resource operation grants and whitespace without broadening requested scopes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, scope: ' Patient.read Patient.search Encounter.read  ' })));
    const result = await exchangeCode(env, 'atrius-health-patient-access', input, env.APP_ORIGIN);
    expect(result.scopes).toBe('Patient.read Patient.search Encounter.read');
    expect(() => connectorConfig(withBundledConnections(env, { 'atrius-health': { scopes: 'Patient.read Patient.search' } }), 'atrius-health-patient-access')).toThrow();
    expect(() => connectorConfig(withBundledConnections(env, { cigna: { scopes: 'search read openid' } }), 'cigna-patient-access')).toThrow();
  });

  it.each([
    ['atrius-health-patient-access', 'Patient.write'], ['atrius-health-patient-access', 'Patient.create'], ['atrius-health-patient-access', 'system/Patient.read'],
    ['atrius-health-patient-access', 'read search'], ['cigna-patient-access', 'Patient.read'], ['cigna-patient-access', 'search read write openid'],
    ['cigna-patient-access', 'offline_access search read'], ['atrius-health-patient-access', ''], ['cigna-patient-access', '   '],
  ] as const)('rejects unsupported granted scopes for %s: %s', async (id, scope) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, scope })));
    await expect(exchangeCode(env, id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each(['atrius-health-patient-access', 'cigna-patient-access'] as const)('still requires a verified patient context with native grants for %s', async id => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, patient: undefined, scope: id === 'atrius-health-patient-access' ? 'Patient.read Patient.search ' : 'search read openid', id_token: 'unverified' })));
    await expect(exchangeCode(env, id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'missing_patient_context' });
  });
});

describe('SMART endpoint discovery', () => {
  const discoveryEnv = withBundledConnections(env, { 'atrius-health': { authorizationUrl: '', tokenUrl: '' } });

  it.each([404, 405])('falls back to FHIR capability metadata when well-known returns %s', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json(metadata)); vi.stubGlobal('fetch', fetch);
    expect(await discoverConnector(discoveryEnv, 'atrius-health-patient-access')).toMatchObject({ authorizationUrl: provider.authorizationUrl, tokenUrl: provider.tokenUrl });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${provider.fhirBaseUrl}/.well-known/smart-configuration`, `${provider.fhirBaseUrl}/metadata`]);
    for (const call of fetch.mock.calls) expect(call[1].redirect).toBe('manual');
  });

  it('uses well-known endpoints when available and does not fetch metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ authorization_endpoint: provider.authorizationUrl, token_endpoint: provider.tokenUrl })); vi.stubGlobal('fetch', fetch);
    expect(await discoverConnector(discoveryEnv, 'atrius-health-patient-access')).toMatchObject({ tokenUrl: provider.tokenUrl });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 503])('does not mask well-known failure %s with fallback discovery', async status => {
    const fetch = vi.fn().mockResolvedValue(json({}, status)); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'atrius-health-patient-access')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed successful discovery without trying metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ authorization_endpoint: provider.authorizationUrl })); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'atrius-health-patient-access')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects metadata that points its token endpoint at a local service', async () => {
    const unsafe = JSON.parse(JSON.stringify(metadata).replace(provider.tokenUrl, 'http://127.0.0.1/token'));
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(unsafe)); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'atrius-health-patient-access')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
