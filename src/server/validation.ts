import { z } from 'zod';
import { SERVICE_CATEGORIES, PLAN_FAMILIES } from '../shared/contracts';
import { stateSchema } from '../catalog/schema';
import { STATE_FIPS } from '../catalog/state-fips';

const short = z.string().trim().max(250);
export const idSchema = z.string().min(1).max(250);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Enter a valid date');
const money = z.number().int().min(0).max(100_000_000_000).nullable();
const ternary = z.enum(['yes', 'no', 'unknown']);
export const profileSchema = z.object({
  dateOfBirth: dateSchema, state: stateSchema, countyFips: z.string().regex(/^\d{5}$/), zip: z.string().regex(/^\d{5}$/),
  householdSize: z.number().int().min(1).max(30), annualIncomeCents: money,
  employerOffer: ternary, employerMonthlyContributionCents: money, employerMinimumValue: ternary,
  medicarePartA: ternary, medicarePartB: ternary, tobacco: z.enum(['yes', 'no']),
  coverageStart: dateSchema, coverageEnd: dateSchema, citizenshipEligible: ternary, incarcerated: ternary,
  enrollmentEvent: z.enum(['open_enrollment', 'loss_of_coverage', 'other', 'unknown']),
  taxFilingStatus: z.enum(['single', 'joint', 'separate', 'head_of_household', 'unknown']).optional(),
  claimedAsDependent: ternary.optional(), employerOfferRelationship: z.enum(['self', 'household_member', 'unknown']).optional(),
  employerOfferStart: dateSchema.optional(), employerOfferEnd: dateSchema.optional(),
}).refine(p => p.countyFips.startsWith(STATE_FIPS[p.state]), { path: ['countyFips'], message: 'Select a county within the chosen state' }).refine(p => p.coverageEnd >= p.coverageStart, { path: ['coverageEnd'], message: 'Coverage must end on or after it begins' })
  .refine(p => p.coverageStart.startsWith('2026-') && p.coverageEnd.startsWith('2026-'), { path: ['coverageStart'], message: 'This release compares 2026 coverage' })
  .refine(p => p.dateOfBirth <= p.coverageStart, { path: ['dateOfBirth'], message: 'Birth date must be before coverage' });
export const evidenceSchema = z.object({ id: idSchema, source: short, resourceId: short.optional(), date: short.optional(), text: z.string().max(4000).optional(), method: z.enum(['structured_import', 'user_entered', 'ai_proposed']), confirmed: z.boolean() });
export const providerSchema = z.object({ id: idSchema, name: short.min(1), npi: z.string().regex(/^\d{10}$/).or(z.literal('')).optional(), specialty: short.optional(), location: short.optional(), preferred: z.boolean(), evidence: z.array(evidenceSchema).max(20).optional() });
export const medicationSchema = z.object({ id: idSchema, name: short.min(1), rxnorm: z.string().regex(/^\d*$/).max(30).optional(), ndc: z.string().regex(/^[\d-]*$/).max(30).optional(), strength: short.optional(), form: short.optional(), quantity: z.number().positive().max(100000).optional(), daysSupply: z.number().positive().max(366).optional(), ongoing: z.boolean(), evidence: z.array(evidenceSchema).max(20).optional() });
export const eventSchema = z.object({ id: idSchema, label: short.min(1), category: z.enum(SERVICE_CATEGORIES), date: dateSchema, quantity: z.number().positive().max(10000), providerId: short.optional(), medicationId: short.optional(), serviceCode: short.optional(), unitPriceCents: money, priceBasis: z.enum(['user_estimate', 'historical']).optional(), priceType: z.enum(['allowed', 'cash', 'billed']).optional(), quantityUnit: z.enum(['service', 'fill']).optional(), dispensedQuantity: z.number().positive().max(100000).optional(), dispensedUnit: short.optional(), daysSupply: z.number().positive().max(366).optional(), balanceBillingCents: money.unwrap().optional(), confirmed: z.boolean(), sourceEventIds: z.array(short).max(100).optional(), conditions: z.array(z.object({ conditionId: z.string().min(1).max(4096), status: z.enum(['satisfied', 'not_satisfied', 'unknown']), evidence: z.array(evidenceSchema).max(20).optional() })).max(200).optional() }).refine(e => e.category !== 'prescription' || e.quantity === 1, { path: ['quantity'], message: 'Enter one dated prescription fill per care item' });
export const comparisonSchema = z.object({ profile: profileSchema, providers: z.array(providerSchema).max(100), medications: z.array(medicationSchema).max(100), events: z.array(eventSchema).max(2000), additionalMonthlyPremiums: z.record(idSchema, money).optional(), planIds: z.array(idSchema).min(1).max(20), releaseId: idSchema, conditions: z.array(z.object({ conditionId: z.string().min(1).max(4096), status: z.enum(['satisfied', 'not_satisfied', 'unknown']), evidence: z.array(evidenceSchema).max(20).optional() })).max(1000).optional() }).superRefine((input, ctx) => {
  for (const key of ['providers', 'medications', 'events'] as const) if (new Set(input[key].map(x => x.id)).size !== input[key].length) ctx.addIssue({ code: 'custom', path: [key], message: 'Each entry must have a unique identifier' });
  if (new Set(input.planIds).size !== input.planIds.length) ctx.addIssue({ code: 'custom', path: ['planIds'], message: 'Choose each plan only once' });
  const premiumKeys = Object.keys(input.additionalMonthlyPremiums ?? {});
  if (premiumKeys.length > 20 || premiumKeys.some(id => !input.planIds.includes(id))) ctx.addIssue({ code: 'custom', path: ['additionalMonthlyPremiums'], message: 'Additional premiums must belong to selected plans' });
  const providers = new Set(input.providers.map(x => x.id)); const medications = new Set(input.medications.map(x => x.id));
  input.events.forEach((event, index) => {
    if (event.providerId && !providers.has(event.providerId)) ctx.addIssue({ code: 'custom', path: ['events', index, 'providerId'], message: 'Choose an existing provider' });
    if (event.medicationId && !medications.has(event.medicationId)) ctx.addIssue({ code: 'custom', path: ['events', index, 'medicationId'], message: 'Choose an existing medication' });
  });
});
export const catalogSearchSchema = z.object({ query: z.string().trim().max(100).optional(), releaseId: z.string().min(1).max(180).optional(), state: stateSchema, countyFips: z.string().regex(/^\d{5}$/), zip: z.string().regex(/^\d{5}$/).optional(), year: z.literal(2026), families: z.array(z.enum(PLAN_FAMILIES)).min(1).max(3).optional(), age: z.number().int().min(0).max(120).optional(), dateOfBirth: dateSchema.optional(), tobacco: z.union([z.boolean(), z.enum(['yes', 'no'])]).transform(x => x === true || x === 'yes').optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).max(200000).optional(), coverageStart: dateSchema.optional(), coverageEnd: dateSchema.optional() }).refine(q => q.countyFips.startsWith(STATE_FIPS[q.state]), { path: ['countyFips'], message: 'Select a county within the chosen state' });
