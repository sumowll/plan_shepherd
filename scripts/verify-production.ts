import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readEnvironment } from './env';
import { connectorConfig, connectorRedirectUri, aiEnabled, safeHttpsUrl } from '../src/server/config';
import { connectorRegistry } from '../src/server/connector-registry';
import { STATES } from '../src/catalog/schema';
import { PLAN_FAMILIES } from '../src/shared/contracts';

export const readinessSchema = z.object({
  reviewedAt: z.iso.datetime(), reviewer: z.string().min(1), catalogReleaseId: z.string().min(1),
  liveAtriusImportVerified: z.literal(true), liveCignaEmployerImportVerified: z.literal(true),
  aiRetentionVerified: z.literal(true), cloudflareServiceScopeVerified: z.literal(true),
  callbackRetentionReviewed: z.literal(true), independentCalculationReviewPassed: z.literal(true),
  loadTestPassed: z.literal(true), incidentAndRollbackRunbookReviewed: z.literal(true),
  coverage: z.array(z.object({ state: z.enum(STATES), family: z.enum(PLAN_FAMILIES), status: z.enum(['verified','not_offered']), evidence: z.string().min(1) })),
});
export async function verifyProduction(env: Record<string, string>, readiness: unknown): Promise<string[]> {
  const failures: string[] = [];
  let origin: string | undefined;
  if (env.APP_ENV !== 'production') failures.push('APP_ENV must be production.');
  try { const configured = safeHttpsUrl(env.APP_ORIGIN ?? ''); if (configured.pathname !== '/' || configured.origin !== env.APP_ORIGIN) throw new Error(); origin = configured.origin; }
  catch { failures.push('APP_ORIGIN must be a public HTTPS origin without a path or trailing slash.'); }
  try { safeHttpsUrl(env.AI_BASE_URL || 'https://api.openai.com/v1'); } catch { failures.push('AI_BASE_URL must be an approved public HTTPS endpoint.'); }
  if (env.PLAN_YEAR !== '2026') failures.push('PLAN_YEAR must be 2026.');
  if (env.PATIENT_PROCESSING_APPROVED !== 'true') failures.push('Patient processing approval is not configured.');
  let connectors: ReturnType<typeof connectorRegistry> = [];
  try { connectors = connectorRegistry(env); }
  catch { failures.push('The connector registry has invalid configuration.'); }
  for (const { id, enabled } of connectors) {
    if (enabled === false) continue;
    try { if (!connectorConfig(env, id).enabled) failures.push(`${id} requires approved production configuration.`); }
    catch { failures.push(`${id} has invalid configuration.`); }
    if (origin) {
      try { connectorRedirectUri(env, id, origin); }
      catch { failures.push(`${id} callback must match the production application origin and a supported callback path.`); }
    }
  }
  if (!aiEnabled(env)) failures.push('An approved AI model and retention configuration are required.');
  if (!z.uuid().safeParse(env.CATALOG_DATABASE_ID).success || env.CATALOG_DATABASE_ID === '00000000-0000-0000-0000-000000000000') failures.push('A provisioned catalog database ID is required.');
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN) failures.push('Cloudflare deployment credentials are required.');
  const parsed = readinessSchema.safeParse(readiness);
  if (!parsed.success) failures.push('Complete the independently reviewed production-readiness record.');
  else {
    const seen = new Set(parsed.data.coverage.map(x => `${x.state}:${x.family}`));
    if (seen.size !== parsed.data.coverage.length) failures.push('Coverage evidence contains duplicate state/family entries.');
    for (const state of STATES) for (const family of PLAN_FAMILIES) if (!seen.has(`${state}:${family}`)) failures.push(`Coverage evidence missing for ${state}/${family}.`);
    const age = Date.now() - Date.parse(parsed.data.reviewedAt);
    if (age < 0 || age > 30 * 86400000) failures.push('Production readiness must be reviewed within the past 30 days and cannot be future-dated.');
  }
  return failures;
}
if (process.argv[1]?.endsWith('verify-production.ts')) {
  const env = await readEnvironment(); let readiness: unknown = null;
  if (env.PRODUCTION_READINESS_FILE) { try { readiness = JSON.parse(await readFile(env.PRODUCTION_READINESS_FILE, 'utf8')); } catch { /* Report the missing/invalid record below without leaking file content. */ } }
  const failures = await verifyProduction(env, readiness);
  if (failures.length) { process.stderr.write(`Production deployment is not ready:\n${failures.map(x => `- ${x}`).join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write('Production configuration and readiness attestations passed. This does not replace live integration and independent release validation.\n');
}
