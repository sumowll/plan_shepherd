import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../../src/server/http';

afterEach(() => vi.unstubAllGlobals());
describe('Worker outbound transport', () => {
  it('uses a redirect mode accepted by the local Worker so requests reach the upstream service', async () => {
    const upstream = vi.fn(async (_url: unknown, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of follow or manual');
      return Response.json({ authorization_endpoint: 'https://provider.example/authorize' });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await safeFetch('https://provider.example/fhir/.well-known/smart-configuration');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorization_endpoint: 'https://provider.example/authorize' });
  });

  it.each([301, 302, 303, 307, 308])('blocks %s responses without forwarding token credentials or following Location', async status => {
    const cancel = vi.fn();
    const upstream = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status, headers: { Location: 'https://attacker.example/collect' } }));
    vi.stubGlobal('fetch', upstream);
    await expect(safeFetch('https://provider.example/token', {
      method: 'POST', redirect: 'follow', headers: { Authorization: 'Basic synthetic-credential' }, body: 'code=synthetic-code',
    })).rejects.toMatchObject({ code: 'upstream_redirect' });
    expect(upstream).toHaveBeenCalledExactlyOnceWith('https://provider.example/token', expect.objectContaining({ redirect: 'manual' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not return raw transport errors that may contain secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic-secret-in-transport-error')));
    await expect(safeFetch('https://provider.example/token')).rejects.toMatchObject({ code: 'upstream_unavailable', message: 'The connected service did not respond. Please retry.' });
  });
});
