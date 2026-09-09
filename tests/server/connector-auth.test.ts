import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverConnector, exchangeCode } from '../../src/connectors/transport';
import { connectorConfig } from '../../src/server/config';

const env = {
  APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(32),
  EPIC_CLIENT_ID: 'provider-client', EPIC_FHIR_BASE_URL: 'https://provider.example/fhir',
  EPIC_AUTHORIZATION_URL: 'https://provider.example/authorize', EPIC_TOKEN_URL: 'https://provider.example/token',
  CIGNA_CLIENT_ID: 'payer-client', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir',
  CIGNA_AUTHORIZATION_URL: 'https://payer.example/authorize', CIGNA_TOKEN_URL: 'https://payer.example/token',
};
const input = { code: 'one-time-code', verifier: 'v'.repeat(43) };
const token = { access_token: 'synthetic-access', token_type: 'Bearer', patient: 'authorized-patient', expires_in: 600 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const metadata = {
  resourceType: 'CapabilityStatement', rest: [{ mode: 'server', security: { extension: [{
    url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
    extension: [{ url: 'authorize', valueUri: env.EPIC_AUTHORIZATION_URL }, { url: 'token', valueUri: env.EPIC_TOKEN_URL }],
  }] } }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('server-side authorization code exchange', () => {
  it.each(['none', 'client_secret_basic', 'client_secret_post'])('sends exactly one configured authentication method: %s', method => {
    const fetch = vi.fn().mockResolvedValue(json(token)); vi.stubGlobal('fetch', fetch);
    return exchangeCode({ ...env, EPIC_CLIENT_ID: 'client:with space', EPIC_CLIENT_SECRET: 'secret:+/é', EPIC_TOKEN_AUTH_METHOD: method, EPIC_REDIRECT_URI: 'https://app.example/auth/callback' }, 'epic', input, env.APP_ORIGIN).then(result => {
      const [target, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(String(options.body));
      const headers = new Headers(options.headers);
      expect(target).toBe(env.EPIC_TOKEN_URL);
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
    const result = await exchangeCode({ ...env, CIGNA_CLIENT_SECRET: 'payer-secret' }, 'cigna', input, env.APP_ORIGIN);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(new URLSearchParams(String(options.body)).get('client_secret')).toBe('payer-secret');
    expect(new Headers(options.headers).has('Authorization')).toBe(false);
    expect(result.patientId).toBe(token.patient);
    expect(result.scopes).toBe('search read openid');
  });

  it('never sends an authorization code when the callback or secret is misconfigured', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(exchangeCode({ ...env, EPIC_REDIRECT_URI: 'https://other.example/auth/callback' }, 'epic', input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'connector_configuration_invalid' });
    await expect(exchangeCode({ ...env, EPIC_TOKEN_AUTH_METHOD: 'client_secret_basic' }, 'epic', input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'connector_not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts documented Epic resource operation grants and whitespace without broadening requested scopes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, scope: ' Patient.read Patient.search Encounter.read  ' })));
    const result = await exchangeCode(env, 'epic', input, env.APP_ORIGIN);
    expect(result.scopes).toBe('Patient.read Patient.search Encounter.read');
    expect(() => connectorConfig({ ...env, EPIC_SCOPES: 'Patient.read Patient.search' }, 'epic')).toThrow();
    expect(() => connectorConfig({ ...env, CIGNA_SCOPES: 'search read openid' }, 'cigna')).toThrow();
  });

  it.each([
    ['epic', 'Patient.write'], ['epic', 'Patient.create'], ['epic', 'system/Patient.read'],
    ['epic', 'read search'], ['cigna', 'Patient.read'], ['cigna', 'search read write openid'],
    ['cigna', 'offline_access search read'], ['epic', ''], ['cigna', '   '],
  ] as const)('rejects unsupported granted scopes for %s: %s', async (id, scope) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, scope })));
    await expect(exchangeCode(env, id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it.each(['epic', 'cigna'] as const)('still requires a verified patient context with native grants for %s', async id => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...token, patient: undefined, scope: id === 'epic' ? 'Patient.read Patient.search ' : 'search read openid', id_token: 'unverified' })));
    await expect(exchangeCode(env, id, input, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'missing_patient_context' });
  });
});

describe('SMART endpoint discovery', () => {
  const discoveryEnv = { ...env, EPIC_AUTHORIZATION_URL: '', EPIC_TOKEN_URL: '' };

  it.each([404, 405])('falls back to FHIR capability metadata when well-known returns %s', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json(metadata)); vi.stubGlobal('fetch', fetch);
    expect(await discoverConnector(discoveryEnv, 'epic')).toMatchObject({ authorizationUrl: env.EPIC_AUTHORIZATION_URL, tokenUrl: env.EPIC_TOKEN_URL });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${env.EPIC_FHIR_BASE_URL}/.well-known/smart-configuration`, `${env.EPIC_FHIR_BASE_URL}/metadata`]);
    for (const call of fetch.mock.calls) expect(call[1].redirect).toBe('manual');
  });

  it('uses well-known endpoints when available and does not fetch metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ authorization_endpoint: env.EPIC_AUTHORIZATION_URL, token_endpoint: env.EPIC_TOKEN_URL })); vi.stubGlobal('fetch', fetch);
    expect(await discoverConnector(discoveryEnv, 'epic')).toMatchObject({ tokenUrl: env.EPIC_TOKEN_URL });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 503])('does not mask well-known failure %s with fallback discovery', async status => {
    const fetch = vi.fn().mockResolvedValue(json({}, status)); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'epic')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed successful discovery without trying metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ authorization_endpoint: env.EPIC_AUTHORIZATION_URL })); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'epic')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects metadata that points its token endpoint at a local service', async () => {
    const unsafe = JSON.parse(JSON.stringify(metadata).replace(env.EPIC_TOKEN_URL, 'http://127.0.0.1/token'));
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(unsafe)); vi.stubGlobal('fetch', fetch);
    await expect(discoverConnector(discoveryEnv, 'epic')).rejects.toMatchObject({ code: 'discovery_failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
