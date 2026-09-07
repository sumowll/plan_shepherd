import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchCanonicalFeed } from '../../scripts/fetch-catalog';

// Synthetic public-reference fixtures are used only inside these isolated tests.
const source = { id: 'test-source', publisher: 'Test publisher', url: 'https://example.org/public-reference', retrievedAt: '2026-09-01T00:00:00Z', effectiveDate: '2026-01-01', version: 'test-v1' };
const canonical = { schemaVersion: 1, dataClass: 'public_reference', release: { id: 'test-release', year: 2026, createdAt: source.retrievedAt, publisher: 'Tests only', productionData: true, rightsConfirmed: true, provenanceReviewedBy: 'Test suite' }, sources: [source], plans: [], premiumRates: [], coverage: [] };

describe('canonical public feed acquisition', () => {
  let directory: string, output: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'catalog-fetch-test-')); output = join(directory, 'feed.json'); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const missing = async (path: string) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

  it('streams a valid canonical feed to an exclusive private file without publishing', async () => {
    const body = JSON.stringify(canonical), bytes = new TextEncoder().encode(body);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 51)); controller.enqueue(bytes.slice(51)); controller.close(); } })));
    const result = await fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', token: 'test-bearer', output, fetchImpl: fetchImpl as typeof fetch });
    expect(result).toMatchObject({ releaseId: 'test-release', planCount: 0, bytes: bytes.byteLength });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); expect(await readFile(output, 'utf8')).toBe(body);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://feeds.example.org/catalog.json', expect.objectContaining({ redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer test-bearer' } }));
    const secondFetch = vi.fn();
    await expect(fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', output, fetchImpl: secondFetch as typeof fetch })).rejects.toThrow(/already exists/);
    expect(secondFetch).not.toHaveBeenCalled(); expect(await readFile(output, 'utf8')).toBe(body);
  });

  it('rejects authorization failures and redirects without exposing response bodies or following a second host', async () => {
    for (const response of [new Response('private response marker', { status: 401 }), Response.redirect('https://other.example.org/steal?token=private-marker', 302)]) {
      const fetchImpl = vi.fn(async () => response);
      const error = await fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', token: 'private-bearer-marker', output, fetchImpl: fetchImpl as typeof fetch }).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(/not authorized|redirects/);
      expect(String(error)).not.toMatch(/private|other\.example/); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' })); await missing(output);
    }
  });

  it('removes invalid or non-public downloaded data and redacts validator/network details', async () => {
    for (const body of ['not JSON: private-body-marker', JSON.stringify({ ...canonical, dataClass: 'patient_data', patient: { name: 'private-body-marker' } })]) {
      await expect(fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', output, fetchImpl: (async () => new Response(body)) as typeof fetch })).rejects.toThrow('The downloaded feed is not a valid public-reference catalog; the output was removed.');
      await missing(output);
    }
    const error = await fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', output, fetchImpl: (async () => { throw new Error('private-token-and-response-marker'); }) as typeof fetch }).catch(error => error as Error);
    expect(String(error)).toBe('Error: The catalog feed download failed; no output file was retained.'); await missing(output);
  });

  it('enforces both declared and streamed size limits and a bounded request timeout', async () => {
    for (const headers of [{ 'content-length': '100' }, {}] as Record<string, string>[]) {
      await expect(fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', output, maxBytes: 64, fetchImpl: (async () => new Response('x'.repeat(100), { headers })) as typeof fetch })).rejects.toThrow(/download size/);
      await missing(output);
    }
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('private transport error')), { once: true }); })) as typeof fetch;
    await expect(fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog.json', output, timeoutMs: 10, fetchImpl })).rejects.toThrow(/timed out/); await missing(output);
  });

  it('rejects unsafe configured URLs before making a request and preserves an existing output', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['http://feeds.example.org/catalog', 'https://127.0.0.1/catalog', 'https://localhost/catalog', 'https://user:secret@feeds.example.org/catalog', 'https://feeds.example.org/catalog?token=secret']) {
      await expect(fetchCanonicalFeed({ url, output, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/public HTTPS/); await missing(output);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await writeFile(output, 'preexisting data');
    await expect(fetchCanonicalFeed({ url: 'https://feeds.example.org/catalog', output, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/already exists/);
    expect(await readFile(output, 'utf8')).toBe('preexisting data'); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
