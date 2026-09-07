import { z } from 'zod';
import { PLAN_FAMILIES, SERVICE_CATEGORIES } from '../shared/contracts';
import {STATE_FIPS} from './state-fips';
import {normalizeNdc,normalizeMedicationCode} from '../shared/identifiers';

export const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'] as const;
export const stateSchema = z.enum(STATES);
const id = z.string().min(1).max(180).regex(/^[\w.:/-]+$/);
const text = z.string().max(12000);
const money = z.number().int().nonnegative().max(100_000_000_000);
export const dateSchema = z.iso.date();
export const publicUrlSchema = z.url().max(2048).refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
}, 'A public HTTPS URL without credentials or fragment is required');
export const sourceSchema = z.strictObject({ id, publisher: z.string().min(1).max(300), url: publicUrlSchema,
  retrievedAt: z.iso.datetime({ offset: true }), effectiveDate: dateSchema, version: z.string().min(1).max(180), location: text.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const family = z.enum(PLAN_FAMILIES);
const category = z.enum(SERVICE_CATEGORIES);
const coverage = z.enum(['covered', 'not_covered', 'conditional', 'unknown']);
const npi = z.string().regex(/^\d{10}$/);
const ndc = z.string().trim().max(30).regex(/^[\d-]+$/).transform(normalizeNdc).pipe(z.string().regex(/^\d{10,12}$/));
const serviceCode = z.string().trim().min(1).max(250);
const county = z.string().regex(/^\d{5}$/);
const conditionSchema = z.strictObject({ id, label: text, source: sourceSchema.optional() });
const basisPoints = z.number().int().min(0).max(10000);
const phaseSchema = z.strictObject({ id, label: text, until: z.strictObject({ ledger: z.enum(['drug_allowed','drug_oop','drug_deductible']), cents: money }).nullable(),
  coinsuranceBps: basisPoints, copayCents: money.optional(), patientOopCreditBps: basisPoints, additionalOopCreditBps: basisPoints });
export const benefitSchema = z.strictObject({ id, category, label: text, coverage,
  serviceCodes:z.array(serviceCode).max(2000).optional(), drugTier:z.string().max(100).optional(), drugPhaseOverrides:z.record(z.string().max(180),z.strictObject({coinsuranceBps:basisPoints,copayCents:money.optional(),deductibleCreditBps:basisPoints.optional()})).optional(),
  deductibleAccumulatorId: id.optional(), oopAccumulatorIds: z.array(id).max(20).optional(), deductibleCountsTowardOop: z.boolean().optional(), copayCountsTowardOop: z.boolean().optional(), coinsuranceCountsTowardOop: z.boolean().optional(),
  costSharingOrder: z.enum(['copay_then_coinsurance','greater_of','lesser_of']).optional(), copayBeforeDeductible: z.boolean().optional(), conditions: z.array(conditionSchema).max(100).optional(),
  network: z.enum(['in_network','out_of_network','any']), copayCents: money.nullable(), coinsuranceBps: z.number().int().min(0).max(10000).nullable(),
  appliesDeductible: z.boolean(), accumulator: z.enum(['medical','drug','none']), deductibleCents: money.nullable().optional(), oopMaxCents: money.nullable().optional(),
  visitLimit: z.number().int().nonnegative().optional(), insurerPaymentCapCents: money.optional(), waitingDays: z.number().int().nonnegative().optional(),
  priorAuthorization: z.boolean().optional(), referralRequired: z.boolean().optional(), explanation: text, source: sourceSchema });
export const providerSchema = z.strictObject({ npi, name: text, location: text, network: z.enum(['in_network','out_of_network','unknown']), source: sourceSchema });
export const drugSchema = z.strictObject({ rxnorm: z.string().regex(/^\d{1,12}$/).optional(), ndc: ndc.optional(), name: text,
  strength: text.optional(), form: text.optional(), coverage, tier: text.optional(), priorAuthorization: z.boolean().optional(), stepTherapy: z.boolean().optional(), quantityLimit: text.optional(), source: sourceSchema })
  .refine(value => !!value.rxnorm || !!value.ndc, 'A formulary entry must have an exact drug identifier');
export const priceSchema = z.strictObject({ id, category, serviceCode: serviceCode.optional(), providerNpi: npi.optional(), medicationCode: z.string().trim().min(1).max(40).transform(normalizeMedicationCode).optional(),
  priceType:z.enum(['allowed','cash','billed']).optional(),balanceBillingCents:money.optional(),
  quantityUnit:z.enum(['service','fill','dispensed_unit']).optional(),dispensedQuantity:z.number().positive().max(100000).optional(),daysSupply:z.number().positive().max(366).optional(),providerLocation:text.optional(),
  unitPriceCents: money, basis: z.enum(['contracted','plan_average','regional_estimate']), source: sourceSchema });
export const planSchema = z.strictObject({ id, name: z.string().min(1).max(1000), issuer: z.string().min(1).max(500), family, year: z.number().int().min(2026).max(2100),
  medicalOopUnbounded:z.boolean().optional(),drugOopUnbounded:z.boolean().optional(),
  accumulators: z.array(z.strictObject({ id, deductibleCents: money.nullable(), oopMaxCents: money.nullable(),oopUnbounded:z.boolean().optional() })).max(100).optional(), insurerPaymentCapCents: money.nullable().optional(), conditions: z.array(conditionSchema).max(100).optional(),
  drugBenefitPhases: z.strictObject({ phases: z.array(phaseSchema).min(1).max(20), source: sourceSchema }).optional(),
  state: stateSchema, countyFips: z.array(county).min(1).max(4000), status: z.enum(['available','withdrawn','unknown']), effectiveStart: dateSchema, effectiveEnd: dateSchema,
  serviceAreas: z.array(z.strictObject({ countyFips: county, zipCodes: z.array(z.string().regex(/^\d{5}$/)).min(1).max(5000).optional(), wholeCounty: z.boolean(), source:sourceSchema.optional() })).max(4000).optional(),
  monthlyPremiumCents: money.nullable(), premiumEstimated: z.boolean(), deductibleCents: money.nullable(), oopMaxCents: money.nullable(),
  drugDeductibleCents: money.nullable(), drugOopMaxCents: money.nullable(), metalLevel: text.optional(), planType: text.optional(),
  benefits: z.array(benefitSchema).max(1000), providers: z.array(providerSchema).max(2_000_000), drugs: z.array(drugSchema).max(200_000), prices: z.array(priceSchema).max(2_000_000),
  source: sourceSchema, documentUrls: z.array(z.strictObject({ label: text, url: publicUrlSchema })).max(100), rulesVerified: z.boolean(), underwritingRequired: z.boolean(),
  networkComplete: z.boolean(), formularyComplete: z.boolean(),
  rating: z.strictObject({ minAge: z.number().int().min(0).max(120).optional(), maxAge: z.number().int().min(0).max(120).optional(), tobacco: z.boolean().optional(), age: z.number().int().min(0).max(120).optional(), countyFips: county.optional() }).optional()
}).superRefine((p, ctx) => {
  if (p.effectiveStart > p.effectiveEnd || !p.effectiveStart.startsWith(`${p.year}-`) || !p.effectiveEnd.startsWith(`${p.year}-`)) ctx.addIssue({ code: 'custom', message: 'Plan effective dates must be ordered and within its plan year' });
  if (p.monthlyPremiumCents !== null) ctx.addIssue({ code: 'custom', message: 'Canonical base premium must be null; supply explicit profile-valid premiumRates (including fixed MA rates)' });
  if (new Set(p.countyFips).size !== p.countyFips.length) ctx.addIssue({ code: 'custom', message: 'Duplicate counties' });
  if(p.countyFips.some(c=>!c.startsWith(STATE_FIPS[p.state])))ctx.addIssue({code:'custom',message:'County FIPS must belong to the plan state'});
  if (p.serviceAreas) {
    const areas = new Map(p.serviceAreas.map(a => [a.countyFips,a]));
    if (areas.size !== p.serviceAreas.length || areas.size !== p.countyFips.length || p.countyFips.some(c => !areas.has(c))) ctx.addIssue({ code:'custom',message:'Service areas must correspond one-to-one to plan counties' });
    for (const area of p.serviceAreas) if (!area.wholeCounty && !area.zipCodes?.length) ctx.addIssue({ code:'custom',message:'Partial county requires ZIP codes' });
  }
});
export const premiumRateSchema = z.strictObject({ id, planId: id, countyFips: county, minAge: z.number().int().min(0).max(120), maxAge: z.number().int().min(0).max(120),
  zipPrefixes: z.array(z.string().regex(/^\d{3}(?:\d{2})?$/)).min(1).max(1000).optional(),
  tobacco: z.enum(['yes','no','any']), effectiveStart: dateSchema, effectiveEnd: dateSchema, monthlyPremiumCents: money, estimated: z.boolean(), source: sourceSchema
}).refine(r => r.minAge <= r.maxAge && r.effectiveStart <= r.effectiveEnd, 'Invalid rate age/date range');
export const coverageSchema = z.strictObject({ state: stateSchema, family, year: z.number().int().min(2026).max(2100), status: z.enum(['available','not_offered','source_gap']),
  planCount: z.number().int().nonnegative(), lastUpdated: z.iso.datetime({ offset: true }).nullable(), note: z.string().min(1).max(12000) });
export const catalogSchema = z.strictObject({ schemaVersion: z.literal(1), dataClass: z.literal('public_reference'),
  release: z.strictObject({ id, year: z.number().int().min(2026).max(2100), createdAt: z.iso.datetime({ offset: true }), publisher: z.string().min(1).max(300),
    productionData: z.literal(true), rightsConfirmed: z.literal(true), provenanceReviewedBy: z.string().min(1).max(300) }),
  sources: z.array(sourceSchema).min(1).max(10000), plans: z.array(planSchema).max(200000), premiumRates: z.array(premiumRateSchema).max(10000000), coverage: z.array(coverageSchema).max(1000)
}).superRefine((c, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sourceMap = new Map(c.sources.map(s => [s.id, s]));
  if (sourceMap.size !== c.sources.length) fail('Duplicate source IDs');
  const plans = new Map(c.plans.map(p => [p.id, p]));
  if (plans.size !== c.plans.length) fail('Duplicate plan IDs');
  const validateSource = (s: z.infer<typeof sourceSchema>) => {
    const canonical = sourceMap.get(s.id);
    if (!canonical || canonical.url !== s.url || canonical.version !== s.version || canonical.retrievedAt !== s.retrievedAt || canonical.effectiveDate !== s.effectiveDate || canonical.publisher !== s.publisher || canonical.sha256 !== s.sha256) fail(`Unregistered or inconsistent source ${s.id}`);
  };
  const expected = new Map<string, number>();
  for (const p of c.plans) {
    if (p.year !== c.release.year) fail(`Plan ${p.id} has a different year from release`);
    expected.set(`${p.state}:${p.family}`, (expected.get(`${p.state}:${p.family}`) ?? 0) + 1);
    validateSource(p.source);
    for(const area of p.serviceAreas??[])if(area.source)validateSource(area.source);
    if (p.drugBenefitPhases) validateSource(p.drugBenefitPhases.source);
    for (const condition of [...p.conditions ?? [], ...p.benefits.flatMap(b => b.conditions ?? [])]) if (condition.source) validateSource(condition.source);
    for (const collection of [p.benefits,p.providers,p.drugs,p.prices]) for (const row of collection) validateSource(row.source);
    if (new TextEncoder().encode(JSON.stringify({ ...p, serviceAreas: undefined, providers: [], drugs: [], prices: [] })).length > 80_000) fail(`Plan ${p.id} summary exceeds serving size limit`);
  }
  const rateIds = new Set<string>();
  for (const r of c.premiumRates) {
    const p = plans.get(r.planId);
    if (rateIds.has(r.id)) fail(`Duplicate rate ${r.id}`);
    rateIds.add(r.id);
    if (!p || !p.countyFips.includes(r.countyFips) || r.effectiveStart < p.effectiveStart || r.effectiveEnd > p.effectiveEnd) fail(`Rate ${r.id} does not match a plan, county or effective interval`);
    validateSource(r.source);
  }
  const coverageKeys = new Set<string>();
  for (const row of c.coverage) {
    const key = `${row.state}:${row.family}`;
    if (coverageKeys.has(key)) fail(`Duplicate coverage declaration ${key}`);
    coverageKeys.add(key);
    if (row.year !== c.release.year || row.planCount !== (expected.get(key) ?? 0)) fail(`Incorrect coverage count/year ${key}`);
    if ((row.status === 'not_offered' && row.planCount !== 0) || (row.status === 'available' && row.planCount === 0)) fail(`Contradictory coverage declaration ${key}`);
    if (row.status === 'available' && !c.plans.some(p => p.state === row.state && p.family === row.family && p.status !== 'withdrawn')) fail(`Available coverage requires a non-withdrawn plan ${key}`);
  }
  for (const key of expected.keys()) if (!coverageKeys.has(key)) fail(`Missing coverage declaration ${key}`);
});
export type CanonicalCatalog = z.infer<typeof catalogSchema>;
export type PremiumRate = z.infer<typeof premiumRateSchema>;
export function validateCatalog(value: unknown): CanonicalCatalog { return catalogSchema.parse(value); }
