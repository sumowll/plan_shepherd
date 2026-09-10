import { withBundledConnections } from '../helpers/connector-env';
import { describe, expect, it } from 'vitest';
import { bundledConnectionId } from '../helpers/connection-identity';
import app from '../../src/server/index';

const legacyCallback = 'http://localhost:3000/auth/callback';
const env = withBundledConnections({ APP_ENV: 'development', APP_ORIGIN: 'http://localhost:3000',
  EPIC_CLIENT_ID: 'synthetic-epic-client', ATRIUS_CLIENT_SECRET: 'synthetic-atrius-secret',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 'synthetic-signing-key-at-least-32-characters',
}, { 'atrius-health': { redirectUri: legacyCallback, authorizationUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token' } });

describe('connector launch routes', () => {
  it('identifies the Cigna sandbox so users can distinguish test records from their own claims', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, withBundledConnections({ ...env, CIGNA_PATIENT_ACCESS_CLIENT_ID: 'synthetic-cigna-client', CIGNA_CLIENT_SECRET: 'synthetic-cigna-secret' }, { cigna: { fhirBaseUrl: 'https://fhir.cigna.com/PatientAccess/v1-devportal/' } }));
    const body = await response.json() as { connectors: { id: string; key: string; testEnvironment?: boolean }[] };
    expect(body.connectors.find(item => item.key === 'cigna-patient-access')).toMatchObject({ testEnvironment: true });
    expect(body.connectors.find(item => item.key === 'atrius-health-patient-access')?.testEnvironment).toBeUndefined();
  });
  it('provides the exact registered legacy callback while excluding all server credentials', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/connectors/atrius-health-patient-access/authorize`, {}, env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ connectionId: bundledConnectionId('atrius-health-patient-access'), name: 'Atrius Health', redirectUri: legacyCallback, clientId: env.EPIC_CLIENT_ID });
    expect(body).not.toContain(env.ATRIUS_CLIENT_SECRET);
    expect(body).not.toContain(env.SESSION_SIGNING_KEY);
  });

  it('redirects a local launch to the registered origin and rejects OAuth launch on a mismatched origin', async () => {
    const page = await app.request('http://127.0.0.1:5173/', {}, env);
    expect(page.status).toBe(302); expect(page.headers.get('Location')).toBe(`${env.APP_ORIGIN}/`);
    const authorize = await app.request('http://127.0.0.1:5173/api/connectors/atrius-health-patient-access/authorize', {}, env);
    expect(authorize.status).toBe(409);
    expect(await authorize.json()).toMatchObject({ error: { code: 'app_origin_mismatch' } });
  });

  it.each(['GET', 'POST'])('returns the legacy %s callback with the canonical Atrius connection identity', async method => {
    const values = new URLSearchParams({ state: 'expected-state', code: 'synthetic-code' });
    const response = await app.request(`${legacyCallback}${method === 'GET' ? `?${values}` : ''}`, method === 'POST' ? { method, body: values, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`"connector":"${bundledConnectionId('atrius-health-patient-access')}"`);
    expect(html).toContain(`,"${env.APP_ORIGIN}")`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('explains missing setup without exposing credentials or treating enabled as connected', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, { ...env, SESSION_SIGNING_KEY: '' });
    const body = await response.text();
    expect(JSON.parse(body).connectors[0]).toMatchObject({ configured: true, enabled: false, reason: expect.any(String) });
    expect(body).not.toContain('Awaiting approved connection configuration');
    expect(body).not.toContain(env.ATRIUS_CLIENT_SECRET);
    expect(body).not.toContain(env.EPIC_CLIENT_ID);
  });
});

describe('BCH callback', () => {
  const settings = withBundledConnections({ APP_ENV: 'development', APP_ORIGIN: 'https://fhir.moonbacare.com' }, { bch: { redirectUri: 'https://fhir.moonbacare.com/auth/callback/bch-patient-access' } });
  const callback = `${settings.APP_ORIGIN}/auth/callback/bch-patient-access`;

  it.each(['GET', 'POST'])('returns the registered %s callback to the application', async method => {
    const values = new URLSearchParams({ state: 'expected-state', code: 'synthetic-code' });
    const response = await app.request(`${callback}${method === 'GET' ? `?${values}` : ''}`,
      method === 'POST' ? { method, body: values, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}, settings);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`"connector":"${bundledConnectionId('bch-patient-access')}"`);
    expect(html).toContain('"code":"synthetic-code"');
    expect(html).toContain('"state":"expected-state"');
    expect(html).toContain(`,"${settings.APP_ORIGIN}")`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it.each([
    ['https://wrong.example/auth/callback/bch-patient-access', 400],
    [`${settings.APP_ORIGIN}/oauth/callback/bch-patient-access`, 400],
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
