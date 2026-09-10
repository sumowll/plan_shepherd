// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { connectPatient, resetPatientSession } from '../../src/client/oauth';
import { connectionIdentity } from '../helpers/connection-identity';

let popup: Window;
let upstream: ReturnType<typeof vi.fn>;
const origin = window.location.origin;
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const resourceLists: Record<string, string[]> = {
  atrius: ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense', 'Condition'],
  cigna: ['Patient', 'ExplanationOfBenefit'],
  'hospital-123': ['Patient', 'Encounter', 'Condition'],
};
const connectionIds: Record<string, string> = Object.fromEntries(Object.keys(resourceLists).map((key, index) => [key, connectionIdentity(key, index + 1).id]));
connectionIds['renamed-hospital'] = connectionIds['hospital-123'];
resourceLists['renamed-hospital'] = resourceLists['hospital-123'];

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  popup = { closed: false, location: { href: 'about:blank' }, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(popup);
  upstream = vi.fn(async (url: string, init?: RequestInit) => {
    const requested = decodeURIComponent(url.split('/')[3]);
    const id = connectionIds[requested] ? requested : Object.keys(connectionIds).find(key => connectionIds[key] === requested)!;
    if (url.endsWith('/authorize')) return reply({ connectionId: connectionIds[id], authorizationUrl: 'https://sign-in.example/authorize', clientId: 'synthetic-client', scopes: id === 'cigna' ? 'openid fhirUser patient/*.read' : 'launch/patient patient/*.read', audience: 'https://records.example/fhir', responseMode: 'query', redirectUri: `${origin}${id === 'atrius' ? '/auth/callback' : `/oauth/callback/${id}`}`, resources: resourceLists[id] });
    if (url.endsWith('/token')) return reply({ accessToken: 'synthetic-access', patientId: 'p1', receipt: 'synthetic-receipt' });
    if (url.endsWith('/resource')) {
      const input = JSON.parse(String(init?.body));
      const encounter = { resourceType: 'Encounter', id: 'e1', status: 'finished', subject: { reference: 'Patient/p1' }, period: { start: '2025-03-04' } };
      return reply({ page: input.resource === 'Patient' ? { resourceType: 'Patient', id: 'p1', birthDate: '1980-01-01' } : { resourceType: 'Bundle', entry: input.resource === 'Encounter' ? [{ resource: encounter }] : [] }, references: [], referenceLimitReached: false });
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
  window.dispatchEvent(new MessageEvent('message', { origin, source: popup, data: { type: 'plan-shepherd:oauth', connector: connectionIds[id] ?? id, state, code: 'one-time-code' }, ...overrides }));
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
    expect(await result).toMatchObject({ patient: { id: 'p1', source: connectionIds[id] }, complete: true });
    const resourceCalls = upstream.mock.calls.filter(([url]) => url === `/api/connectors/${connectionIds[id]}/resource`);
    expect(resourceCalls.map(([, request]) => JSON.parse(String(request?.body)).resource)).toEqual(resourceLists[id]);
    const tokenCall = upstream.mock.calls.find(([url]) => url.endsWith('/token'))!;
    expect(tokenCall[0]).toBe(`/api/connectors/${connectionIds[id]}/token`);
    const body = JSON.parse(String(tokenCall[1]?.body));
    expect(body.code).toBe('one-time-code');
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier));
    expect(Buffer.from(digest).toString('base64url')).toBe(auth.searchParams.get('code_challenge'));
    expect(JSON.stringify(body)).not.toContain('client_secret');
    expect(popup.close).toHaveBeenCalled();
  });

  it('preserves imported patient evidence identities across a readable key rename', async () => {
    const imports = [];
    for (const key of ['hospital-123', 'renamed-hospital']) {
      popup.location.href = 'about:blank';
      const pending = connectPatient(key);
      const auth = await authorizationUrl();
      callback(key, auth.searchParams.get('state')!);
      imports.push(await pending);
    }
    expect(imports[0].patient).toEqual(imports[1].patient);
    expect(imports[0].patient?.source).toBe(connectionIds['hospital-123']);
    expect(imports[0].patient?.evidence).not.toHaveLength(0);
    expect(imports[0].events).toHaveLength(1);
    expect(imports[0].events).toEqual(imports[1].events);
    expect(imports[0].events[0].source).toBe(connectionIds['hospital-123']);
  });

  it('accepts a canonical UUID as the initial selection while using the registered key callback', async () => {
    const id = connectionIds['hospital-123'];
    const pending = connectPatient(id);
    const auth = await authorizationUrl();
    expect(auth.searchParams.get('redirect_uri')).toBe(`${origin}/oauth/callback/hospital-123`);
    callback(id, auth.searchParams.get('state')!);
    expect(await pending).toMatchObject({ patient: { source: id } });
  });

  it('rejects authorization metadata for another UUID before navigating to sign-in or exchanging a token', async () => {
    upstream.mockResolvedValueOnce(reply({
      connectionId: connectionIds.cigna, authorizationUrl: 'https://sign-in.example/authorize',
      clientId: 'synthetic-client', scopes: 'openid fhirUser patient/*.read',
      audience: 'https://records.example/fhir', responseMode: 'query',
      redirectUri: `${origin}/oauth/callback/cigna`, resources: resourceLists.cigna,
    }));
    await expect(connectPatient(connectionIds['hospital-123'])).rejects.toThrow();
    expect(popup.location.href).toBe('about:blank');
    expect(popup.close).toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe(`/api/connectors/${connectionIds['hospital-123']}/authorize`);
  });

  it('matches uppercase UUID selections to the same canonical authorization identity', async () => {
    const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    upstream.mockResolvedValueOnce(reply({
      connectionId: id, authorizationUrl: 'https://sign-in.example/authorize',
      clientId: 'synthetic-client', scopes: 'launch/patient patient/*.read',
      audience: 'https://records.example/fhir', responseMode: 'query',
      redirectUri: `${origin}/oauth/callback/hospital-123`, resources: ['Patient'],
    }));
    const pending = connectPatient(id.toUpperCase());
    const auth = await authorizationUrl();
    callback(id, auth.searchParams.get('state')!);
    expect(await pending).toMatchObject({ patient: { source: id }, complete: true });
    expect(upstream.mock.calls.find(([url]) => url.endsWith('/token'))?.[0]).toBe(`/api/connectors/${id}/token`);
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
