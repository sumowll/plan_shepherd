/** Leave room for parsing, calculation results and serialization within a 128 MiB Worker. */
export const CATALOG_READ_BYTES = 8 * 1024 * 1024;
export const CATALOG_READ_ROWS = 50_000;
export class CatalogReadLimitError extends Error {
  constructor() { super('The requested catalog details exceed the serving limit. Compare fewer plans or care records.'); }
}
export interface ReadBudget { bytes: number; rows: number }
export const readBudget = (): ReadBudget => ({ bytes: CATALOG_READ_BYTES, rows: CATALOG_READ_ROWS });

/** Count bytes inside D1 before transferring any matching JSON to the Worker. */
export async function boundedJsonRows<T extends { data_json: string }>(db: D1Database, select: string, args: (string | number)[], budget: ReadBudget, order = ''): Promise<T[]> {
  const size = await db.prepare(`SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(data_json AS BLOB))),0) AS byte_count FROM (${select}) AS bounded_rows`).bind(...args).first<{ row_count: number; byte_count: number }>();
  if (!size || !Number.isSafeInteger(size.row_count) || !Number.isSafeInteger(size.byte_count) || size.row_count > budget.rows || size.byte_count > budget.bytes) throw new CatalogReadLimitError();
  if (!size.row_count) return [];
  // Published releases are immutable, so the count and materialization share the same data.
  const rows = (await db.prepare(`${select}${order}`).bind(...args).all<T>()).results;
  budget.rows -= size.row_count; budget.bytes -= size.byte_count;
  return rows;
}
