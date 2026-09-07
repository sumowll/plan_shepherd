import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import app from '../../src/server/index';
import { validateCatalog, type CanonicalCatalog } from '../../src/catalog/schema';
import { catalogStatements } from '../../scripts/catalog/sql';
import type { CatalogSearch, ComparisonInput, ComparisonResult, PersonProfile } from '../../src/shared/contracts';

// These reviewed fixture declarations exist only inside this test's in-memory database.
const planId = 'aca:2026:integration-medical';
function catalog(releaseId: string, monthlyPremiumCents = 50000): CanonicalCatalog {
  const source = { id: `source:${releaseId}`, publisher: 'Synthetic integration fixture', url: `https://example.org/fixtures/${releaseId}`, retrievedAt: '2026-09-01T00:00:00Z', effectiveDate: '2026-01-01', version: releaseId };
  return validateCatalog({
    schemaVersion: 1, dataClass: 'public_reference',
    release: { id: releaseId, year: 2026, createdAt: source.retrievedAt, publisher: 'Automated tests only', productionData: true, rightsConfirmed: true, provenanceReviewedBy: 'Hand-calculated test fixture' },
    sources: [source],
    plans: [{ id: planId, name: 'Synthetic medical plan', issuer: 'Synthetic issuer', family: 'aca', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: null, premiumEstimated: true,
      deductibleCents: 100000, oopMaxCents: 200000, drugDeductibleCents: 0, drugOopMaxCents: 200000,
      benefits: [{ id: 'medical', category: 'outpatient', label: 'Reviewed outpatient benefit', coverage: 'covered', network: 'in_network', copayCents: 0, coinsuranceBps: 2000, appliesDeductible: true, accumulator: 'medical', explanation: 'The patient pays the first $1,000, then 20% until the $2,000 medical out-of-pocket limit.', source }],
      providers: [{ npi: '1234567890', name: 'Public directory provider', location: 'Public clinic location', network: 'in_network', source }], drugs: [], prices: [], source, documentUrls: [{ label: 'Synthetic benefit document', url: source.url }], rulesVerified: true, underwritingRequired: false, networkComplete: true, formularyComplete: true }],
    premiumRates: [{ id: 'age-40-rate', planId, countyFips: '25017', minAge: 40, maxAge: 40, tobacco: 'no', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents, estimated: false, source }],
    coverage: [{ state: 'MA', family: 'aca', year: 2026, status: 'available', planCount: 1, lastUpdated: source.retrievedAt, note: 'Synthetic test coverage only.' }],
  });
}
const profile: PersonProfile = { dateOfBirth: '1986-01-01', state: 'MA', countyFips: '25017', zip: '02144', householdSize: 1, annualIncomeCents: 6100000, employerOffer: 'no', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown', medicarePartA: 'no', medicarePartB: 'no', tobacco: 'no', coverageStart: '2026-01-01', coverageEnd: '2026-12-31', citizenshipEligible: 'yes', incarcerated: 'no', enrollmentEvent: 'open_enrollment' };
function comparison(releaseId: string): ComparisonInput {
  return { profile, providers: [{ id: 'private-provider-preference', name: 'Private session provider label', npi: '1234567890', location: 'Public clinic location', preferred: true }], medications: [], planIds: [planId], releaseId,
    events: [{ id: 'private-event-1', label: 'Private session appointment one', category: 'outpatient', providerId: 'private-provider-preference', date: '2026-02-01', quantity: 1, unitPriceCents: 100000, priceType: 'allowed', priceBasis: 'user_estimate', confirmed: true }, { id: 'private-event-2', label: 'Private session appointment two', category: 'outpatient', providerId: 'private-provider-preference', date: '2026-06-01', quantity: 1, unitPriceCents: 200000, priceType: 'allowed', priceBasis: 'user_estimate', confirmed: true }] };
}

/** Run the actual repository SQL while rejecting every write through the API's D1 binding. */
function readonlyD1(sqlite: DatabaseSync): D1Database {
  function prepared(sql: string, bindings: unknown[] = []) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('The patient API attempted a persistent database mutation');
    return {
      bind: (...values: unknown[]) => prepared(sql, values),
      async first(column?: string) { const row = sqlite.prepare(sql).get(...bindings as never[]); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...bindings as never[]), success: true, meta: {} }; },
      async run() { throw new Error('The patient API attempted a persistent database mutation'); },
    };
  }
  return { prepare: prepared } as unknown as D1Database;
}
function snapshot(sqlite: DatabaseSync): string {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return JSON.stringify(tables.map(row => ({ table: row.name, rows: sqlite.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() })));
}

describe('search-to-comparison API with a real versioned SQLite catalog', () => {
  let sqlite: DatabaseSync; let db: D1Database;
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    for (const file of readdirSync(new URL('../../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    db = readonlyD1(sqlite);
    publish(catalog('integration-v1'));
  });
  afterEach(() => sqlite.close());
  function publish(data: CanonicalCatalog) { for (const statement of catalogStatements(data)) sqlite.exec(statement); }
  async function post(path: string, body: unknown) {
    return app.request(`https://app.example${path}`, { method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { APP_ENV: 'development', APP_ORIGIN: 'https://app.example', CATALOG: db });
  }
  async function search() {
    const response = await post('/api/catalog/search', { state: profile.state, countyFips: profile.countyFips, zip: profile.zip, year: 2026, age: 40, dateOfBirth: profile.dateOfBirth, tobacco: false, families: ['aca'], coverageStart: profile.coverageStart, coverageEnd: profile.coverageEnd });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json() as Promise<CatalogSearch>;
  }
  async function compare(input: ComparisonInput) {
    const response = await post('/api/compare', input);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json() as Promise<{ results: ComparisonResult[] }>;
  }

  it('searches all insurer names and pages the pinned catalog through the HTTP contract', async () => {
    const data = catalog('many-plans');
    const original = data.plans[0]; const rate = data.premiumRates[0];
    data.plans = Array.from({ length: 21 }, (_, index) => ({ ...original, id: `plan-${index}`, name: `Plan ${String(index).padStart(2, '0')}`, issuer: index === 20 ? 'Later-page insurer' : 'First-page insurer' }));
    data.premiumRates = data.plans.map(plan => ({ ...rate, id: `rate-${plan.id}`, planId: plan.id }));
    data.coverage[0].planCount = 21; publish(validateCatalog(data));
    const request = { state: 'MA', countyFips: '25017', year: 2026, families: ['aca'], limit: 20 };
    const firstResponse = await post('/api/catalog/search', request); expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as CatalogSearch;
    expect(first.total).toBe(21); expect(first.plans).toHaveLength(20);
    publish(catalog('newer-release'));
    const next = await (await post('/api/catalog/search', { ...request, offset: 20, releaseId: first.releaseId })).json() as CatalogSearch;
    expect(next.releaseId).toBe('many-plans'); expect(next.plans.map(plan => plan.id)).toEqual(['plan-20']);
    const filtered = await (await post('/api/catalog/search', { ...request, query: 'Later-page insurer', releaseId: first.releaseId })).json() as CatalogSearch;
    expect(filtered.total).toBe(1); expect(filtered.plans[0].id).toBe('plan-20');
  });

  it('matches the hand calculation, hydrates exact provider/source data, and persists no patient inputs', async () => {
    const before = snapshot(sqlite); const beforeWrites = sqlite.prepare('SELECT total_changes() AS changes').get()?.changes;
    const found = await search();
    expect(found.releaseId).toBe('integration-v1'); expect(found.plans).toHaveLength(1);
    expect(found.plans[0].monthlyPremiumCents).toBe(50000);
    expect(found.plans[0].premiumSource).toEqual(catalog('integration-v1').premiumRates[0].source);
    const result = (await compare(comparison(found.releaseId!))).results[0];
    // First event consumes the $1,000 deductible; the second costs 20% of $2,000 = $400.
    expect(result.cost.lines.map(line => line.patientCents)).toEqual([100000, 40000]);
    expect(result.cost).toMatchObject({ careCents: 140000, premiumCents: 600000, totalCents: 740000, knownSubtotalCents: 740000, unpricedCount: 0, coverageMonths: 12 });
    expect(result.providerMatches).toEqual([{ providerId: 'private-provider-preference', status: 'in_network', details: expect.any(String) }]);
    expect(result.plan.providers[0].npi).toBe('1234567890');
    expect(result.plan.premiumSource).toEqual(found.plans[0].premiumSource);
    expect(result.cost.lines.every(line => line.sourceIds.includes(catalog('integration-v1').sources[0].id))).toBe(true);
    expect(sqlite.prepare('SELECT total_changes() AS changes').get()?.changes).toBe(beforeWrites);
    expect(snapshot(sqlite)).toBe(before);
    expect(before).not.toContain('Private session'); expect(before).not.toContain(profile.dateOfBirth);
  });

  it('keeps an old comparison pinned after publishing a new premium release', async () => {
    const oldSearch = await search(); const originalInput = comparison(oldSearch.releaseId!);
    const original = (await compare(originalInput)).results[0];
    publish(catalog('integration-v2', 80000));
    const afterPublication = snapshot(sqlite);
    const current = await search(); expect(current.releaseId).toBe('integration-v2'); expect(current.plans[0].monthlyPremiumCents).toBe(80000);
    const pinned = (await compare(originalInput)).results[0];
    expect(pinned).toEqual(original); expect(pinned.cost.totalCents).toBe(740000); expect(pinned.plan.premiumSource?.version).toBe('integration-v1');
    const updated = (await compare(comparison(current.releaseId!))).results[0];
    expect(updated.cost).toMatchObject({ premiumCents: 960000, careCents: 140000, totalCents: 1100000 });
    expect(updated.plan.premiumSource?.version).toBe('integration-v2');
    expect(snapshot(sqlite)).toBe(afterPublication);
  });

  it('returns a conflict for missing/unpublished releases or a plan absent from the requested release', async () => {
    const empty = catalog('different-release'); empty.plans = []; empty.premiumRates = []; empty.coverage = [{ ...empty.coverage[0], status: 'not_offered', planCount: 0 }]; publish(validateCatalog(empty));
    const staging = catalog('unpublished-release'); sqlite.exec(catalogStatements(staging).next().value!);
    for (const releaseId of ['missing-release', 'unpublished-release', 'different-release']) {
      const response = await post('/api/compare', comparison(releaseId));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'plan_unavailable' } });
    }
    const { releaseId: _releaseId, ...unpinned } = comparison('integration-v1');
    const missingInput = await post('/api/compare', unpinned);
    expect(missingInput.status).toBe(400); expect(await missingInput.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });
});
