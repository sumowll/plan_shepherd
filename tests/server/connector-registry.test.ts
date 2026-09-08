import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../../src/server/index';
import { connectorConfig, connectorRedirectUri } from '../../src/server/config';
import { connectorDefinition, connectorEnvironmentKeys, connectorRegistry } from '../../src/server/connector-registry';

const registration = {
  id: 'north-hospital', name: 'North Hospital', kind: 'provider',
  fhirBaseUrl: 'https://north.example/fhir', clientIdEnv: 'NORTH_CLIENT_ID', clientSecretEnv: 'NORTH_CLIENT_SECRET',
  authorizationUrl: 'https://north.example/authorize', tokenUrl: 'https://north.example/token',
};
const env = { APP_ENV: 'development', APP_ORIGIN: 'https://app.example',
  PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(48),
  NORTH_CLIENT_ID: 'synthetic-north-client', NORTH_CLIENT_SECRET: 'synthetic-north-secret',
  CONNECTOR_REGISTRY: JSON.stringify([registration]),
};
afterEach(() => vi.unstubAllGlobals());

describe('configuration registry', () => {
  it('resolves an arbitrary registration and its exact callback without vendor branches', () => {
    expect(connectorConfig(env, registration.id)).toMatchObject({ id: registration.id, name: registration.name,
      kind: 'provider', scopeProfile: 'smart', configured: true, enabled: true,
      clientId: env.NORTH_CLIENT_ID, clientSecret: env.NORTH_CLIENT_SECRET,
      resources: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'],
    });
    expect(connectorRedirectUri(env, registration.id, 'https://untrusted.example')).toBe(`${env.APP_ORIGIN}/oauth/callback/north-hospital`);
    expect(connectorEnvironmentKeys(env)).toEqual({ runtimeKeys: ['NORTH_CLIENT_ID', 'NORTH_CLIENT_SECRET'], secretKeys: ['NORTH_CLIENT_SECRET'] });
  });

  it('uses a payer resource set independently of the connection ID or scope profile', () => {
    const settings = { ...env, CONNECTOR_REGISTRY: JSON.stringify([{ ...registration, kind: 'payer' }]) };
    expect(connectorConfig(settings, registration.id).resources).toEqual(['Patient', 'ExplanationOfBenefit']);
  });

  it('does not silently treat a missing declared client secret as a public registration', () => {
    expect(connectorConfig({ ...env, NORTH_CLIENT_SECRET: '' }, registration.id)).toMatchObject({
      tokenAuthMethod: 'client_secret_basic', configured: false, enabled: false, unavailableReason: expect.stringContaining('client secret'),
    });
  });

  it('does not inherit removed legacy integrations when a registry override is supplied', () => {
    expect(connectorRegistry({ ...env, CONNECTOR_REGISTRY: '[]' })).toEqual([]);
    expect(() => connectorConfig(env, 'atrius')).toThrow('not registered');
    expect(connectorRegistry({}).map(entry => entry.id)).toEqual(['atrius', 'bch', 'cigna']);
  });

  it('retains the exact registered spelling after validating the origin and path', () => {
    const redirectUri = 'https://APP.example:443/oauth/callback/north-hospital';
    expect(connectorRedirectUri({ ...env, CONNECTOR_REGISTRY: JSON.stringify([{ ...registration, redirectUri }]) }, registration.id, env.APP_ORIGIN)).toBe(redirectUri);
  });

  it.each([
    '', '{}', 'null', 'malformed-json',
    JSON.stringify([registration, registration]),
    JSON.stringify([{ ...registration, id: '../token' }]),
    JSON.stringify([{ ...registration, id: 'north%2fhospital' }]),
    JSON.stringify([{ ...registration, clientSecret: 'mistaken-secret' }]),
    JSON.stringify([{ ...registration, clientId: 'ambiguous' }]),
    JSON.stringify([{ ...registration, clientIdEnv: 'NORTH_CLIENT_SECRET' }]),
    JSON.stringify([{ ...registration, clientIdEnv: 'SESSION_SIGNING_KEY' }]),
    JSON.stringify([{ ...registration, resources: ['Encounter'] }]),
    JSON.stringify([{ ...registration, resources: ['Patient', 'Patient'] }]),
    JSON.stringify([{ ...registration, resources: ['Patient', 'DocumentReference'] }]),
    JSON.stringify([{ ...registration, legacyCallbackPath: '/auth/callback' }, { ...registration, id: 'south', legacyCallbackPath: '/auth/callback' }]),
  ])('fails closed with a safe registry error for invalid configuration %#', CONNECTOR_REGISTRY => {
    expect(() => connectorRegistry({ ...env, CONNECTOR_REGISTRY })).toThrow('Connection registry settings need attention.');
  });

  it('rejects a binding used as a secret in one entry and as a public client ID in another', () => {
    expect(() => connectorRegistry({ CONNECTOR_REGISTRY: [registration, { ...registration, id: 'south', clientIdEnv: 'NORTH_CLIENT_SECRET' }] })).toThrow('registry');
  });

  it.each(['SESSION_SIGNING_KEY', 'AI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'SHORT_TERM_FEED_TOKEN', 'APP_ORIGIN', 'CONNECTOR_REGISTRY'])(
    'rejects unrelated application binding %s as either credential before exposing or sending it', key => {
      for (const field of ['clientIdEnv', 'clientSecretEnv']) {
        expect(() => connectorRegistry({ CONNECTOR_REGISTRY: [{ ...registration, [field]: key }] })).toThrow('registry');
      }
    },
  );

  it('never guesses configuration for syntactically valid but unknown IDs', () => {
    expect(() => connectorDefinition({ ...env, UNKNOWN_CLIENT_ID: 'not-a-registration' }, 'unknown')).toThrow('not registered');
  });
});

describe('registry-backed routes', () => {
  it('publishes display metadata and only safe authorization fields', async () => {
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, env);
    const publicStatus = await status.text();
    expect(status.status).toBe(200);
    expect(JSON.parse(publicStatus).connectors).toEqual([{ id: registration.id, name: registration.name, kind: 'provider', configured: true, enabled: true }]);
    expect(publicStatus).not.toContain(env.NORTH_CLIENT_ID);
    const authorize = await app.request(`${env.APP_ORIGIN}/api/connectors/${registration.id}/authorize`, {}, env);
    const publicAuthorization = await authorize.text();
    expect(authorize.status).toBe(200);
    expect(JSON.parse(publicAuthorization)).toMatchObject({ name: registration.name, clientId: env.NORTH_CLIENT_ID,
      redirectUri: `${env.APP_ORIGIN}/oauth/callback/${registration.id}`, resources: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'] });
    for (const content of [publicStatus, publicAuthorization]) {
      expect(content).not.toContain(env.NORTH_CLIENT_SECRET);
      expect(content).not.toContain(env.SESSION_SIGNING_KEY);
      expect(content).not.toContain('clientSecretEnv');
    }
  });

  it.each(['authorize', 'token', 'resource', 'references', 'callback'])('rejects an unknown %s connection before upstream I/O', async action => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const path = action === 'callback' ? '/oauth/callback/unknown' : `/api/connectors/unknown/${action}`;
    const response = await app.request(`${env.APP_ORIGIN}${path}`, ['authorize', 'callback'].includes(action) ? {} : { method: 'POST' }, env);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps disabled entries visible while blocking sign-in before discovery', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const settings = { ...env, CONNECTOR_REGISTRY: JSON.stringify([{ ...registration, enabled: false }]) };
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    const body = await status.json() as { connectors: unknown[]; issues: string[] };
    expect(body).toMatchObject({ connectors: [{ id: registration.id, enabled: false, reason: expect.stringContaining('disabled') }] });
    expect(body.issues).not.toContain(`${registration.name} is not connected.`);
    expect((await app.request(`${env.APP_ORIGIN}/api/connectors/${registration.id}/authorize`, {}, settings)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'])('delivers a custom registration %s callback to the selected connector', async method => {
    const params = new URLSearchParams({ state: 'opaque-state', code: 'synthetic-code' });
    const response = await app.request(`${env.APP_ORIGIN}/oauth/callback/${registration.id}${method === 'GET' ? `?${params}` : ''}`,
      method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('"connector":"north-hospital"');
    expect(html).toContain(`,"${env.APP_ORIGIN}")`);
    expect(html).toContain("history.replaceState(null,'','/oauth/complete')");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a callback sent to the wrong origin and a legacy alias absent from the registry', async () => {
    expect((await app.request(`https://wrong.example/oauth/callback/${registration.id}?code=synthetic`, {}, env)).status).toBe(400);
    expect((await app.request(`${env.APP_ORIGIN}/auth/callback?code=synthetic`, {}, env)).status).toBe(404);
  });

  it('returns a safe service error for an invalid registry', async () => {
    const response = await app.request(`${env.APP_ORIGIN}/api/status`, {}, { ...env, CONNECTOR_REGISTRY: '[{"clientSecret":"mistaken-secret"}]' });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('mistaken-secret');
  });

  it.each(['json', 'array'])('lists thousands of integrations from %s and resolves the last entry without provider-specific code', async format => {
    const records = Array.from({ length: 2000 }, (_, index) => ({ id: `hospital-${index}`, name: `Hospital ${index}`, kind: 'provider',
      clientId: `public-client-${index}`, fhirBaseUrl: `https://hospital-${index}.example/fhir`,
      authorizationUrl: `https://hospital-${index}.example/authorize`, tokenUrl: `https://hospital-${index}.example/token`,
    }));
    const settings = { ...env, CONNECTOR_REGISTRY: format === 'json' ? JSON.stringify(records) : records };
    expect(connectorRegistry(settings)).toBe(connectorRegistry(settings));
    const status = await app.request(`${env.APP_ORIGIN}/api/status`, {}, settings);
    const body = await status.json() as { connectors: unknown[] };
    expect(body.connectors).toHaveLength(2000);
    expect(connectorRedirectUri(settings, 'hospital-1999', env.APP_ORIGIN)).toBe(`${env.APP_ORIGIN}/oauth/callback/hospital-1999`);
    const authorize = await app.request(`${env.APP_ORIGIN}/api/connectors/hospital-1999/authorize`, {}, settings);
    expect(await authorize.json()).toMatchObject({ clientId: 'public-client-1999', audience: 'https://hospital-1999.example/fhir' });
  });
});
