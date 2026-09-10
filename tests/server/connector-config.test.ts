import { describe, expect, it } from 'vitest';
import { connectorConfig, connectorRedirectUri } from '../../src/server/config';
import { withBundledConnections } from '../helpers/connector-env';

const env = { APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(32),
  EPIC_CLIENT_ID: 'epic-client', ATRIUS_CLIENT_SECRET: 'atrius-secret', BCH_CLIENT_SECRET: 'bch-secret',
  CIGNA_PATIENT_ACCESS_CLIENT_ID: 'cigna-client', CIGNA_CLIENT_SECRET: 'cigna-secret',
  AETNA_PATIENT_ACCESS_CLIENT_ID: 'aetna-client', AETNA_CLIENT_SECRET: 'aetna-secret' };

describe('connector registration configuration', () => {
  it('shares the Epic client ID while keeping organization endpoints and secret bindings independent', () => {
    expect(connectorConfig(env, 'atrius-health-patient-access')).toMatchObject({ organizationId: 'atrius-health', name: 'Atrius Health',
      clientId: env.EPIC_CLIENT_ID, clientSecret: env.ATRIUS_CLIENT_SECRET, tokenAuthMethod: 'client_secret_basic',
      base: 'https://iatrius.atriushealth.org/FHIR/api/FHIR/R4', configured: true, enabled: true });
    expect(connectorConfig(env, 'bch-patient-access')).toMatchObject({ clientId: env.EPIC_CLIENT_ID, clientSecret: env.BCH_CLIENT_SECRET,
      tokenAuthMethod: 'client_secret_basic', base: 'https://epicproxy.et1351.epichosted.com/APIProxyPRD/HOME/api/FHIR/R4', enabled: true });
    expect(connectorConfig({ ...env, ATRIUS_CLIENT_SECRET: '', EPIC_CLIENT_SECRET: 'stale-shared-secret' }, 'atrius-health-patient-access'))
      .toMatchObject({ clientSecret: '', configured: false, enabled: false });
    expect(connectorConfig({ ...env, ATRIUS_CLIENT_SECRET: '' }, 'bch-patient-access')).toMatchObject({ clientSecret: env.BCH_CLIENT_SECRET, enabled: true });
  });

  it.each(['atrius-health-patient-access', 'bch-patient-access'])('requires the shared Epic client ID for %s without organization fallbacks', id => {
    for (const value of [undefined, '', ' ']) {
      expect(connectorConfig({ ...env, EPIC_CLIENT_ID: value, ATRIUS_CLIENT_ID: 'stale-atrius-client', BCH_CLIENT_ID: 'stale-bch-client' }, id))
        .toMatchObject({ configured: false, enabled: false });
    }
  });

  it.each([['cigna-patient-access', 'CIGNA'], ['aetna-patient-access', 'AETNA']])('uses only the patient access client ID for %s', (id, prefix) => {
    const binding = `${prefix}_PATIENT_ACCESS_CLIENT_ID`;
    const settings = { ...env, [`${prefix}_CLIENT_ID`]: 'old-organization-client',
      [`${prefix}_PAYER_TO_PAYER_CLIENT_ID`]: 'transfer-client', [`${prefix}_PROVIDER_DIRECTORY_CLIENT_ID`]: 'directory-client' };
    expect(connectorConfig({ ...settings, [binding]: 'patient-access-client' }, id)).toMatchObject({
      apiType: 'patient_access', clientId: 'patient-access-client', configured: true, enabled: true });
    for (const value of [undefined, '', ' ']) {
      expect(connectorConfig({ ...settings, [binding]: value }, id)).toMatchObject({
        configured: false, enabled: false, unavailableReason: expect.stringContaining('client ID') });
    }
  });

  it('uses reviewed registration metadata even when stale per-connector environment variables remain', () => {
    const settings = { ...env, ATRIUS_FHIR_BASE_URL: 'https://wrong.example/fhir', EPIC_FHIR_BASE_URL: '',
      ATRIUS_AUTHORIZATION_URL: 'https://wrong.example/authorize', ATRIUS_TOKEN_URL: 'https://wrong.example/token',
      ATRIUS_SCOPES: 'offline_access patient/*.write', ATRIUS_TOKEN_AUTH_METHOD: 'none', ATRIUS_RESPONSE_MODE: 'form_post',
      ATRIUS_REDIRECT_URI: 'https://wrong.example/callback', EPIC_REDIRECT_URI: `${env.APP_ORIGIN}/auth/callback` };
    expect(connectorConfig(settings, 'atrius-health-patient-access')).toEqual(connectorConfig(env, 'atrius-health-patient-access'));
    expect(connectorRedirectUri(settings, 'atrius-health-patient-access', env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/atrius-health-patient-access`);
  });

  it('uses exact registered authentication methods and permits an explicitly public registration', () => {
    expect(connectorConfig(env, 'cigna-patient-access')).toMatchObject({ tokenAuthMethod: 'client_secret_post', enabled: true });
    expect(connectorConfig({ ...env, CIGNA_CLIENT_SECRET: '' }, 'cigna-patient-access')).toMatchObject({ tokenAuthMethod: 'client_secret_post', enabled: false });
    const settings = withBundledConnections(env, { 'atrius-health': { tokenAuthMethod: 'none', clientSecretEnv: undefined } });
    expect(connectorConfig(settings, 'atrius-health-patient-access')).toMatchObject({ tokenAuthMethod: 'none', clientSecret: '', enabled: true });
  });

  it.each([
    [{ CIGNA_PATIENT_ACCESS_CLIENT_ID: '' }, {}, 'client ID'],
    [{}, { fhirBaseUrl: '' }, 'FHIR API address is missing'],
    [{}, { fhirBaseUrl: 'http://localhost/fhir' }, 'public HTTPS'],
    [{ CIGNA_CLIENT_SECRET: '' }, {}, 'client secret'],
    [{ PATIENT_PROCESSING_APPROVED: 'false' }, {}, 'not been enabled'],
    [{ SESSION_SIGNING_KEY: 'short' }, {}, 'Secure connection sessions'],
  ] as const)('explains missing configuration without credential values', (bindings, metadata, reason) => {
    const config = connectorConfig(withBundledConnections({ ...env, ...bindings }, { cigna: metadata }), 'cigna-patient-access');
    expect(config.enabled).toBe(false);
    expect(config.unavailableReason).toContain(reason);
    expect(config.unavailableReason).not.toContain('short');
  });

  it.each([
    [{ scopes: '' }, 'permissions'],
    [{ scopes: 'patient/*.read offline_access' }, 'permissions'],
    [{ authorizationUrl: 'https://provider.example/authorize' }, 'configured together'],
    [{ authorizationUrl: 'http://localhost/authorize', tokenUrl: 'https://provider.example/token' }, 'secure connection configuration'],
  ] as const)('rejects incomplete or unsupported registration metadata with safe errors', (metadata, message) => {
    expect(() => connectorConfig(withBundledConnections(env, { 'atrius-health': metadata }), 'atrius-health-patient-access')).toThrow(message);
  });

  it.each(['private_key_jwt', ''])('rejects unsupported registered token authentication %j', tokenAuthMethod => {
    expect(() => withBundledConnections(env, { 'atrius-health': { tokenAuthMethod } })).toThrow('registry');
  });
});

describe('registered redirect URI', () => {
  it('derives the callback on the canonical application origin', () => {
    expect(connectorRedirectUri(env, 'cigna-patient-access', 'https://request.example')).toBe(`${env.APP_ORIGIN}/oauth/callback/cigna-patient-access`);
  });

  it.each(['/auth/callback', '/auth/callback/atrius-health-patient-access', '/oauth/callback/atrius-health-patient-access'])('uses an explicitly registered Atrius callback path %s', path => {
    const redirectUri = `${env.APP_ORIGIN}${path}`;
    expect(connectorRedirectUri(withBundledConnections(env, { 'atrius-health': { redirectUri } }), 'atrius-health-patient-access', env.APP_ORIGIN)).toBe(redirectUri);
  });

  it('supports explicit development callbacks and defaults a blank callback to the derived route', () => {
    const settings = withBundledConnections({ APP_ENV: 'development', APP_ORIGIN: 'http://localhost:3000' }, {
      'atrius-health': { redirectUri: 'http://localhost:3000/auth/callback' } });
    expect(connectorRedirectUri(settings, 'atrius-health-patient-access', 'http://localhost:3000')).toBe('http://localhost:3000/auth/callback');
    expect(connectorRedirectUri(withBundledConnections(env, { 'atrius-health': { redirectUri: '' } }), 'atrius-health-patient-access', env.APP_ORIGIN))
      .toBe(`${env.APP_ORIGIN}/oauth/callback/atrius-health-patient-access`);
  });

  it.each([
    'https://attacker.example/oauth/callback/atrius-health-patient-access',
    'https://app.example/oauth/callback/cigna-patient-access',
    'https://app.example/auth/callback/bch-patient-access',
    'https://app.example/arbitrary',
    'https://user:password@app.example/oauth/callback/atrius-health-patient-access',
    'https://app.example/oauth/callback/atrius-health-patient-access?redirect=https://other.example',
    'https://app.example/oauth/callback/atrius-health-patient-access#fragment',
    '/oauth/callback/atrius-health-patient-access',
  ])('rejects a callback outside registered application paths: %s', redirectUri => {
    expect(() => connectorRedirectUri(withBundledConnections(env, { 'atrius-health': { redirectUri } }), 'atrius-health-patient-access', env.APP_ORIGIN)).toThrow('callback address');
  });

  it.each(['cigna', 'bch'])('does not assign the legacy Atrius callback to %s', organizationId => {
    const settings = withBundledConnections(env, { [organizationId]: { redirectUri: `${env.APP_ORIGIN}/auth/callback` } });
    expect(() => connectorRedirectUri(settings, `${organizationId}-patient-access`, env.APP_ORIGIN)).toThrow('callback address');
  });
});
