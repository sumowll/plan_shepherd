import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readEnvironment } from './env';
import { readCanonicalFile } from './catalog/bundle';
import { safeHttpsUrl } from '../src/server/config';

const MAX_BYTES = 512 * 1024 * 1024;
class FeedError extends Error {}
interface FeedOptions {
  url: string; token?: string; output: string;
  fetchImpl?: typeof fetch;
  /** Injectable smaller operational bounds for tests; production cannot exceed the hard limits. */
  maxBytes?: number; timeoutMs?: number;
}

/** Acquire public reference JSON only. This function never imports or publishes a release. */
export async function fetchCanonicalFeed(options: FeedOptions): Promise<{ bytes: number; sha256: string; releaseId: string; planCount: number }> {
  let url: URL;
  try { url = safeHttpsUrl(options.url); }
  catch { throw new FeedError('Configure a public HTTPS catalog endpoint without credentials, query parameters, or redirects.'); }
  const token = options.token ?? '';
  if (token.length > 8192 || (token && !/^[\x21-\x7e]+$/.test(token))) throw new FeedError('The configured catalog bearer token has an invalid format.');
  const maxBytes = options.maxBytes ?? MAX_BYTES, timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new FeedError('Invalid catalog download bounds.');
  const output = resolve(options.output), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let file: Awaited<ReturnType<typeof open>> | undefined, created = false, validated = false;
  try {
    try { file = await open(output, 'wx', 0o600); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FeedError('The output file already exists; choose a new output path.');
      throw new FeedError('The catalog output file could not be created.');
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await (options.fetchImpl ?? fetch)(url.href, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    if (response.redirected || response.status >= 300 && response.status < 400) throw new FeedError('Catalog feed redirects are not permitted.');
    if (response.status === 401 || response.status === 403) throw new FeedError('The catalog feed request was not authorized.');
    if (!response.ok || !response.body) throw new FeedError('The catalog feed did not return a successful response body.');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > maxBytes)) throw new FeedError('The catalog feed exceeds the permitted download size.');
    const reader = response.body.getReader(), digest = createHash('sha256');
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new FeedError('The catalog feed download timed out.');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new FeedError('The catalog feed exceeds the permitted download size.');
        digest.update(value);
        for (let offset = 0; offset < value.byteLength;) {
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new FeedError('The catalog output could not be written completely.');
          offset += bytesWritten;
        }
      }
    } finally { reader.releaseLock(); }
    await file.close(); file = undefined;
    clearTimeout(timer);
    const sha256 = digest.digest('hex');
    let catalog;
    try { catalog = await readCanonicalFile(output, sha256); }
    catch { throw new FeedError('The downloaded feed is not a valid public-reference catalog; the output was removed.'); }
    validated = true;
    return { bytes, sha256, releaseId: catalog.release.id, planCount: catalog.plans.length };
  } catch (error) {
    // Fetch, filesystem and validator errors may contain URLs, credentials or response values.
    // Only our fixed error messages cross the command-line boundary.
    if (error instanceof FeedError) throw error;
    throw new FeedError(controller.signal.aborted ? 'The catalog feed download timed out.' : 'The catalog feed download failed; no output file was retained.');
  } finally {
    clearTimeout(timer); controller.abort();
    await file?.close().catch(() => undefined);
    if (created && !validated) await rm(output, { force: true });
  }
}

export async function fetchCatalogMain(argv: string[]): Promise<void> {
  let output: string | undefined;
  try { output = parseArgs({ args: argv, options: { output: { type: 'string' } }, strict: true }).values.output; }
  catch { throw new FeedError('Usage: npm run catalog:fetch -- --output /path/to/new-canonical.json'); }
  if (!output) throw new FeedError('Usage: npm run catalog:fetch -- --output /path/to/new-canonical.json');
  let env: Record<string, string>;
  try { env = await readEnvironment(); }
  catch { throw new FeedError('The operator environment could not be read.'); }
  const result = await fetchCanonicalFeed({ url: env.SHORT_TERM_FEED_URL ?? '', token: env.SHORT_TERM_FEED_TOKEN, output });
  process.stdout.write(`Downloaded and validated ${result.planCount} public plans (${result.bytes} bytes). No database was changed.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) fetchCatalogMain(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof FeedError ? error.message : 'Catalog feed acquisition failed.'}\n`); process.exitCode = 1;
});
