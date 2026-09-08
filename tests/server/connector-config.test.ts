import { describe, expect, it } from 'vitest';
import { connectorConfig, connectorRedirectUri } from '../../src/server/config';

const env = { APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(32) };

describe('connector registration configuration', () => {
  it('recognizes existing Epic registration names and keeps credentials on server configuration', () => {
    expect(connectorConfig({ ...env, EPIC_CLIENT_ID: 'epic-client', EPIC_CLIENT_SECRET: 'epic-secret', EPIC_RESPONSE_MODE: 'form_post' }, 'atrius')).toMatchObject({
      clientId: 'epic-client', clientSecret: 'epic-secret', tokenAuthMethod: 'client_secret_basic', responseMode: 'form_post', configured: true, enabled: true,
    });
  });

  it('prefers canonical Atrius settings, including explicitly blank values', () => {
    expect(connectorConfig({ ...env, EPIC_CLIENT_ID: 'old-client', ATRIUS_CLIENT_ID: 'new-client', EPIC_CLIENT_SECRET: 'old-secret', ATRIUS_CLIENT_SECRET: '' }, 'atrius')).toMatchObject({ clientId: 'new-client', clientSecret: '', tokenAuthMethod: 'none', enabled: true });
    expect(connectorConfig({ ...env, EPIC_CLIENT_ID: 'old-client', ATRIUS_CLIENT_ID: '' }, 'atrius')).toMatchObject({ clientId: '', configured: false, enabled: false });
  });

  it('uses each vendor’s secret authentication default and permits explicit public PKCE registration', () => {
    expect(connectorConfig({ ...env, CIGNA_CLIENT_ID: 'payer', CIGNA_CLIENT_SECRET: 'secret', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir' }, 'cigna')).toMatchObject({ tokenAuthMethod: 'client_secret_post', enabled: true });
    expect(connectorConfig({ ...env, ATRIUS_CLIENT_ID: 'provider', ATRIUS_CLIENT_SECRET: 'unused', ATRIUS_TOKEN_AUTH_METHOD: 'none' }, 'atrius')).toMatchObject({ tokenAuthMethod: 'none', enabled: true });
  });

  it.each([
    [{}, 'client ID'],
    [{ CIGNA_CLIENT_ID: 'payer' }, 'FHIR API address is missing'],
    [{ CIGNA_CLIENT_ID: 'payer', CIGNA_FHIR_BASE_URL: 'http://localhost/fhir' }, 'public HTTPS'],
    [{ CIGNA_CLIENT_ID: 'payer', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir', CIGNA_TOKEN_AUTH_METHOD: 'client_secret_basic' }, 'client secret'],
    [{ CIGNA_CLIENT_ID: 'payer', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir', PATIENT_PROCESSING_APPROVED: 'false' }, 'not been enabled'],
    [{ CIGNA_CLIENT_ID: 'payer', CIGNA_FHIR_BASE_URL: 'https://payer.example/fhir', SESSION_SIGNING_KEY: 'short' }, 'Secure connection sessions'],
  ])('explains the missing configuration without including credential values', (settings, reason) => {
    const config = connectorConfig({ ...env, ...settings }, 'cigna');
    expect(config.enabled).toBe(false);
    expect(config.unavailableReason).toContain(reason);
    expect(config.unavailableReason).not.toContain('short');
  });

  it.each([
    [{ ATRIUS_TOKEN_AUTH_METHOD: 'private_key_jwt' }, 'authentication method'],
    [{ ATRIUS_TOKEN_AUTH_METHOD: '', EPIC_TOKEN_AUTH_METHOD: 'none' }, 'authentication method'],
    [{ ATRIUS_SCOPES: '' }, 'permissions'],
    [{ ATRIUS_SCOPES: 'patient/*.read offline_access' }, 'permissions'],
    [{ ATRIUS_AUTHORIZATION_URL: 'https://provider.example/authorize' }, 'configured together'],
    [{ ATRIUS_AUTHORIZATION_URL: 'http://localhost/authorize', ATRIUS_TOKEN_URL: 'https://provider.example/token' }, 'secure connection configuration'],
  ])('rejects incomplete or unsupported registration settings with safe errors', (settings, message) => {
    expect(() => connectorConfig({ ...env, ATRIUS_CLIENT_ID: 'provider', ...settings }, 'atrius')).toThrow(message);
  });
});

describe('registered redirect URI', () => {
  it('defaults to the connector callback on the canonical app origin', () => {
    expect(connectorRedirectUri(env, 'cigna', 'https://request.example')).toBe('https://app.example/oauth/callback/cigna');
  });

  it('supports the existing Epic callback and canonical overrides', () => {
    expect(connectorRedirectUri({ ...env, EPIC_REDIRECT_URI: 'https://app.example/auth/callback' }, 'atrius', env.APP_ORIGIN)).toBe('https://app.example/auth/callback');
    expect(connectorRedirectUri({ ...env, EPIC_REDIRECT_URI: 'https://app.example/auth/callback', ATRIUS_REDIRECT_URI: '' }, 'atrius', env.APP_ORIGIN)).toBe('https://app.example/oauth/callback/atrius');
    expect(connectorRedirectUri({ APP_ENV: 'development', EPIC_REDIRECT_URI: 'http://localhost:3000/auth/callback' }, 'atrius', 'http://localhost:3000')).toBe('http://localhost:3000/auth/callback');
  });

  it.each([
    'https://attacker.example/oauth/callback/atrius',
    'https://app.example/oauth/callback/cigna',
    'https://app.example/arbitrary',
    'https://user:password@app.example/oauth/callback/atrius',
    'https://app.example/oauth/callback/atrius?redirect=https://other.example',
    'https://app.example/oauth/callback/atrius#fragment',
    '/oauth/callback/atrius',
  ])('rejects a callback outside the registered application paths: %s', redirect => {
    expect(() => connectorRedirectUri({ ...env, ATRIUS_REDIRECT_URI: redirect }, 'atrius', env.APP_ORIGIN)).toThrow('callback address');
  });

  it('does not assign the shared Epic callback to Cigna', () => {
    expect(() => connectorRedirectUri({ ...env, CIGNA_REDIRECT_URI: 'https://app.example/auth/callback' }, 'cigna', env.APP_ORIGIN)).toThrow('callback address');
  });
});
