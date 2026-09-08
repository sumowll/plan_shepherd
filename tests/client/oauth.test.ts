// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { connectPatient, resetPatientSession } from '../../src/client/oauth';

let popup: Window;
let upstream: ReturnType<typeof vi.fn>;
const origin = window.location.origin;
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const resourceLists: Record<string, string[]> = {
  atrius: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense', 'Condition'],
  cigna: ['Patient', 'ExplanationOfBenefit'],
  'hospital-123': ['Patient', 'Encounter', 'Condition'],
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  popup = { closed: false, location: { href: 'about:blank' }, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(popup);
  upstream = vi.fn(async (url: string, init?: RequestInit) => {
    const id = decodeURIComponent(url.split('/')[3]);
    if (url.endsWith('/authorize')) return reply({ authorizationUrl: 'https://sign-in.example/authorize', clientId: 'synthetic-client', scopes: id === 'cigna' ? 'openid fhirUser patient/*.read' : 'launch/patient patient/*.read', audience: 'https://records.example/fhir', responseMode: 'query', redirectUri: `${origin}${id === 'atrius' ? '/auth/callback' : `/oauth/callback/${id}`}`, resources: resourceLists[id] });
    if (url.endsWith('/token')) return reply({ accessToken: 'synthetic-access', patientId: 'p1', receipt: 'synthetic-receipt' });
    if (url.endsWith('/resource')) {
      const input = JSON.parse(String(init?.body));
      return reply({ page: input.resource === 'Patient' ? { resourceType: 'Patient', id: 'p1', birthDate: '1980-01-01' } : { resourceType: 'Bundle', entry: [] }, references: [], referenceLimitReached: false });
    }
    throw new Error('Unexpected test request');
  });
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { resetPatientSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function authorizationUrl(): Promise<URL> {
  await waitFor(() => expect(popup.location.href).toContain('https://sign-in.example/authorize?'));
  return new URL(popup.location.href);
}
function callback(id: string, state: string, overrides: MessageEventInit = {}) {
  window.dispatchEvent(new MessageEvent('message', { origin, source: popup, data: { type: 'plan-shepherd:oauth', connector: id, state, code: 'one-time-code' }, ...overrides }));
}

describe('SMART sign-in and import', () => {
  it.each(['atrius', 'cigna', 'hospital-123'])('uses the server callback, S256 PKCE and validated popup response before importing %s', async id => {
    const result = connectPatient(id);
    const auth = await authorizationUrl();
    expect(auth.searchParams.get('redirect_uri')).toBe(`${origin}${id === 'atrius' ? '/auth/callback' : `/oauth/callback/${id}`}`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    if (id === 'cigna') expect(auth.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = auth.searchParams.get('state')!;
    callback(id, state, { origin: 'https://attacker.example' });
    callback(id, state, { source: window });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/token'))).toBe(false);
    callback(id, state);
    expect(await result).toMatchObject({ patient: { id: 'p1', source: id }, complete: true });
    const resourceCalls = upstream.mock.calls.filter(([url]) => url === `/api/connectors/${id}/resource`);
    expect(resourceCalls.map(([, request]) => JSON.parse(String(request?.body)).resource)).toEqual(resourceLists[id]);
    const tokenCall = upstream.mock.calls.find(([url]) => url.endsWith('/token'))!;
    const body = JSON.parse(String(tokenCall[1]?.body));
    expect(body.code).toBe('one-time-code');
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier));
    expect(Buffer.from(digest).toString('base64url')).toBe(auth.searchParams.get('code_challenge'));
    expect(JSON.stringify(body)).not.toContain('client_secret');
    expect(popup.close).toHaveBeenCalled();
  });

  it('rejects a mismatched OAuth state before exchanging the code', async () => {
    const failure = connectPatient('hospital-123').catch(error => error as Error);
    await authorizationUrl();
    callback('hospital-123', 'wrong-state');
    expect(await failure).toMatchObject({ message: 'The sign-in response did not match this session.' });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/token'))).toBe(false);
  });

  it('rejects a callback for another connector even when the state matches', async () => {
    const failure = connectPatient('hospital-123').catch(error => error as Error);
    const auth = await authorizationUrl();
    callback('cigna', auth.searchParams.get('state')!);
    expect(await failure).toMatchObject({ message: 'The sign-in response did not match this session.' });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/token'))).toBe(false);
    expect(popup.close).toHaveBeenCalled();
  });

  it('cancels pending sign-in when the session is cleared', async () => {
    const failure = connectPatient('cigna').catch(error => error as Error);
    const auth = await authorizationUrl();
    resetPatientSession();
    callback('cigna', auth.searchParams.get('state')!);
    expect(await failure).toMatchObject({ message: 'The session was cleared.' });
    expect(upstream.mock.calls.some(([url]) => url.endsWith('/token'))).toBe(false);
    expect(popup.close).toHaveBeenCalled();
  });
});
