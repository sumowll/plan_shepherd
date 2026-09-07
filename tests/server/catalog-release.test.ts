import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { catalogStatements } from '../../scripts/catalog/sql';
import type { CanonicalCatalog } from '../../src/catalog/schema';
import { importD1Statements, queryD1 } from '../../scripts/d1-query';
import { catalogReadinessSql, verifyCatalogReadiness } from '../../scripts/catalog-readiness';
import { readinessSchema } from '../../scripts/verify-production';
import type { z } from 'zod';

const env = { CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CATALOG_DATABASE_ID: '11111111-1111-4111-8111-111111111111', CLOUDFLARE_API_TOKEN: 'synthetic-test-token' };
const source = { id: 'test-source', publisher: 'Test only', url: 'https://example.org/plans', retrievedAt: '2026-09-01T00:00:00Z', effectiveDate: '2026-01-01', version: '1' };
const fixture = (id: string): CanonicalCatalog => ({ schemaVersion: 1, dataClass: 'public_reference',
  release: { id, year: 2026, createdAt: source.retrievedAt, publisher: 'Tests', productionData: true, rightsConfirmed: true, provenanceReviewedBy: 'Synthetic test' },
  sources: [source], plans: [{ id: 'plan', name: "Plan; O'Brien\nwith newline", issuer: 'Test', family: 'aca', state: 'MA', year: 2026, countyFips: ['25017'], status: 'available',
    effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: null, premiumEstimated: true, deductibleCents: 0, oopMaxCents: 100000,
    drugDeductibleCents: 0, drugOopMaxCents: 100000, providers: [], drugs: [], prices: [], documentUrls: [], source,
    benefits: [{ id: 'visit', label: 'Visit', category: 'primary_care', coverage: 'covered', network: 'any', copayCents: 0, coinsuranceBps: 0, appliesDeductible: false, accumulator: 'medical', explanation: 'Test', source }],
    rulesVerified: true, networkComplete: false, formularyComplete: false, underwritingRequired: false }],
  premiumRates: [{ id: 'rate', planId: 'plan', countyFips: '25017', minAge: 0, maxAge: 120, tobacco: 'any', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 50000, estimated: false, source }],
  coverage: [{ state: 'MA', family: 'aca', year: 2026, status: 'available', planCount: 1, lastUpdated: source.retrievedAt, note: 'Synthetic test' }],
});
const openDb = () => {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  return db;
};
const publish = (db: DatabaseSync, catalog: CanonicalCatalog) => { for (const sql of catalogStatements(catalog)) db.exec(sql); };
const active = (db: DatabaseSync) => db.prepare('SELECT release_id FROM catalog_active').get()?.release_id;
const approval: z.infer<typeof readinessSchema> = {
  reviewedAt: source.retrievedAt, reviewer: 'Tests', catalogReleaseId: 'release', liveAtriusImportVerified: true, liveCignaEmployerImportVerified: true,
  aiRetentionVerified: true, cloudflareServiceScopeVerified: true, callbackRetentionReviewed: true, independentCalculationReviewPassed: true,
  loadTestPassed: true, incidentAndRollbackRunbookReviewed: true, coverage: [{ state: 'MA', family: 'aca', status: 'verified', evidence: 'Synthetic test' }],
};

describe('remote catalog query ingestion', () => {
  it('serves the old release between bounded batches and changes the pointer only after the complete load', async () => {
    const db = openDb();
    try {
      publish(db, fixture('old'));
      const next = fixture('new'); next.plans[0].prices = Array.from({ length: 130 }, (_, i) => ({ id: String(i), category: 'primary_care', unitPriceCents: 10000, basis: 'contracted', source }));
      let requests = 0;
      const fetcher: typeof fetch = async (url, init) => {
        expect(String(url)).toMatch(/\/query$/); expect(active(db)).toBe('old');
        const { sql } = JSON.parse(String(init?.body)); expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(95000);
        db.exec('BEGIN'); db.exec(sql); db.exec('COMMIT'); requests++;
        return Response.json({ success: true, result: [{ success: true, results: [] }] });
      };
      await importD1Statements(env, catalogStatements(next), fetcher);
      expect(requests).toBeGreaterThan(2); expect(active(db)).toBe('new');
      expect(db.prepare("SELECT name FROM catalog_plans WHERE release_id='new'").get()?.name).toBe(next.plans[0].name);
      expect(db.prepare("SELECT COUNT(*) AS count FROM catalog_components WHERE release_id='new'").get()?.count).toBe(130);
    } finally { db.close(); }
  });
  it('stops after a failed batch without publishing incomplete data or automatically retrying writes', async () => {
    const db = openDb();
    try {
      publish(db, fixture('old')); const next = fixture('new');
      next.plans[0].prices = Array.from({ length: 130 }, (_, i) => ({ id: String(i), category: 'primary_care', unitPriceCents: 10000, basis: 'contracted', source }));
      let requests = 0;
      const fetcher: typeof fetch = async (_url, init) => {
        if (++requests === 2) return Response.json({ success: false }, { status: 503 });
        db.exec(JSON.parse(String(init?.body)).sql);
        return Response.json({ success: true, result: [{ success: true, results: [] }] });
      };
      await expect(importD1Statements(env, catalogStatements(next), fetcher)).rejects.toThrow('Check the active release');
      expect(requests).toBe(2); expect(active(db)).toBe('old');
      expect(db.prepare("SELECT status FROM catalog_releases WHERE id='new'").get()?.status).toBe('staging');
    } finally { db.close(); }
  });
  it('rejects failed statements within a successful HTTP response and unbounded SQL', async () => {
    await expect(queryD1(env, 'SELECT 1', [], async () => Response.json({ success: true, result: [{ success: false }] }))).rejects.toThrow('every statement');
    await expect(importD1Statements(env, ['x'.repeat(95001)], async () => { throw new Error('must not send'); })).rejects.toThrow('bounded');
  });
});

describe('stored catalog release qualification', () => {
  it('accepts verified benefits and rated counties in the approved release', () => {
    const db = openDb();
    try { publish(db, fixture('release')); expect(() => verifyCatalogReadiness(db.prepare(catalogReadinessSql).all(), approval)).not.toThrow(); }
    finally { db.close(); }
  });
  it.each(['withdrawn', 'unverified', 'unknown_status', 'no_benefits', 'no_rates', 'partial_rate', 'unrated_county'] as const)('rejects a misleading available declaration: %s', failure => {
    const db = openDb(); const catalog = fixture('release');
    if (failure === 'withdrawn') catalog.plans[0].status = 'withdrawn';
    if (failure === 'unverified') catalog.plans[0].rulesVerified = false;
    if (failure === 'unknown_status') catalog.plans[0].status = 'unknown';
    if (failure === 'no_benefits') catalog.plans[0].benefits = [];
    if (failure === 'no_rates') catalog.premiumRates = [];
    if (failure === 'partial_rate') catalog.premiumRates[0].effectiveEnd = '2026-01-01';
    if (failure === 'unrated_county') catalog.plans[0].countyFips.push('25025');
    // Exercise the gate against legacy/malformed stored releases, independently of today's importer validation.
    try { publish(db, catalog); expect(() => verifyCatalogReadiness(db.prepare(catalogReadinessSql).all(), approval)).toThrow('needs available plans'); }
    finally { db.close(); }
  });
});
