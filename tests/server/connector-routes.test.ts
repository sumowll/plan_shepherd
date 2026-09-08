import { describe, expect, it } from 'vitest';
import app from '../../src/server/index';

const env = {
  APP_ENV: 'development', APP_ORIGIN: 'http://localhost:3000', EPIC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  EPIC_CLIENT_ID: 'synthetic-epic-client', EPIC_CLIENT_SECRET: 'synthetic-epic-secret', EPIC_TOKEN_AUTH_METHOD: 'client_secret_basic',
  ATRIUS_AUTHORIZATION_URL: 'https://provider.example/authorize', ATRIUS_TOKEN_URL: 'https://provider.example/token',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(48),
};

describe('connector launch routes', () => {
  it('identifies the Cigna sandbox so users can distinguish test records from their own claims', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, { ...env, CIGNA_CLIENT_ID: 'synthetic-cigna-client', CIGNA_FHIR_BASE_URL: 'https://fhir.cigna.com/PatientAccess/v1-devportal/' });
    const body = await response.json() as { connectors: { id: string; testEnvironment?: boolean }[] };
    expect(body.connectors.find(item => item.id === 'cigna')).toMatchObject({ testEnvironment: true });
    expect(body.connectors.find(item => item.id === 'atrius')?.testEnvironment).toBeUndefined();
  });
  it('provides the exact registered legacy callback while excluding all server credentials', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/connectors/atrius/authorize`, {}, env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ redirectUri: env.EPIC_REDIRECT_URI, clientId: env.EPIC_CLIENT_ID });
    expect(body).not.toContain(env.EPIC_CLIENT_SECRET);
    expect(body).not.toContain(env.SESSION_SIGNING_KEY);
  });

  it('redirects a local launch to the registered origin and rejects OAuth launch on a mismatched origin', async () => {
    const page = await app.request('http://127.0.0.1:5173/', {}, env);
    expect(page.status).toBe(302); expect(page.headers.get('Location')).toBe(`${env.APP_ORIGIN}/`);
    const authorize = await app.request('http://127.0.0.1:5173/api/connectors/atrius/authorize', {}, env);
    expect(authorize.status).toBe(409);
    expect(await authorize.json()).toMatchObject({ error: { code: 'app_origin_mismatch' } });
  });

  it.each(['GET', 'POST'])('returns the legacy Epic %s callback to the same opener as the standard route', async method => {
    const values = new URLSearchParams({ state: 'expected-state', code: 'synthetic-code' });
    const response = await app.request(`${env.EPIC_REDIRECT_URI}${method === 'GET' ? `?${values}` : ''}`, method === 'POST' ? { method, body: values, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('"connector":"atrius"');
    expect(html).toContain(`,"${env.APP_ORIGIN}")`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('explains missing setup without exposing credentials or treating enabled as connected', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, { ...env, SESSION_SIGNING_KEY: '' });
    const body = await response.text();
    expect(JSON.parse(body).connectors[0]).toMatchObject({ configured: true, enabled: false, reason: expect.any(String) });
    expect(body).not.toContain('Awaiting approved connection configuration');
    expect(body).not.toContain(env.EPIC_CLIENT_SECRET);
    expect(body).not.toContain(env.EPIC_CLIENT_ID);
  });
});

describe('BCH callback', () => {
  const settings = { APP_ENV: 'development', APP_ORIGIN: 'https://fhir.moonbacare.com' };
  const callback = `${settings.APP_ORIGIN}/auth/callback/bch`;

  it.each(['GET', 'POST'])('returns the registered %s callback to the application', async method => {
    const values = new URLSearchParams({ state: 'expected-state', code: 'synthetic-code' });
    const response = await app.request(`${callback}${method === 'GET' ? `?${values}` : ''}`,
      method === 'POST' ? { method, body: values, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}, settings);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('"connector":"bch"');
    expect(html).toContain('"code":"synthetic-code"');
    expect(html).toContain('"state":"expected-state"');
    expect(html).toContain(`,"${settings.APP_ORIGIN}")`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it.each([
    ['https://wrong.example/auth/callback/bch', 400],
    [`${settings.APP_ORIGIN}/oauth/callback/bch`, 400],
    [`${settings.APP_ORIGIN}/auth/callback/unknown`, 404],
  ])('rejects an unregistered callback address: %s', async (url, status) => {
    expect((await app.request(url, {}, settings)).status).toBe(status);
  });

  it('applies callback rate limiting', async () => {
    const response = await app.request(callback, {}, { ...settings, API_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });
});
