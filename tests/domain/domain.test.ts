import { describe, expect, it } from 'vitest';
import { buildForecast, comparePlans, evaluateEligibility, getApplicableConditions, getPlanConditions, matchMedication, matchProvider, normalizeHistory } from '../../src/domain';
import type { BenefitRule, ComparisonInput, ExpectedCareEvent, HistoricalEvent, Medication, PersonProfile, Plan, SourceRef } from '../../src/shared/contracts';

const source: SourceRef = { id: 'synthetic-source', publisher: 'Synthetic test fixture', url: 'https://example.org/synthetic', retrievedAt: '2026-01-01', version: 'test-1' };
const profile: PersonProfile = { dateOfBirth: '1980-01-01', state: 'MA', countyFips: '25017', zip: '02139', householdSize: 1, annualIncomeCents: 5_000_000, employerOffer: 'no', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown', medicarePartA: 'no', medicarePartB: 'no', tobacco: 'no', coverageStart: '2026-01-01', coverageEnd: '2026-12-31', citizenshipEligible: 'yes', incarcerated: 'no', enrollmentEvent: 'open_enrollment', taxFilingStatus: 'single', claimedAsDependent: 'no' };
const benefit = (patch: Partial<BenefitRule> = {}): BenefitRule => ({ id: 'outpatient', category: 'outpatient', label: 'Synthetic outpatient', coverage: 'covered', network: 'any', copayCents: 0, coinsuranceBps: 2000, appliesDeductible: true, accumulator: 'medical', explanation: 'Synthetic benefit', source, ...patch });
const plan = (patch: Partial<Plan> = {}): Plan => ({ id: 'synthetic-plan', name: 'Synthetic plan', issuer: 'Test issuer', family: 'aca', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 10_000, premiumEstimated: false, deductibleCents: 100_000, oopMaxCents: 200_000, drugDeductibleCents: 10_000, drugOopMaxCents: 50_000, benefits: [benefit()], providers: [], drugs: [], prices: [], source, documentUrls: [], rulesVerified: true, underwritingRequired: false, networkComplete: false, formularyComplete: false, ...patch });
const event = (id: string, amount: number | null, patch: Partial<ExpectedCareEvent> = {}): ExpectedCareEvent => ({ id, label: id, category: 'outpatient', date: '2026-01-01', quantity: 1, unitPriceCents: amount, priceBasis: 'user_estimate', priceType: 'allowed', confirmed: true, ...patch });
const medication: Medication = { id: 'med', name: 'Synthetic drug', ndc: '12345678901', strength: '10 mg', form: 'tablet', ongoing: true };
const input = (events: ExpectedCareEvent[], patch: Partial<ComparisonInput> = {}): ComparisonInput => ({ profile: { ...profile }, providers: [], medications: [], events, planIds: [], ...patch });
const cost = (events: ExpectedCareEvent[], candidate = plan(), patch: Partial<ComparisonInput> = {}) => comparePlans(input(events, patch), [candidate])[0].cost;
const history = (patch: Partial<HistoricalEvent> = {}): HistoricalEvent => ({ id: 'claim-line', source: 'cigna', date: '2025-06-12', category: 'outpatient', label: 'Historical service', kind: 'claim', status: 'completed', quantity: 1, allowedCents: 10_000, version: '1', evidence: [], ...patch });

describe('deterministic care replay', () => {
  it('crosses deductible and OOP boundaries without capping excluded care or premiums', () => {
    const candidate = plan({ benefits: [benefit(), benefit({ id: 'excluded', category: 'other', coverage: 'not_covered' })] });
    const result = cost([event('one', 60_000, { date: '2026-01-01' }), event('two', 100_000, { date: '2026-02-01' }), event('three', 600_000, { date: '2026-03-01' }), event('excluded', 40_000, { date: '2026-04-01', category: 'other', priceType: 'cash' })], candidate);
    expect(result.lines.map(line => line.patientCents)).toEqual([60_000, 52_000, 88_000, 40_000]);
    expect(result.careCents).toBe(240_000);
    expect(result.premiumCents).toBe(120_000);
    expect(result.totalCents).toBe(360_000);
    expect(result.lines[3].coverage).toBe('not_covered');
  });
  it('uses dates, not import arrival order, while preserving meaningful chronology', () => {
    const candidate = plan({ oopMaxCents: 1_000_000, benefits: [benefit({ id: 'a', serviceCodes: ['A'], coinsuranceBps: 5000 }), benefit({ id: 'b', serviceCodes: ['B'], coinsuranceBps: 1000 })] });
    const a = event('a', 100_000, { serviceCode: 'A', date: '2026-01-01' });
    const b = event('b', 100_000, { serviceCode: 'B', date: '2026-02-01' });
    expect(cost([a, b], candidate)).toEqual(cost([b, a], candidate));
    expect(cost([a, b], candidate).careCents).toBe(110_000);
    expect(cost([{ ...a, date: b.date }, { ...b, date: a.date }], candidate).careCents).toBe(150_000);
  });
  it('keeps medical and drug accumulators separate', () => {
    const candidate = plan({ benefits: [benefit(), benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }] });
    const result = cost([event('medical', 100_000), event('drug', 20_000, { category: 'prescription', medicationId: medication.id, date: '2026-02-01' })], candidate, { medications: [medication] });
    expect(result.lines.map(line => line.patientCents)).toEqual([100_000, 12_000]);
  });
  it('supports a shared deductible and simultaneous network/combined OOP credit', () => {
    const rules = [benefit({ deductibleAccumulatorId: 'shared', oopAccumulatorIds: ['shared', 'combined'] }), benefit({ id: 'rx', category: 'prescription', accumulator: 'drug', deductibleAccumulatorId: 'shared', oopAccumulatorIds: ['shared', 'combined'] })];
    const candidate = plan({ benefits: rules, accumulators: [{ id: 'shared', deductibleCents: 10_000, oopMaxCents: 20_000 }, { id: 'combined', deductibleCents: 0, oopMaxCents: 50_000 }], drugs: [{ ...medication, coverage: 'covered', source }] });
    const result = cost([event('medical', 10_000), event('drug', 20_000, { category: 'prescription', medicationId: medication.id, date: '2026-02-01' })], candidate, { medications: [medication] });
    expect(result.lines.map(line => line.patientCents)).toEqual([10_000, 4_000]);
  });
  it('caps insurer payments across benefits without inventing a patient maximum', () => {
    const candidate = plan({ family: 'short_term', deductibleCents: 0, oopMaxCents: null, medicalOopUnbounded: true, insurerPaymentCapCents: 50_000, benefits: [benefit({ coinsuranceBps: 0 }), benefit({ id: 'hospital', category: 'hospital', coinsuranceBps: 0 })] });
    const result = cost([event('first', 100_000), event('second', 100_000, { category: 'hospital', date: '2026-02-01' })], candidate);
    expect(result.lines.map(line => line.patientCents)).toEqual([50_000, 100_000]);
    expect(result.lines.map(line => line.insurerCents)).toEqual([50_000, 0]);
  });
  it('supports a per-benefit payout cap without consuming another benefit cap', () => {
    const candidate = plan({ deductibleCents: 0, benefits: [benefit({ coinsuranceBps: 0, insurerPaymentCapCents: 5_000 }), benefit({ id: 'lab', category: 'lab', coinsuranceBps: 0, insurerPaymentCapCents: 9_000 })] });
    const result = cost([event('first', 10_000), event('lab', 10_000, { category: 'lab', date: '2026-02-01' })], candidate);
    expect(result.lines.map(line => line.patientCents)).toEqual([5_000, 1_000]);
  });
  it('keeps copays that do not count toward OOP outside the accumulator', () => {
    const candidate = plan({ oopMaxCents: 1_000, benefits: [benefit({ copayCents: 800, coinsuranceBps: 0, appliesDeductible: false, copayCountsTowardOop: false })] });
    expect(cost([event('one', 10_000), event('two', 10_000, { date: '2026-02-01' })], candidate).careCents).toBe(1_600);
  });
  it('uses exact half-up monetary rounding and quantity extension', () => {
    const candidate = plan({ deductibleCents: 0, benefits: [benefit({ coinsuranceBps: 5000 })] });
    expect(cost([event('fraction', 1, { quantity: 3 })], candidate).careCents).toBe(2);
    expect(cost([event('fraction', 5, { quantity: 0.5 })], candidate).lines[0].allowedCents).toBe(3);
  });
  it('does not silently choose between copay and coinsurance', () => {
    const candidate = plan({ deductibleCents: 0, benefits: [benefit({ copayCents: 1_000, coinsuranceBps: 2000 })] });
    expect(cost([event('both', 10_000)], candidate).totalCents).toBeNull();
    candidate.benefits[0].costSharingOrder = 'copay_then_coinsurance';
    expect(cost([event('both', 10_000)], candidate).careCents).toBe(2_800);
  });
});

describe('unknowns and data boundaries', () => {
  it('does not turn a null rate into zero', () => {
    expect(cost([event('one', 10_000)], plan({ benefits: [benefit({ coinsuranceBps: null })] })).lines[0].patientCents).toBeNull();
  });
  it('does not pretend an unknown OOP limit means unlimited', () => {
    const candidate = plan({ oopMaxCents: null });
    expect(cost([event('one', 10_000)], candidate).totalCents).toBeNull();
    candidate.medicalOopUnbounded = true;
    expect(cost([event('one', 10_000)], candidate).totalCents).not.toBeNull();
  });
  it('propagates an unresolved event through shared accumulators, not unrelated drug benefits', () => {
    const candidate = plan({ benefits: [benefit(), benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }] });
    const result = cost([event('missing', null), event('later', 10_000, { date: '2026-02-01' }), event('drug', 10_000, { category: 'prescription', medicationId: medication.id, date: '2026-03-01' })], candidate, { medications: [medication] });
    expect(result.lines.map(line => line.patientCents)).toEqual([null, null, 10_000]);
    expect(result.totalCents).toBeNull();
    expect(result.knownSubtotalCents).toBe(130_000);
  });
  it('blocks unconfirmed forecast inputs and unverified rules', () => {
    expect(cost([event('draft', 10_000, { confirmed: false })]).totalCents).toBeNull();
    expect(cost([event('verified-input', 10_000)], plan({ rulesVerified: false })).totalCents).toBeNull();
  });
  it('requires encoded conditions to be satisfied before treating conditional coverage as covered', () => {
    const candidate = plan({ benefits: [benefit({ coverage: 'conditional', priorAuthorization: true })] });
    const original = event('service', 10_000);
    expect(cost([original], candidate).lines[0].coverage).toBe('conditional');
    expect(cost([{ ...original, conditions: [{ conditionId: 'plan:synthetic-plan:benefit:outpatient:prior_authorization', status: 'satisfied' }] }], candidate).lines[0].coverage).toBe('covered');
    candidate.benefits[0].priorAuthorization = false;
    expect(cost([original], candidate).lines[0].coverage).toBe('conditional');
  });
  it('rejects conflicting equally applicable prices instead of selecting the cheapest', () => {
    const candidate = plan({ prices: [{ id: 'one', category: 'outpatient', unitPriceCents: 10_000, basis: 'plan_average', source }, { id: 'two', category: 'outpatient', unitPriceCents: 20_000, basis: 'plan_average', source }] });
    expect(cost([event('service', null)], candidate).totalCents).toBeNull();
  });
  it('does not use historical allowed charges as uncovered cash prices', () => {
    const candidate = plan({ benefits: [benefit({ coverage: 'not_covered' })] });
    expect(cost([event('uncovered', 10_000, { priceBasis: 'historical' })], candidate).lines[0].patientCents).toBeNull();
    expect(cost([event('uncovered', 10_000, { priceBasis: 'historical', priceType: 'billed' })], candidate).lines[0].patientCents).toBe(10_000);
  });
  it('never applies covered coinsurance to cash, billed, or unidentified user prices', () => {
    const candidate = plan({ deductibleCents: 0 });
    for (const priceType of ['cash', 'billed', undefined] as const) expect(cost([event('covered', 10_000, { priceType })], candidate).lines[0].patientCents).toBeNull();
    expect(cost([event('covered', 10_000, { priceType: 'allowed' })], candidate).lines[0].patientCents).toBe(2_000);
    expect(cost([event('covered', 10_000, { priceType: undefined, priceBasis: 'historical' })], candidate).lines[0].patientCents).toBe(2_000);
  });
  it('does not use an explicitly allowed user estimate as uncovered spending', () => {
    const candidate = plan({ benefits: [benefit({ coverage: 'not_covered' })] });
    expect(cost([event('excluded', 10_000)], candidate).totalCents).toBeNull();
    expect(cost([event('excluded', 10_000, { priceType: 'cash' })], candidate).careCents).toBe(10_000);
  });
  it('excludes events outside the requested horizon and computes premiums for that horizon', () => {
    const result = cost([event('before', 10_000, { date: '2026-01-01' }), event('during', 10_000, { date: '2026-08-01' }), event('after', 10_000, { date: '2026-12-31' })], plan(), { profile: { ...profile, coverageStart: '2026-07-01', coverageEnd: '2026-09-30' } });
    expect(result.lines.map(line => line.eventId)).toEqual(['during']);
    expect(result.coverageMonths).toBe(3);
    expect(result.premiumCents).toBe(30_000);
  });
  it('does not imply full-year short-term coverage or renewal', () => {
    const candidate = plan({ family: 'short_term', effectiveEnd: '2026-03-31' });
    const result = cost([event('after-policy', 10_000, { date: '2026-04-01', priceType: 'cash' })], candidate);
    expect(result.coverageMonths).toBe(3);
    expect(result.premiumCents).toBe(30_000);
    expect(result.lines[0].coverage).toBe('not_covered');
    expect(result.totalCents).toBeNull();
  });
  it('respects waiting periods and handles limit-crossing ambiguity explicitly', () => {
    const candidate = plan({ benefits: [benefit({ waitingDays: 30, visitLimit: 1 })] });
    expect(cost([event('waiting', 10_000, { priceType: 'cash' })], candidate).lines[0].coverage).toBe('not_covered');
    expect(cost([event('crosses', 10_000, { date: '2026-03-01', quantity: 2 })], candidate).lines[0].patientCents).toBeNull();
  });
  it('does not double count identical event IDs or accept conflicting duplicates', () => {
    const first = event('same', 10_000);
    expect(cost([first, { ...first }]).lines).toHaveLength(1);
    expect(cost([first, { ...first, quantity: 2 }]).totalCents).toBeNull();
  });
  it('requires matching plan identity, geography and year', () => {
    expect(cost([event('one', 10_000)], plan({ countyFips: ['99999'] })).totalCents).toBeNull();
    expect(cost([event('one', 10_000)], plan({ year: 2025 })).totalCents).toBeNull();
    const results = comparePlans(input([event('one', 10_000)]), [plan(), plan()]);
    expect(results.every(result => result.cost.totalCents === null)).toBe(true);
  });
  it('does not choose between duplicate provider or medication references', () => {
    const provider = { id: 'duplicate', name: 'One', preferred: true };
    expect(cost([event('ambiguous', 10_000, { providerId: 'duplicate' })], plan(), { providers: [provider, { ...provider, name: 'Two' }] }).totalCents).toBeNull();
  });
  it('requires plan-level acceptance even when anticipated utilization is empty', () => {
    const candidate = plan({ underwritingRequired: true });
    expect(cost([], candidate).totalCents).toBeNull();
    expect(cost([], candidate, { conditions: [{ conditionId: 'plan:synthetic-plan:underwriting', status: 'satisfied' }] }).totalCents).toBe(120_000);
  });
  it('checks partial-county service areas and premium rating applicability', () => {
    expect(cost([], plan({ serviceAreas: [{ countyFips: profile.countyFips, wholeCounty: false, zipCodes: ['99999'] }] })).totalCents).toBeNull();
    expect(cost([], plan({ rating: { age: 20 } })).totalCents).toBeNull();
  });
  it('distinguishes per-fill and per-dispensed-unit prices', () => {
    const candidate = plan({ benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug', appliesDeductible: false, coinsuranceBps: 0, copayCents: 200 })], drugs: [{ ...medication, coverage: 'covered', source }], prices: [{ id: 'drug-price', category: 'prescription', medicationCode: medication.ndc, unitPriceCents: 100, quantityUnit: 'dispensed_unit', basis: 'contracted', source }] });
    const fill = event('fill', null, { category: 'prescription', quantity: 1, quantityUnit: 'fill', dispensedQuantity: 30, medicationId: medication.id });
    expect(cost([fill], candidate, { medications: [medication] }).lines[0]).toMatchObject({ allowedCents: 3000, patientCents: 200 });
    candidate.prices[0].quantityUnit = 'fill';
    candidate.prices[0].unitPriceCents = 3000;
    expect(cost([fill], candidate, { medications: [medication] }).lines[0]).toMatchObject({ allowedCents: 3000, patientCents: 200 });
    delete candidate.prices[0].quantityUnit;
    expect(cost([fill], candidate, { medications: [medication] }).totalCents).toBeNull();
  });
  it('does not apply one copay to a grouped multi-fill event', () => {
    const candidate = plan({ benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }] });
    const result = cost([event('grouped', 3000, { category: 'prescription', quantity: 3, quantityUnit: 'fill', medicationId: medication.id })], candidate, { medications: [medication] });
    expect(result.totalCents).toBeNull();
    expect(result.lines[0].explanation.join(' ')).toContain('one dated event');
  });
  it('uses the actual short-term policy start for premium age validation', () => {
    const candidate = plan({ family: 'short_term', effectiveStart: '2026-07-01', effectiveEnd: '2026-09-30', rating: { age: 46, minAge: 46, maxAge: 46 } });
    const result = cost([], candidate, { profile: { ...profile, dateOfBirth: '1980-06-01' } });
    expect(result.premiumCents).toBe(30_000);
    expect(result.coverageMonths).toBe(3);
    expect(result.totalCents).toBeNull(); // The policy still does not cover the entire requested year.
  });
});

describe('condition and preference isolation', () => {
  it('never applies one plan authorization to another plan with the same benefit ID', () => {
    const a = plan({ id: 'a', benefits: [benefit({ priorAuthorization: true })] });
    const b = plan({ id: 'b', benefits: [benefit({ priorAuthorization: true })] });
    const care = event('service', 10_000);
    const aCondition = getApplicableConditions(a, care, [], [])[0];
    const results = comparePlans(input([{ ...care, conditions: [{ conditionId: aCondition.id, status: 'satisfied' }] }]), [a, b]);
    expect(results.map(result => result.cost.lines[0].coverage)).toEqual(['covered', 'conditional']);
    expect(getApplicableConditions(b, care, [], [])[0].id).not.toBe(aCondition.id);
  });
  it('qualifies raw source conditions and drug requirements by plan', () => {
    const a = plan({ id: 'a', conditions: [{ id: 'eligibility', label: 'Source condition' }], benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', priorAuthorization: true, source }] });
    const b = { ...a, id: 'b' };
    const care = event('drug', 10_000, { category: 'prescription', medicationId: medication.id });
    const left = getApplicableConditions(a, care, [], [medication]).map(item => item.id);
    const right = getApplicableConditions(b, care, [], [medication]).map(item => item.id);
    expect(left.filter(id => right.includes(id))).toEqual([]);
    expect(getPlanConditions(a)[0].id).not.toBe(getPlanConditions(b)[0].id);
  });
  it('keeps conflicting condition confirmations unresolved', () => {
    const candidate = plan({ underwritingRequired: true }); const id = getPlanConditions(candidate)[0].id;
    expect(cost([], candidate, { conditions: [{ conditionId: id, status: 'satisfied' }, { conditionId: id, status: 'not_satisfied' }] }).totalCents).toBeNull();
  });
  it('respects preferred/ongoing summary selection without losing event identity lookup', () => {
    const candidate = plan({ benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }] });
    const result = comparePlans(input([event('drug', 10_000, { category: 'prescription', medicationId: medication.id })], { medications: [{ ...medication, ongoing: false }], providers: [{ id: 'p', name: 'Historical provider', preferred: false }] }), [candidate])[0];
    expect(result.providerMatches).toEqual([]); expect(result.medicationMatches).toEqual([]);
    expect(result.cost.lines[0].patientCents).toBe(10_000);
  });
  it('normalizes hyphenated NDCs consistently for matching and candidate drug pricing', () => {
    const candidate = plan({ benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }], prices: [{ id: 'rx-price', category: 'prescription', medicationCode: medication.ndc, unitPriceCents: 30_000, quantityUnit: 'fill', basis: 'contracted', source }] });
    const entered = { ...medication, ndc: '12345-6789-01' };
    expect(matchMedication(entered, candidate).status).toBe('covered');
    expect(cost([event('drug', null, { category: 'prescription', medicationId: medication.id })], candidate, { medications: [entered] }).lines[0].allowedCents).toBe(30_000);
  });
});

describe('additional Medicare premium scenarios', () => {
  const candidate = () => plan({ family: 'medicare_advantage' });
  it.each([undefined, null])('leaves a complete MA total unknown when additional premiums are %s, retaining known plan and care costs', monthly => {
    const result = cost([event('care', 10_000)], candidate(), { additionalMonthlyPremiums: monthly === undefined ? undefined : { 'synthetic-plan': monthly } });
    expect(result.planPremiumCents).toBe(120_000);
    expect(result.additionalPremiumCents).toBeNull();
    expect(result.premiumCents).toBeNull();
    expect(result.totalCents).toBeNull();
    expect(result.knownSubtotalCents).toBe(130_000);
    expect(result.warnings.join(' ')).toContain('Additional Medicare premiums are missing');
  });
  it('accepts an explicitly entered zero without assuming it from missing information', () => {
    const result = cost([], candidate(), { additionalMonthlyPremiums: { 'synthetic-plan': 0 } });
    expect(result.additionalPremiumCents).toBe(0);
    expect(result.premiumCents).toBe(120_000);
    expect(result.totalCents).toBe(120_000);
    expect(result.estimated).toBe(true);
  });
  it('adds separate plan and additional premiums exactly once for the selected months', () => {
    const result = cost([event('care', 10_000, { date: '2026-05-01' })], candidate(), { profile: { ...profile, coverageStart: '2026-04-01', coverageEnd: '2026-06-30' }, additionalMonthlyPremiums: { 'synthetic-plan': 23_456 } });
    expect(result.coverageMonths).toBe(3);
    expect(result.planPremiumCents).toBe(30_000);
    expect(result.additionalPremiumCents).toBe(70_368);
    expect(result.premiumCents).toBe(100_368);
    expect(result.totalCents).toBe(110_368);
    expect(result.estimated).toBe(true);
  });
  it('retains a known additional premium component when the candidate premium is unknown', () => {
    const result = cost([event('care', 10_000)], plan({ family: 'medicare_advantage', monthlyPremiumCents: null }), { additionalMonthlyPremiums: { 'synthetic-plan': 1_200 } });
    expect(result.planPremiumCents).toBeNull();
    expect(result.additionalPremiumCents).toBe(14_400);
    expect(result.premiumCents).toBeNull();
    expect(result.totalCents).toBeNull();
    expect(result.knownSubtotalCents).toBe(24_400);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('treats invalid additional monthly cents %s as unknown', monthly => {
    const result = cost([], candidate(), { additionalMonthlyPremiums: { 'synthetic-plan': monthly } });
    expect(result.additionalPremiumCents).toBeNull();
    expect(result.totalCents).toBeNull();
    expect(result.knownSubtotalCents).toBe(120_000);
    expect(result.warnings.join(' ')).toContain('additional Medicare premium scenario is invalid');
  });
  it('rejects coverage-period and combined premium overflow without losing known components', () => {
    const extended = cost([], candidate(), { additionalMonthlyPremiums: { 'synthetic-plan': Number.MAX_SAFE_INTEGER } });
    expect(extended.additionalPremiumCents).toBeNull();
    expect(extended.knownSubtotalCents).toBe(120_000);
    expect(extended.totalCents).toBeNull();
    const combined = cost([], plan({ family: 'medicare_advantage', monthlyPremiumCents: Number.MAX_SAFE_INTEGER - 10 }), { profile: { ...profile, coverageEnd: '2026-01-31' }, additionalMonthlyPremiums: { 'synthetic-plan': 11 } });
    expect(combined.planPremiumCents).toBe(Number.MAX_SAFE_INTEGER - 10);
    expect(combined.additionalPremiumCents).toBe(11);
    expect(combined.premiumCents).toBeNull();
    expect(combined.totalCents).toBeNull();
    expect(Number.isSafeInteger(combined.knownSubtotalCents)).toBe(true);
    expect(combined.warnings.join(' ')).toContain('monetary precision');
  });
  it.each(['aca', 'short_term'] as const)('ignores additional premium overrides for %s plans', family => {
    expect(cost([], plan({ family }), { additionalMonthlyPremiums: { 'synthetic-plan': 99_999 } })).toEqual(cost([], plan({ family })));
    expect(cost([], plan({ family })).additionalPremiumCents).toBe(0);
  });
  it('never shares a premium scenario between candidates', () => {
    const results = comparePlans(input([], { additionalMonthlyPremiums: { 'synthetic-plan': 0 } }), [candidate(), plan({ id: 'another-plan', family: 'medicare_advantage' })]);
    expect(results.map(item => item.cost.totalCents)).toEqual([120_000, null]);
  });
});

describe('source-configured drug phases', () => {
  const candidate = () => plan({ family: 'medicare_advantage', benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug' })], drugs: [{ ...medication, coverage: 'covered', source }], drugBenefitPhases: { source, phases: [
    { id: 'deductible', label: 'Synthetic deductible', until: { ledger: 'drug_allowed', cents: 10_000 }, coinsuranceBps: 10_000, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 },
    { id: 'initial', label: 'Synthetic initial', until: { ledger: 'drug_oop', cents: 20_000 }, coinsuranceBps: 2500, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 },
    { id: 'final', label: 'Synthetic final', until: null, coinsuranceBps: 0, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 },
  ] } });
  it('splits a fill across deductible and spending phases using the supplied rule version', () => {
    const result = cost([event('fill', 100_000, { category: 'prescription', medicationId: medication.id })], candidate(), { medications: [medication] });
    expect(result.careCents).toBe(20_000);
    expect(result.lines[0].explanation.join(' ')).toContain('Synthetic final');
    expect(result.lines[0].sourceIds).toContain(source.id);
  });
  it('never substitutes a hardcoded standard drug design for a missing plan adapter', () => {
    const current = candidate(); delete current.drugBenefitPhases;
    expect(cost([event('fill', 100_000, { category: 'prescription', medicationId: medication.id })], current, { medications: [medication], additionalMonthlyPremiums: { 'synthetic-plan': 0 } }).lines[0].patientCents).toBeNull();
  });
  it('uses source-defined tier-specific phase overrides', () => {
    const current = candidate();
    current.benefits[0].drugPhaseOverrides = { deductible: { coinsuranceBps: 0 } };
    expect(cost([event('fill', 10_000, { category: 'prescription', medicationId: medication.id })], current, { medications: [medication] }).careCents).toBe(0);
  });
  it('rejects malformed phase sequences rather than looping or inventing a final phase', () => {
    const current = candidate(); current.drugBenefitPhases!.phases.pop();
    expect(cost([event('fill', 100_000, { category: 'prescription', medicationId: medication.id })], current, { medications: [medication], additionalMonthlyPremiums: { 'synthetic-plan': 0 } }).lines[0].patientCents).toBeNull();
  });
});

describe('review regressions for price and effective-date identity', () => {
  const rxPlan = (patch: Partial<Plan> = {}) => plan({ benefits: [benefit({ id: 'rx', category: 'prescription', accumulator: 'drug', appliesDeductible: false, coinsuranceBps: 10_000 })], drugOopMaxCents: 100_000, drugs: [{ ...medication, coverage: 'covered', source }], ...patch });
  const fill = () => event('fill', null, { category: 'prescription', medicationId: medication.id, quantityUnit: 'fill', dispensedQuantity: 30, daysSupply: 30 });
  const price = (id: string, quantityUnit: 'fill' | 'dispensed_unit', unitPriceCents = 1000) => ({ id, category: 'prescription' as const, medicationCode: medication.ndc, unitPriceCents, basis: 'contracted' as const, priceType: 'allowed' as const, quantityUnit, dispensedQuantity: 30, daysSupply: 30, source });
  it('rejects contradictory fill/unit prices after quantity extension regardless of row IDs', () => {
    for (const prices of [[price('a', 'fill'), price('z', 'dispensed_unit')], [price('z', 'fill'), price('a', 'dispensed_unit')]]) {
      const result = cost([fill()], rxPlan({ prices }), { medications: [medication] });
      expect(result.lines[0].patientCents).toBeNull();
      expect(result.totalCents).toBeNull();
      expect(result.lines[0].explanation.join(' ')).toContain('conflict after extending');
    }
  });
  it('accepts equivalent fill/unit observations after quantity extension', () => {
    const result = cost([fill()], rxPlan({ prices: [price('fill', 'fill', 30_000), price('unit', 'dispensed_unit')] }), { medications: [medication] });
    expect(result.lines[0].allowedCents).toBe(30_000);
    expect(result.careCents).toBe(30_000);
  });
  it('requires product details when an NDC-bearing medication actually falls back to RxNorm', () => {
    const selected = { id: 'rx', name: 'Unspecified product', ndc: '12345678901', rxnorm: '12345', ongoing: true };
    const candidate = plan({ drugs: [{ name: 'Product', rxnorm: '12345', coverage: 'covered', source }] });
    expect(matchMedication(selected, candidate).status).toBe('unknown');
    expect(matchMedication({ ...selected, strength: '10 mg', form: 'tablet' }, candidate).status).toBe('unknown');
    candidate.drugs[0] = { ...candidate.drugs[0], strength: '10 mg', form: 'tablet' };
    expect(matchMedication({ ...selected, strength: '10 mg', form: 'tablet' }, candidate).status).toBe('covered');
  });
  it('lets an actual exact NDC match establish the product without an ambiguous RxNorm fallback', () => {
    const selected = { id: 'rx', name: 'Product', ndc: '12345678901', rxnorm: '12345', ongoing: true };
    const candidate = plan({ drugs: [{ name: 'Exact product', ndc: selected.ndc, coverage: 'covered', source }, { name: 'Broad concept', rxnorm: selected.rxnorm, coverage: 'not_covered', source }] });
    expect(matchMedication(selected, candidate).status).toBe('covered');
  });
  it('preserves exact NDC absence from a complete formulary without requiring an imaginary RxNorm fallback', () => {
    const selected = { id: 'rx', name: 'Product', ndc: '12345678901', ongoing: true };
    const candidate = plan({ drugs: [], formularyComplete: true });
    expect(matchMedication(selected, candidate).status).toBe('not_covered');
    expect(matchMedication({ ...selected, rxnorm: '12345' }, candidate).status).toBe('not_covered');
  });
  it('does not infer earlier absence from a future complete release', () => {
    const candidate = plan({ source: { ...source, effectiveDate: '2026-07-01' }, formularyComplete: true, networkComplete: true });
    const provider = { id: 'provider', name: 'Clinician', npi: '1234567890', location: '1 Main St', preferred: true };
    expect(matchMedication(medication, candidate, '2026-01-01').status).toBe('unknown');
    expect(matchProvider(provider, candidate, '2026-01-01').status).toBe('unknown');
    expect(matchMedication(medication, candidate, '2026-07-01').status).toBe('not_covered');
    expect(matchProvider(provider, candidate, '2026-07-01').status).toBe('out_of_network');
  });
  it('uses each event date for formulary coverage and conditions, and the coverage start for summaries', () => {
    const future = { ...source, effectiveDate: '2026-07-01' };
    const candidate = rxPlan({ drugs: [{ ...medication, coverage: 'covered', priorAuthorization: true, source: future }] });
    const before = { ...fill(), date: '2026-01-15' };
    const after = { ...fill(), date: '2026-07-15' };
    expect(matchMedication(medication, candidate, before.date).status).toBe('unknown');
    expect(matchMedication(medication, candidate, after.date).status).toBe('conditional');
    expect(getApplicableConditions(candidate, before, [], [medication])).toEqual([]);
    const conditions = getApplicableConditions(candidate, after, [], [medication]);
    expect(conditions).toHaveLength(1);
    const result = comparePlans(input([{ ...after, unitPriceCents: 10_000, conditions: [{ conditionId: conditions[0].id, status: 'satisfied' }] }], { medications: [medication] }), [candidate])[0];
    expect(result.medicationMatches[0].status).toBe('unknown');
    expect(result.cost.lines[0].coverage).toBe('covered');
    expect(cost([{ ...before, unitPriceCents: 10_000 }], candidate, { medications: [medication] }).lines[0].patientCents).toBeNull();
  });
  it('does not establish network membership before its source becomes effective', () => {
    const provider = { id: 'provider', name: 'Clinician', npi: '1234567890', location: '1 Main St', preferred: true };
    const candidate = plan({ providers: [{ ...provider, network: 'in_network', source: { ...source, effectiveDate: '2026-07-01' } }] });
    expect(matchProvider(provider, candidate, '2026-01-15').status).toBe('unknown');
    expect(matchProvider(provider, candidate, '2026-07-15').status).toBe('in_network');
  });
});

describe('separate source-defined Medicare deductible credit', () => {
  const other = { ...medication, id: 'other', ndc: '98765432100' };
  const candidate = (ledger: 'drug_allowed' | 'drug_deductible' = 'drug_deductible') => plan({ family: 'medicare_advantage', benefits: [benefit({ id: 'exempt', category: 'prescription', drugTier: '1', accumulator: 'drug', appliesDeductible: false, drugPhaseOverrides: { deductible: { coinsuranceBps: 0, copayCents: 500 } } }), benefit({ id: 'standard', category: 'prescription', drugTier: '2', accumulator: 'drug', appliesDeductible: true })], drugs: [{ ...medication, tier: '1', coverage: 'covered', source }, { ...other, tier: '2', coverage: 'covered', source }], drugBenefitPhases: { source, phases: [{ id: 'deductible', label: 'Source deductible', until: { ledger, cents: 10_000 }, coinsuranceBps: 10_000, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 }, { id: 'initial', label: 'Source initial', until: { ledger: 'drug_oop', cents: 12_000 }, coinsuranceBps: 2500, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 }, { id: 'final', label: 'Source final', until: null, coinsuranceBps: 0, patientOopCreditBps: 10_000, additionalOopCreditBps: 0 }] } });
  const fills = () => [event('exempt', 10_000, { category: 'prescription', medicationId: medication.id }), event('standard', 10_000, { category: 'prescription', medicationId: other.id, date: '2026-02-01' }), event('after', 10_000, { category: 'prescription', medicationId: other.id, date: '2026-03-01' })];
  it('credits an exempt copay to TrOOP without satisfying the separate deductible', () => {
    const result = cost(fills(), candidate(), { medications: [medication, other], additionalMonthlyPremiums: { 'synthetic-plan': 0 } });
    expect(result.lines.map(line => line.patientCents)).toEqual([500, 10_000, 1_500]);
    expect(result.lines[0].explanation.join(' ')).toContain('0 deductible-credit cents');
    expect(result.lines[1].explanation.join(' ')).toContain('10000 deductible-credit cents');
    expect(result.totalCents).toBe(132_000);
  });
  it('honors an explicit source-defined deductible credit override', () => {
    const current = candidate(); current.benefits[0].drugPhaseOverrides!.deductible = { coinsuranceBps: 0, deductibleCreditBps: 10_000 };
    const result = cost(fills().slice(0, 2), current, { medications: [medication, other], additionalMonthlyPremiums: { 'synthetic-plan': 0 } });
    expect(result.lines.map(line => line.patientCents)).toEqual([0, 2500]);
  });
  it('preserves deliberately configured gross-allowed transition semantics', () => {
    const result = cost(fills().slice(0, 2), candidate('drug_allowed'), { medications: [medication, other], additionalMonthlyPremiums: { 'synthetic-plan': 0 } });
    expect(result.lines.map(line => line.patientCents)).toEqual([500, 2500]);
  });
});

describe('identity matching', () => {
  it('requires exact NPI and location and does not infer status from names', () => {
    const candidate = plan({ providers: [{ npi: '1234567890', name: 'Clinician', location: '1 Main St', network: 'in_network', source }] });
    expect(matchProvider({ id: 'p', name: 'Clinician', preferred: true }, candidate).status).toBe('unknown');
    expect(matchProvider({ id: 'p', name: 'Clinician', npi: '1234567890', preferred: true }, candidate).status).toBe('unknown');
    expect(matchProvider({ id: 'p', name: 'Different display name', npi: '1234567890', location: '1 MAIN ST', preferred: true }, candidate).status).toBe('in_network');
  });
  it('distinguishes absent incomplete networks and conflicting network entries', () => {
    const provider = { id: 'p', name: 'Clinician', npi: '1234567890', location: '1 Main St', preferred: true };
    expect(matchProvider(provider, plan()).status).toBe('unknown');
    expect(matchProvider(provider, plan({ networkComplete: true })).status).toBe('out_of_network');
    expect(matchProvider(provider, plan({ providers: [{ ...provider, network: 'in_network', source }, { ...provider, network: 'out_of_network', source }] })).status).toBe('unknown');
  });
  it('does not substitute names, strengths or NDCs through a shared RxNorm concept', () => {
    const candidate = plan({ drugs: [{ ...medication, rxnorm: '123', coverage: 'covered', source }] });
    expect(matchMedication({ ...medication, ndc: undefined }, candidate).status).toBe('unknown');
    expect(matchMedication({ ...medication, strength: '20 mg' }, candidate).status).toBe('unknown');
    expect(matchMedication({ ...medication, ndc: '99999999999', rxnorm: '123' }, candidate).status).toBe('unknown');
    expect(matchMedication(medication, candidate).status).toBe('covered');
  });
  it('surfaces drug utilization conditions and incomplete formularies', () => {
    expect(matchMedication(medication, plan()).status).toBe('unknown');
    expect(matchMedication(medication, plan({ formularyComplete: true })).status).toBe('not_covered');
    expect(matchMedication(medication, plan({ drugs: [{ ...medication, coverage: 'covered', priorAuthorization: true, source }] })).status).toBe('conditional');
  });
});

describe('historical reconciliation and forecast', () => {
  it('is idempotent and honors numeric source revisions and reversals', () => {
    const records = [history(), history(), history({ version: '2', status: 'reversed' })];
    const result = normalizeHistory(records);
    expect(result).toHaveLength(1); expect(result[0].status).toBe('reversed');
    expect(normalizeHistory(result)).toEqual(result);
    expect(buildForecast(records, 2026)).toEqual([]);
  });
  it('keeps equal-version conflicts unknown instead of choosing a paid claim', () => {
    expect(normalizeHistory([history(), history({ status: 'reversed' })])[0].status).toBe('unknown');
  });
  it('honors explicit replacements and preserves separate professional/facility lines', () => {
    const records = [history(), history({ id: 'replacement', replacesId: 'claim-line' }), history({ id: 'facility', claimId: 'same-claim' }), history({ id: 'professional', claimId: 'same-claim' })];
    const forecast = buildForecast(records, 2026);
    expect(forecast).toHaveLength(3);
    expect(normalizeHistory(records).find(item => item.id === 'claim-line')?.status).toBe('cancelled');
  });
  it('does not count an explicitly linked encounter as another billed event', () => {
    const records = [history({ encounterId: 'Encounter/one' }), history({ id: 'enc', kind: 'encounter', encounterId: 'Encounter/one' })];
    expect(buildForecast(records, 2026)).toHaveLength(1);
  });
  it('excludes orders, other years and cancelled events, and requires forecast confirmation', () => {
    const records = [history(), history({ id: 'order', kind: 'prescription_order' }), history({ id: 'old', date: '2024-01-01' }), history({ id: 'cancelled', status: 'cancelled' })];
    const forecast = buildForecast(records, 2026);
    expect(forecast).toHaveLength(1); expect(forecast[0]).toMatchObject({ date: '2026-06-12', confirmed: false, priceBasis: 'historical', unitPriceCents: 10_000 });
  });
  it('clamps a leap-day anniversary without inventing an invalid date', () => {
    expect(buildForecast([history({ date: '2024-02-29' })], 2025)[0].date).toBe('2025-02-28');
  });
});

describe('preliminary eligibility', () => {
  it('separates preliminary plan access from an uncalculated subsidy', () => {
    const aca = evaluateEligibility(profile).find(item => item.family === 'aca')!;
    expect(aca.status).toBe('likely_eligible');
    expect(aca.reasons.join(' ')).toContain('Financial assistance is not calculated');
    expect(aca.sources.length).toBeGreaterThan(0);
  });
  it('collects tax-household and employer-offer context even for one enrollee', () => {
    const aca = evaluateEligibility({ ...profile, taxFilingStatus: undefined, employerOffer: 'yes', employerOfferRelationship: 'unknown' })[0];
    expect(aca.missing.join(' ')).toContain('Tax filing status');
    expect(aca.missing.join(' ')).toContain('Whose employer');
    expect(aca.missing.join(' ')).toContain('premium contribution');
  });
  it('does not infer Medicare entitlement from age or short-term acceptance from records', () => {
    const results = evaluateEligibility({ ...profile, dateOfBirth: '1940-01-01', medicarePartA: 'unknown', medicarePartB: 'unknown' });
    expect(results.find(item => item.family === 'medicare_advantage')?.status).toBe('unknown');
    expect(results.find(item => item.family === 'short_term')?.status).toBe('unknown');
  });
});
