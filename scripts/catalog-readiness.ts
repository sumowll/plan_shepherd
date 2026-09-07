import { z } from 'zod';
import { readinessSchema } from './verify-production';

// Inspect the stored release, including every searchable plan and each offered county.
export const catalogReadinessSql = `SELECT a.release_id,c.state,c.family,c.data_json,
  COUNT(p.id) AS searchable_count,
  COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND (p.status!='available'
    OR json_extract(p.data_json,'$.rulesVerified') IS NOT 1
    OR COALESCE(json_array_length(p.data_json,'$.benefits'),0)=0) THEN 1 ELSE 0 END),0) AS unverified_count,
  COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM catalog_plan_counties pc WHERE pc.release_id=p.release_id AND pc.plan_id=p.id)
    OR EXISTS (SELECT 1 FROM catalog_plan_counties pc WHERE pc.release_id=p.release_id AND pc.plan_id=p.id
      AND NOT EXISTS (SELECT 1 FROM catalog_premium_rates r WHERE r.release_id=p.release_id AND r.plan_id=p.id
        AND r.county_fips=pc.county_fips AND r.effective_start<=p.effective_start AND r.effective_end>=p.effective_end))
  ) THEN 1 ELSE 0 END),0) AS unrated_count
FROM catalog_active a JOIN catalog_releases rel ON rel.id=a.release_id AND rel.status='published'
JOIN catalog_coverage c ON c.release_id=a.release_id
LEFT JOIN catalog_plans p ON p.release_id=c.release_id AND p.state=c.state AND p.family=c.family AND p.year=c.year AND p.status!='withdrawn'
WHERE a.singleton=1 AND c.year=2026
GROUP BY a.release_id,c.state,c.family,c.data_json`;

const rowSchema = z.object({ release_id: z.string(), state: z.string(), family: z.string(), data_json: z.string(),
  searchable_count: z.number().int().nonnegative(), unverified_count: z.number().int().nonnegative(), unrated_count: z.number().int().nonnegative() });

export function verifyCatalogReadiness(value: unknown, record: z.infer<typeof readinessSchema>): void {
  const rows = z.array(rowSchema).max(153).parse(value);
  for (const coverage of record.coverage) {
    const matches = rows.filter(row => row.release_id === record.catalogReleaseId && row.state === coverage.state && row.family === coverage.family);
    const row = matches.length === 1 ? matches[0] : undefined;
    const data = row ? z.object({ status: z.string() }).parse(JSON.parse(row.data_json)) : null;
    const label = `${coverage.state}/${coverage.family}`;
    if (!row || data?.status !== (coverage.status === 'verified' ? 'available' : 'not_offered')) throw new Error(`The published catalog does not match readiness evidence for ${label}.`);
    if (coverage.status === 'not_offered') {
      if (row.searchable_count) throw new Error(`The catalog claims ${label} is not offered but contains searchable plans.`);
    } else if (!row.searchable_count || row.unverified_count || row.unrated_count) {
      throw new Error(`The published catalog for ${label} needs available plans with verified benefits and county-specific premiums covering the plan term.`);
    }
  }
}
