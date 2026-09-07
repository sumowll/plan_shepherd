import { z } from 'zod';
import { boundedJson } from '../src/server/http';

const resultSchema = z.object({ success: z.literal(true), result: z.array(z.object({
  success: z.literal(true), results: z.array(z.unknown()).optional(),
})).min(1) });

/** Operator tooling only: credentials and public catalog SQL never enter the Worker. */
export async function queryD1(env: Record<string, string>, sql: string, params: string[] = [], fetcher: typeof fetch = fetch): Promise<unknown[]> {
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !z.uuid().safeParse(env.CATALOG_DATABASE_ID).success || env.CATALOG_DATABASE_ID === '00000000-0000-0000-0000-000000000000' || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Provisioned D1 account/database credentials are required.');
  }
  if (Buffer.byteLength(sql) > 95_000) throw new Error('D1 query exceeds the bounded SQL request size.');
  let response: Response;
  try {
    response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.CATALOG_DATABASE_ID}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
  } catch { throw new Error('D1 query was not acknowledged. Check the active release before retrying an import; the last request may have committed.'); }
  if (!response.ok) throw new Error(`D1 query returned HTTP ${response.status}. Check the active release before retrying an import.`);
  const result = resultSchema.safeParse(await boundedJson(response, 1024 * 1024));
  if (!result.success) throw new Error('D1 did not confirm every statement. Check the active release before retrying an import.');
  return result.data.result.flatMap(item => item.results ?? []);
}

/** Small query batches keep staging invisible without taking D1 offline for a file import. */
export async function importD1Statements(env: Record<string, string>, statements: Iterable<string> | AsyncIterable<string>, fetcher: typeof fetch = fetch): Promise<void> {
  let batch: string[] = []; let bytes = 0;
  const flush = async () => {
    if (batch.length) await queryD1(env, batch.join('\n'), [], fetcher);
    batch = []; bytes = 0;
  };
  for await (const statement of statements) {
    const size = Buffer.byteLength(statement) + 1;
    if (size > 95_000) throw new Error('Catalog statement exceeds the bounded D1 request size.');
    if (batch.length && (bytes + size > 95_000 || batch.length >= 50)) await flush();
    batch.push(statement); bytes += size;
  }
  await flush();
}
