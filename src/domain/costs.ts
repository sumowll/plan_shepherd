import type { AccumulatorDefinition, BenefitCondition, BenefitRule, ComparisonInput, ComparisonResult, CostEstimate, CostLine, CoverageStatus, DrugBenefitPhase, ExpectedCareEvent, Medication, NetworkStatus, Plan, PriceObservation, ProviderPreference } from '../shared/contracts';
import { matchMedication, matchProvider } from './matching';
import { bps, cents, elapsedDays, extendedPrice, normalized, roundedRatio, validDate } from './primitives';
import { normalizeNdc } from '../shared/identifiers';

interface Ledger { deductible: number; oop: number }
interface State { ledgers: Map<string, Ledger>; visits: Map<string, number>; benefitPaid: Map<string, number>; planPaid: number; tainted: Set<string>; drugAllowed: number; drugOop: number; drugDeductible: number; phase: number }
interface Price { amount: number | null; estimated: boolean; sources: string[]; explanation: string[]; balance: number | null }
const sum = (a: number, b: number): number => { const result = a + b; if (!cents(result)) throw new RangeError('Monetary total exceeds supported precision.'); return result; };
function accounts(plan: Plan): Map<string, AccumulatorDefinition> {
  return new Map([
    ['medical', { id: 'medical', deductibleCents: plan.deductibleCents, oopMaxCents: plan.oopMaxCents, oopUnbounded: plan.medicalOopUnbounded }],
    ['drug', { id: 'drug', deductibleCents: plan.drugDeductibleCents, oopMaxCents: plan.drugOopMaxCents, oopUnbounded: plan.drugOopUnbounded }],
    ...(plan.accumulators ?? []).map(definition => [definition.id, definition] as [string, AccumulatorDefinition]),
  ]);
}
function accountIds(rule: BenefitRule): { deductible: string | null; oop: string[] } {
  return { deductible: rule.deductibleAccumulatorId ?? (rule.accumulator === 'none' ? null : rule.accumulator), oop: rule.oopAccumulatorIds ?? (rule.accumulator === 'none' ? [] : [rule.accumulator]) };
}
function stateLedger(state: State, id: string): Ledger {
  if (!state.ledgers.has(id)) state.ledgers.set(id, { deductible: 0, oop: 0 });
  return state.ledgers.get(id)!;
}
function priceFor(event: ExpectedCareEvent, plan: Plan, provider: ProviderPreference | undefined, medication: Medication | undefined, uncovered: boolean): Price {
  let candidates = plan.prices.filter(item => item.category === event.category && cents(item.unitPriceCents)
    && (!item.source.effectiveDate || item.source.effectiveDate <= event.date)
    && (!item.serviceCode || item.serviceCode === event.serviceCode)
    && (!item.providerNpi || item.providerNpi === provider?.npi)
    && (!item.providerLocation || normalized(item.providerLocation) === normalized(provider?.location))
    && (!item.medicationCode || item.medicationCode === medication?.rxnorm || (!!medication?.ndc && normalizeNdc(item.medicationCode) === normalizeNdc(medication.ndc)))
    && (event.category !== 'prescription' || ((item.quantityUnit === 'fill' || item.quantityUnit === 'dispensed_unit') && (!item.daysSupply || item.daysSupply === event.daysSupply) && (!item.dispensedQuantity || item.dispensedQuantity === event.dispensedQuantity)))
    && (uncovered ? item.priceType === 'cash' || item.priceType === 'billed' : !item.priceType || item.priceType === 'allowed'));
  const score = (item: PriceObservation) => (item.serviceCode ? 4 : 0) + (item.providerNpi ? 4 : 0) + (item.medicationCode ? 4 : 0) + (item.basis === 'contracted' ? 2 : 0);
  candidates = candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  if (candidates.length) {
    const top = candidates.filter(item => score(item) === score(candidates[0]));
    const extended = (item: PriceObservation) => extendedPrice(item.unitPriceCents, item.quantityUnit === 'dispensed_unit' ? event.dispensedQuantity === undefined ? NaN : event.quantity * event.dispensedQuantity : event.quantity);
    if (top.some(item => extended(item) === null)) return { amount: null, estimated: true, sources: top.map(item => item.source.id), explanation: ['An equally applicable price observation has unresolved quantity units or unsupported precision; verify its basis before pricing.'], balance: null };
    if (new Set(top.map(item => `${extended(item)}:${item.balanceBillingCents ?? 'unknown'}`)).size > 1) return { amount: null, estimated: true, sources: top.map(item => item.source.id), explanation: ['Equally applicable price observations conflict after extending their quantity units; select a verified price or explicit scenario.'], balance: null };
    const candidate = top[0];
    const estimated = candidate.basis !== 'contracted' || (!candidate.serviceCode && !candidate.medicationCode) || (!!provider && (!candidate.providerNpi || !candidate.providerLocation)) || (event.category === 'prescription' && (!candidate.daysSupply || !candidate.dispensedQuantity));
    const multiplier = candidate.quantityUnit === 'dispensed_unit' ? event.dispensedQuantity === undefined ? NaN : event.quantity * event.dispensedQuantity : event.quantity;
    return { amount: extendedPrice(candidate.unitPriceCents, multiplier), estimated, sources: top.map(item => item.source.id), explanation: [estimated ? `Uses a documented ${candidate.basis} price scenario; it is not a guaranteed negotiated price.` : 'Uses the matching contracted price observation.'], balance: cents(candidate.balanceBillingCents) ? candidate.balanceBillingCents : null };
  }
  const usableEventPrice = uncovered ? event.priceType === 'cash' || event.priceType === 'billed' : event.priceType === 'allowed' || (event.priceBasis === 'historical' && event.priceType === undefined);
  if (cents(event.unitPriceCents) && usableEventPrice) {
    return { amount: extendedPrice(event.unitPriceCents, event.quantity), estimated: true, sources: [], explanation: [event.priceBasis === 'historical' ? 'Uses the historical price as an explicit scenario assumption; it is not this candidate plan’s negotiated rate.' : 'Uses the user’s price estimate for this scenario.'], balance: cents(event.balanceBillingCents) ? event.balanceBillingCents : null };
  }
  return { amount: null, estimated: true, sources: [], explanation: [uncovered ? 'The patient’s cash/billed price for this uncovered service is unknown; a negotiated allowed amount does not establish it.' : 'No applicable allowed price is available; a cash or billed price is not an insurer allowed amount.'], balance: null };
}
function selectRule(event: ExpectedCareEvent, plan: Plan, network: NetworkStatus, tier: string | undefined): { rule?: BenefitRule; reason?: string } {
  let rules = plan.benefits.filter(rule => rule.category === event.category
    && (rule.network === 'any' || rule.network === network)
    && (!rule.serviceCodes || (!!event.serviceCode && rule.serviceCodes.includes(event.serviceCode)))
    && (!rule.drugTier || rule.drugTier === tier));
  const specificity = (rule: BenefitRule) => (rule.network !== 'any' ? 1 : 0) + (rule.serviceCodes ? 4 : 0) + (rule.drugTier ? 2 : 0);
  rules.sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
  if (!rules.length) return { reason: network === 'unknown' && plan.benefits.some(rule => rule.category === event.category && rule.network !== 'any') ? 'The benefit depends on a provider network status that has not been verified.' : 'No applicable verified benefit rule exists for this service.' };
  rules = rules.filter(rule => specificity(rule) === specificity(rules[0]));
  if (rules.length !== 1) return { reason: 'Multiple equally specific benefit rules match; their precedence must be resolved in the catalog.' };
  return { rule: rules[0] };
}
const planPrefix = (plan: Plan) => `plan:${encodeURIComponent(plan.id)}`;
const qualifyCondition = (plan: Plan, condition: BenefitCondition): BenefitCondition => ({ ...condition, id: `${planPrefix(plan)}:condition:${encodeURIComponent(condition.id)}` });
const confirmedCondition = (conditions: ExpectedCareEvent['conditions'], id: string): boolean => {
  const matching = conditions?.filter(condition => condition.conditionId === id) ?? [];
  return matching.length > 0 && matching.every(condition => condition.status === 'satisfied');
};
export function getPlanConditions(plan: Plan): BenefitCondition[] {
  return [...new Map([...(plan.conditions ?? []).map(condition => qualifyCondition(plan, condition)), ...(plan.underwritingRequired ? [{ id: `${planPrefix(plan)}:underwriting`, label: 'Issuer underwriting acceptance', source: plan.source }] : [])].map(condition => [condition.id, condition])).values()];
}
function conditionRequirements(plan: Plan, rule: BenefitRule, medication: Medication | undefined, matchedDrugs: ReturnType<typeof matchMedication>['drugs']): BenefitCondition[] {
  const conditions = [...getPlanConditions(plan), ...(rule.conditions ?? []).map(condition => qualifyCondition(plan, condition))];
  if (rule.priorAuthorization) conditions.push({ id: `${planPrefix(plan)}:benefit:${encodeURIComponent(rule.id)}:prior_authorization`, label: 'Prior authorization' });
  if (rule.referralRequired) conditions.push({ id: `${planPrefix(plan)}:benefit:${encodeURIComponent(rule.id)}:referral`, label: 'Referral requirement' });
  if (medication) for (const drug of matchedDrugs) {
    if (drug.priorAuthorization) conditions.push({ id: `${planPrefix(plan)}:drug:${encodeURIComponent(medication.id)}:prior_authorization`, label: 'Drug prior authorization' });
    if (drug.stepTherapy) conditions.push({ id: `${planPrefix(plan)}:drug:${encodeURIComponent(medication.id)}:step_therapy`, label: 'Drug step therapy' });
    if (drug.quantityLimit) conditions.push({ id: `${planPrefix(plan)}:drug:${encodeURIComponent(medication.id)}:quantity_limit`, label: `Drug quantity limit: ${drug.quantityLimit}` });
  }
  return [...new Map(conditions.map(condition => [condition.id, condition])).values()];
}
export function getApplicableConditions(plan: Plan, event: ExpectedCareEvent, providers: ProviderPreference[], medications: Medication[]): BenefitCondition[] {
  const provider = providers.find(item => item.id === event.providerId); const medication = medications.find(item => item.id === event.medicationId);
  const match = medication ? matchMedication(medication, plan, event.date) : undefined;
  const tiers = new Set(match?.drugs.map(drug => drug.tier).filter(Boolean));
  const selected = selectRule(event, plan, provider ? matchProvider(provider, plan, event.date).status : 'unknown', tiers.size === 1 ? [...tiers][0] : undefined);
  return selected.rule ? conditionRequirements(plan, selected.rule, medication, match?.drugs ?? []) : getPlanConditions(plan);
}
function unresolvedConditions(event: ExpectedCareEvent, plan: Plan, rule: BenefitRule, medication: Medication | undefined, matchedDrugs: ReturnType<typeof matchMedication>['drugs']): string[] {
  return conditionRequirements(plan, rule, medication, matchedDrugs)
    .filter(condition => !confirmedCondition(event.conditions, condition.id))
    .map(condition => `${condition.label} is unresolved (${condition.id}).`);
}
function taint(state: State, plan: Plan, rule: BenefitRule | undefined, category: ExpectedCareEvent['category']): void {
  if (rule) {
    const ids = accountIds(rule); for (const id of [...ids.oop, ...(ids.deductible ? [ids.deductible] : [])]) state.tainted.add(id);
    if (rule.visitLimit !== undefined || rule.insurerPaymentCapCents !== undefined) state.tainted.add(`benefit:${rule.id}`);
  } else {
    state.tainted.add(category === 'prescription' ? 'drug' : 'medical');
    for (const candidate of plan.benefits.filter(item => item.category === category)) {
      const ids = accountIds(candidate); for (const id of [...ids.oop, ...(ids.deductible ? [ids.deductible] : [])]) state.tainted.add(id);
    }
  }
  if (category === 'prescription') state.tainted.add('drug-phases');
  if (cents(plan.insurerPaymentCapCents)) state.tainted.add('plan-cap');
}
function basicCost(allowed: number, quantity: number, isDrug: boolean, rule: BenefitRule, plan: Plan, state: State): { patient: number; insurer: number; explanation: string[] } | string {
  if ((rule.insurerPaymentCapCents !== undefined && !cents(rule.insurerPaymentCapCents)) || (plan.insurerPaymentCapCents !== undefined && !cents(plan.insurerPaymentCapCents))) return 'An insurer payout limit is explicitly unknown or invalid.';
  if (!cents(rule.copayCents) || !bps(rule.coinsuranceBps)) return 'Copay or coinsurance is missing/invalid; null is not zero.';
  if (rule.copayCents > 0 && rule.coinsuranceBps > 0 && !rule.costSharingOrder) return 'Both copay and coinsurance apply, but their combination order is unspecified.';
  const definitions = accounts(plan); const ids = accountIds(rule);
  for (const id of [...ids.oop, ...(ids.deductible ? [ids.deductible] : [])]) if (!definitions.has(id)) return `Accumulator ${id} is not defined.`;
  if (new Set(ids.oop).size !== ids.oop.length) return 'An out-of-pocket accumulator is listed more than once.';
  if ([...ids.oop, ...(ids.deductible ? [ids.deductible] : [])].some(id => state.tainted.has(id)) || state.tainted.has(`benefit:${rule.id}`) || state.tainted.has('plan-cap')) return 'An earlier unresolved event may change this deductible, spending limit or payout cap.';
  const deductibleLimit = rule.deductibleCents !== undefined ? rule.deductibleCents : ids.deductible ? definitions.get(ids.deductible)?.deductibleCents : null;
  if (rule.appliesDeductible && (!ids.deductible || !cents(deductibleLimit))) return 'The applicable deductible or its accumulator is not known.';
  const oopRemaining: number[] = [];
  for (const id of ids.oop) {
    const definition = definitions.get(id)!;
    const limit = rule.oopMaxCents !== undefined && ids.oop.length === 1 ? rule.oopMaxCents : definition.oopMaxCents;
    if (!cents(limit) && !definition.oopUnbounded && (rule.appliesDeductible || rule.copayCents > 0 || rule.coinsuranceBps > 0)) return `The spending limit for ${id} is unknown; unlimited must be stated explicitly.`;
    oopRemaining.push(cents(limit) ? Math.max(0, limit - stateLedger(state, id).oop) : Number.MAX_SAFE_INTEGER);
  }
  let remaining = allowed;
  let patient = 0;
  const credits = new Map(ids.oop.map(id => [id, 0]));
  const apply = (charge: number, counts: boolean): number => {
    let paid = Math.min(charge, remaining);
    if (counts && ids.oop.length) paid = Math.min(paid, ...ids.oop.map((id, index) => Math.max(0, oopRemaining[index] - (credits.get(id) ?? 0))));
    if (counts) for (const id of ids.oop) credits.set(id, (credits.get(id) ?? 0) + paid);
    patient += paid; return paid;
  };
  const copay = extendedPrice(rule.copayCents, isDrug ? 1 : quantity);
  if (copay === null) return 'The quantity/cost-sharing combination cannot be represented precisely.';
  if (rule.copayBeforeDeductible) { const paid = apply(copay, rule.copayCountsTowardOop !== false); remaining -= paid; }
  let deductiblePaid = 0;
  if (rule.appliesDeductible && ids.deductible && cents(deductibleLimit)) {
    const need = Math.max(0, deductibleLimit - stateLedger(state, ids.deductible).deductible);
    deductiblePaid = apply(Math.min(remaining, need), rule.deductibleCountsTowardOop !== false);
    remaining -= deductiblePaid;
  }
  const effectiveCopay = rule.copayBeforeDeductible ? 0 : Math.min(copay, remaining);
  const coinsurance = roundedRatio(remaining, rule.coinsuranceBps, 10_000);
  if (rule.costSharingOrder === 'greater_of' || rule.costSharingOrder === 'lesser_of') {
    if ((rule.copayCountsTowardOop !== false) !== (rule.coinsuranceCountsTowardOop !== false)) return 'Mixed accumulator credits for alternative copay/coinsurance require an explicit adjudication rule.';
    apply(rule.costSharingOrder === 'greater_of' ? Math.max(effectiveCopay, coinsurance) : Math.min(effectiveCopay, coinsurance), rule.coinsuranceCountsTowardOop !== false);
  } else {
    const copayPaid = apply(effectiveCopay, rule.copayCountsTowardOop !== false);
    apply(roundedRatio(Math.max(0, remaining - effectiveCopay), rule.coinsuranceBps, 10_000), rule.coinsuranceCountsTowardOop !== false);
    void copayPaid;
  }
  let insurer = allowed - patient;
  const benefitRemaining = cents(rule.insurerPaymentCapCents) ? Math.max(0, rule.insurerPaymentCapCents - (state.benefitPaid.get(rule.id) ?? 0)) : Number.MAX_SAFE_INTEGER;
  const planRemaining = cents(plan.insurerPaymentCapCents) ? Math.max(0, plan.insurerPaymentCapCents - state.planPaid) : Number.MAX_SAFE_INTEGER;
  const cappedInsurer = Math.min(insurer, benefitRemaining, planRemaining);
  const capSpill = insurer - cappedInsurer;
  patient += capSpill; insurer = cappedInsurer;
  if (ids.deductible) stateLedger(state, ids.deductible).deductible += deductiblePaid;
  for (const [id, credit] of credits) stateLedger(state, id).oop += credit;
  state.benefitPaid.set(rule.id, sum(state.benefitPaid.get(rule.id) ?? 0, insurer)); state.planPaid = sum(state.planPaid, insurer);
  return { patient, insurer, explanation: [`Deductible allocation: ${deductiblePaid} cents.`, ...(capSpill ? [`The insurer payment cap leaves ${capSpill} additional cents to the patient; this does not receive unsupported OOP credit.`] : [])] };
}
function phaseConfigurationError(plan: Plan): string | undefined {
  const phases = plan.drugBenefitPhases?.phases;
  if (!phases?.length || !plan.drugBenefitPhases?.source.id) return 'Verified, source-versioned drug phase rules are required for Medicare Advantage drug cost simulation.';
  const previous = new Map<string, number>();
  for (const [index, phase] of phases.entries()) {
    if (!bps(phase.coinsuranceBps) || !bps(phase.patientOopCreditBps) || !bps(phase.additionalOopCreditBps) || (phase.copayCents !== undefined && !cents(phase.copayCents))) return 'A drug phase has invalid monetary or credit parameters.';
    if (phase.until === null) { if (index !== phases.length - 1) return 'Only the final drug phase may be unbounded.'; }
    else {
      if (!cents(phase.until.cents) || phase.until.cents <= (previous.get(phase.until.ledger) ?? -1)) return 'Drug phase thresholds must advance within their ledger.';
      if (phase.until.ledger === 'drug_oop' && phase.patientOopCreditBps === 0 && phase.additionalOopCreditBps === 0) return 'A drug OOP phase cannot advance with zero qualifying credits.';
      previous.set(phase.until.ledger, phase.until.cents);
    }
  }
  if (phases.at(-1)?.until !== null) return 'The final drug phase must describe remaining covered spending.';
}
function phaseCost(allowed: number, rule: BenefitRule, plan: Plan, state: State): { patient: number; insurer: number; explanation: string[] } | string {
  const invalid = phaseConfigurationError(plan); if (invalid) return invalid;
  if (state.tainted.has('drug-phases') || state.tainted.has('plan-cap')) return 'An earlier unresolved drug event may change the spending phase.';
  if (plan.insurerPaymentCapCents !== undefined || rule.insurerPaymentCapCents !== undefined) return 'Combining drug spending phases with insurer payout caps requires an explicit adjudication adapter.';
  if ((rule.deductibleAccumulatorId && rule.deductibleAccumulatorId !== 'drug') || rule.oopAccumulatorIds?.some(id => id !== 'drug')) return 'A drug phase linked to medical/shared accumulators requires an explicit adjudication adapter.';
  const phases = plan.drugBenefitPhases!.phases;
  let phaseIndex = state.phase; let gross = state.drugAllowed; let oop = state.drugOop; let deductible = state.drugDeductible; let remaining = allowed; let patient = 0;
  const explanation: string[] = [];
  while (remaining > 0) {
    const phase: DrugBenefitPhase = phases[phaseIndex];
    if (!phase) return 'No drug phase covers the remaining spending.';
    const limit = phase.until;
    const ledger = limit?.ledger === 'drug_allowed' ? gross : limit?.ledger === 'drug_deductible' ? deductible : oop;
    if (limit && ledger >= limit.cents) { phaseIndex++; continue; }
    const override = rule.drugPhaseOverrides?.[phase.id];
    const rate = override?.coinsuranceBps ?? phase.coinsuranceBps;
    const copay = override?.copayCents ?? phase.copayCents ?? 0;
    const deductibleRate = override?.deductibleCreditBps ?? (rule.appliesDeductible ? 10_000 : 0);
    if (!bps(rate) || !cents(copay) || !bps(deductibleRate)) return 'Drug phase override is invalid.';
    const paidFor = (amount: number) => Math.min(amount, sum(copay, roundedRatio(Math.max(0, amount - copay), rate, 10_000)));
    const creditFor = (amount: number) => sum(roundedRatio(paidFor(amount), phase.patientOopCreditBps, 10_000), roundedRatio(amount, phase.additionalOopCreditBps, 10_000));
    const deductibleFor = (amount: number) => roundedRatio(amount, deductibleRate, 10_000);
    let chunk = remaining;
    if (limit?.ledger === 'drug_allowed') chunk = Math.min(chunk, limit.cents - gross);
    if (limit?.ledger === 'drug_oop' && creditFor(chunk) >= limit.cents - oop) {
      let low = 1; let high = chunk;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (creditFor(mid) >= limit.cents - oop) high = mid; else low = mid + 1; }
      chunk = low;
    }
    if (limit?.ledger === 'drug_deductible' && deductibleFor(chunk) >= limit.cents - deductible) {
      let low = 1; let high = chunk;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (deductibleFor(mid) >= limit.cents - deductible) high = mid; else low = mid + 1; }
      chunk = low;
    }
    if (chunk < remaining && copay > 0) return 'A copay fill crossing drug phases needs source-specific split-fill rules; no double copay is assumed.';
    const paid = paidFor(chunk); let credit = creditFor(chunk);
    if (limit?.ledger === 'drug_oop') credit = Math.min(credit, limit.cents - oop);
    const deductibleCredit = limit?.ledger === 'drug_deductible' ? Math.min(deductibleFor(chunk), limit.cents - deductible) : 0;
    patient = sum(patient, paid); gross = sum(gross, chunk); oop = sum(oop, credit); deductible = sum(deductible, deductibleCredit); remaining -= chunk;
    explanation.push(`${phase.label}: ${chunk} allowed cents, ${paid} patient cents, ${credit} qualifying OOP-credit cents.${limit?.ledger === 'drug_deductible' ? ` ${deductibleCredit} deductible-credit cents.` : ''}`);
  }
  state.phase = phaseIndex; state.drugAllowed = gross; state.drugOop = oop; state.drugDeductible = deductible;
  state.planPaid = sum(state.planPaid, allowed - patient);
  return { patient, insurer: allowed - patient, explanation };
}

function simulate(input: ComparisonInput, plan: Plan, identityConflict: boolean): CostEstimate {
  const state: State = { ledgers: new Map(), visits: new Map(), benefitPaid: new Map(), planPaid: 0, tainted: new Set(), drugAllowed: 0, drugOop: 0, drugDeductible: 0, phase: 0 };
  const warnings: string[] = ['This is an anticipated-care scenario, not a guaranteed bill or a maximum for all possible spending. The engine does not calculate financial assistance.'];
  const profile = input.profile;
  const validPeriod = validDate(profile.coverageStart) && validDate(profile.coverageEnd) && profile.coverageStart <= profile.coverageEnd && profile.coverageStart.slice(0, 4) === profile.coverageEnd.slice(0, 4);
  const validPlanPeriod = validDate(plan.effectiveStart) && validDate(plan.effectiveEnd) && plan.effectiveStart <= plan.effectiveEnd;
  const ratingDate = plan.family === 'short_term' && plan.effectiveStart > profile.coverageStart ? plan.effectiveStart : profile.coverageStart;
  const age = validDate(profile.dateOfBirth) ? Number(ratingDate.slice(0, 4)) - Number(profile.dateOfBirth.slice(0, 4)) - (ratingDate.slice(5) < profile.dateOfBirth.slice(5) ? 1 : 0) : -1;
  const ratingValid = !plan.rating || ((plan.rating.minAge === undefined || age >= plan.rating.minAge) && (plan.rating.maxAge === undefined || age <= plan.rating.maxAge) && (plan.rating.age === undefined || age === plan.rating.age) && (plan.rating.tobacco === undefined || plan.rating.tobacco === (profile.tobacco === 'yes')) && (!plan.rating.countyFips || plan.rating.countyFips === profile.countyFips));
  const areaValid = !plan.serviceAreas || plan.serviceAreas.some(area => area.countyFips === profile.countyFips && (area.wholeCounty || area.zipCodes?.includes(profile.zip)));
  const contextVerified = validPeriod && validPlanPeriod && ratingValid && areaValid && plan.year === Number(profile.coverageStart.slice(0, 4)) && plan.state === profile.state && plan.countyFips.includes(profile.countyFips) && plan.status === 'available' && !identityConflict;
  if (!contextVerified) warnings.push('Plan identity, service area, status, year or coverage period does not match the requested comparison context.');
  if (!plan.rulesVerified) warnings.push('Plan benefit rules have not been verified; patient costs are not adjudicated.');
  const start = [profile.coverageStart, plan.effectiveStart].sort().at(-1)!;
  const end = [profile.coverageEnd, plan.effectiveEnd].sort()[0];
  const coverageMonths = contextVerified && start <= end ? (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1 : 0;
  let planPremiumCents = contextVerified && cents(plan.monthlyPremiumCents) ? extendedPrice(plan.monthlyPremiumCents, coverageMonths || 1) : null;
  if (coverageMonths === 0) planPremiumCents = contextVerified ? 0 : null;
  const lastDay = validDate(end) ? new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate() : 0;
  let premiumEstimated = plan.premiumEstimated;
  let additionalPremiumCents: number | null = 0;
  if (plan.family === 'medicare_advantage') {
    const monthly = input.additionalMonthlyPremiums && Object.hasOwn(input.additionalMonthlyPremiums, plan.id) ? input.additionalMonthlyPremiums[plan.id] : undefined;
    additionalPremiumCents = contextVerified && cents(monthly) ? coverageMonths === 0 ? 0 : extendedPrice(monthly, coverageMonths) : null;
    if (monthly === undefined || monthly === null) warnings.push('Additional Medicare premiums are missing. Enter this plan’s monthly Part A/Part B and IRMAA premium scenario, net of applicable assistance or giveback, excluding the candidate plan premium. The known subtotal omits this unknown component.');
    else if (!cents(monthly)) warnings.push('The additional Medicare premium scenario is invalid; provide a nonnegative, safe integer number of cents. The known subtotal omits this unknown component.');
    else {
      premiumEstimated = true;
      warnings.push('Additional Medicare premiums use your per-plan monthly scenario for Part A/Part B and IRMAA, net of applicable assistance or giveback and excluding the candidate plan premium. No Medicare premium, IRMAA, assistance or giveback amount is calculated automatically.');
      if (contextVerified && additionalPremiumCents === null) warnings.push('Additional Medicare premiums exceed supported monetary precision. The known subtotal omits this unknown component.');
    }
  }
  let premiumCents: number | null = null;
  if (planPremiumCents !== null && additionalPremiumCents !== null) {
    try { premiumCents = sum(planPremiumCents, additionalPremiumCents); } catch { warnings.push('Combined premiums exceed supported monetary precision.'); }
  }
  if (coverageMonths && (start.slice(8) !== '01' || Number(end.slice(8)) !== lastDay)) { premiumEstimated = true; warnings.push('Partial-month premiums are estimated as full billed calendar months; verify the issuer billing terms.'); }
  if (plan.effectiveStart > profile.coverageStart || plan.effectiveEnd < profile.coverageEnd) warnings.push('This policy covers only part of the requested period; renewal or replacement coverage is not assumed.');
  const globalConditionIds = getPlanConditions(plan).map(condition => condition.id);
  const globalConditionsUnresolved = globalConditionIds.some(id => !confirmedCondition(input.conditions, id));
  if (globalConditionsUnresolved) { warnings.push('Plan-level conditions, including any underwriting acceptance, remain unresolved.'); premiumEstimated = true; }

  const eventGroups = new Map<string, ExpectedCareEvent[]>();
  for (const event of input.events) eventGroups.set(event.id, [...(eventGroups.get(event.id) ?? []), event]);
  const events = [...eventGroups.values()].map(group => ({ event: [...group].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0], conflict: new Set(group.map(event => JSON.stringify(event))).size > 1 })).sort((a, b) => a.event.date.localeCompare(b.event.date) || a.event.id.localeCompare(b.event.id));
  const sameDayCounts = new Map<string, number>();
  for (const { event } of events) sameDayCounts.set(event.date, (sameDayCounts.get(event.date) ?? 0) + 1);
  const assumedSameDayOrder = [...sameDayCounts.values()].some(count => count > 1);
  if (assumedSameDayOrder) warnings.push('Events on the same day use stable event-ID order as an explicit scenario assumption; actual claim adjudication order may differ.');
  const lines: CostLine[] = [];
  for (const { event, conflict } of events) {
    if (validPeriod && validDate(event.date) && (event.date < profile.coverageStart || event.date > profile.coverageEnd)) { warnings.push(`Event ${event.id} falls outside the selected comparison period and is excluded.`); continue; }
    const provider = input.providers.find(item => item.id === event.providerId);
    const medication = input.medications.find(item => item.id === event.medicationId);
    const ambiguousReference = (event.providerId && input.providers.filter(item => item.id === event.providerId).length !== 1) || (event.medicationId && input.medications.filter(item => item.id === event.medicationId).length !== 1);
    const providerMatch = provider ? matchProvider(provider, plan, event.date) : { status: 'unknown' as const, details: 'No specific provider/location selected.', sourceIds: [] };
    const drugMatch = medication ? matchMedication(medication, plan, event.date) : undefined;
    const network = providerMatch.status;
    const tierSet = new Set(drugMatch?.drugs.map(drug => drug.tier).filter(Boolean));
    const selection = selectRule(event, plan, network, tierSet.size === 1 ? [...tierSet][0] : undefined);
    const rule = selection.rule;
    const line: CostLine = { eventId: event.id, label: event.label, coverage: 'unknown', network, allowedCents: null, patientCents: null, insurerCents: null, estimated: true, explanation: [], sourceIds: [...new Set([plan.source.id, ...providerMatch.sourceIds, ...(drugMatch?.sourceIds ?? []), ...(rule ? [rule.source.id] : [])])] };
    lines.push(line);
    const unresolved = (reason: string, coverage: CoverageStatus = 'unknown') => { line.coverage = coverage; line.explanation.push(reason); taint(state, plan, rule, event.category); };
    if (!event.confirmed) { unresolved('Review and confirm this anticipated-care draft before it affects a comparison.'); continue; }
    if (ambiguousReference) { unresolved('A selected provider or medication reference is missing or has duplicate identities.'); continue; }
    if (conflict) { unresolved('Conflicting events share the same event ID; resolve the input before comparison.'); continue; }
    if (!validDate(event.date) || !Number.isFinite(event.quantity) || event.quantity <= 0) { unresolved('The service date or quantity is invalid.'); continue; }
    if (event.category === 'prescription' && event.quantity !== 1) { unresolved('Represent each prescription fill as one dated event. Dispensed pills or units belong in the separate dispensed-quantity field.'); continue; }
    if (!contextVerified || !plan.rulesVerified) { unresolved('The plan context or benefit rules are unverified.'); continue; }
    if (event.category === 'prescription' && (!medication || !drugMatch || drugMatch.status === 'unknown')) { unresolved(drugMatch?.details ?? 'Confirm the exact medication before applying a drug benefit.'); continue; }
    if (!rule) { unresolved(selection.reason ?? 'No applicable benefit rule.'); continue; }
    if ((rule.waitingDays !== undefined && !cents(rule.waitingDays)) || (rule.visitLimit !== undefined && !cents(rule.visitLimit))) { unresolved('The waiting period or visit limit is invalid.'); continue; }
    if (rule.source.effectiveDate && rule.source.effectiveDate > event.date) { unresolved('The benefit source becomes effective after this service date.'); continue; }
    if (rule.coverage === 'unknown') { unresolved('The source explicitly leaves coverage unknown.'); continue; }
    const outside = event.date < plan.effectiveStart || event.date > plan.effectiveEnd;
    const waiting = rule.waitingDays !== undefined && (!cents(rule.waitingDays) || elapsedDays(plan.effectiveStart, event.date) < rule.waitingDays);
    const used = state.visits.get(rule.id) ?? 0;
    const overLimit = rule.visitLimit !== undefined && used >= rule.visitLimit;
    const uncovered = outside || waiting || overLimit || rule.coverage === 'not_covered' || drugMatch?.status === 'not_covered';
    const price = priceFor(event, plan, provider, medication, uncovered);
    line.allowedCents = price.amount; line.estimated = price.estimated || premiumEstimated; line.sourceIds.push(...price.sources); line.explanation.push(...price.explanation);
    if (uncovered) {
      line.coverage = 'not_covered';
      line.explanation.push(outside ? 'The service is outside the policy term.' : waiting ? 'The policy waiting period is not satisfied.' : overLimit ? 'The benefit visit limit is exhausted.' : 'The applicable plan rule or exact formulary entry excludes this service.');
      if (price.amount !== null) { line.patientCents = price.amount; line.insurerCents = 0; }
      continue;
    }
    const conditions = unresolvedConditions({ ...event, conditions: [...(input.conditions ?? []), ...(event.conditions ?? [])] }, plan, rule, medication, drugMatch?.drugs ?? []);
    if (conditions.length) { unresolved(conditions.join(' '), 'conditional'); continue; }
    const encodedCondition = plan.underwritingRequired || plan.conditions?.length || rule.conditions?.length || rule.priorAuthorization || rule.referralRequired || drugMatch?.drugs.some(drug => drug.priorAuthorization || drug.stepTherapy || drug.quantityLimit);
    if ((rule.coverage === 'conditional' || drugMatch?.drugs.some(drug => drug.coverage === 'conditional')) && !encodedCondition) { unresolved('Coverage is conditional but the source does not encode conditions that can be confirmed.', 'conditional'); continue; }
    if (price.amount === null) { unresolved('An unresolved price prevents complete adjudication of subsequent shared accumulators.'); continue; }
    if (rule.visitLimit !== undefined && (!cents(rule.visitLimit) || used + event.quantity > rule.visitLimit)) { unresolved('This event crosses the benefit visit limit. Split covered and uncovered units and provide the uncovered cash price.'); continue; }
    if (network === 'out_of_network' && price.balance === null) { unresolved('Out-of-network balance billing is unknown; the allowed amount alone is not total patient spending.'); continue; }
    try {
      const result = event.category === 'prescription' && plan.family === 'medicare_advantage' ? phaseCost(price.amount, rule, plan, state) : basicCost(price.amount, event.quantity, event.category === 'prescription', rule, plan, state);
      if (typeof result === 'string') { unresolved(result); continue; }
      line.coverage = 'covered'; line.patientCents = sum(result.patient, network === 'out_of_network' ? price.balance! : 0); line.insurerCents = result.insurer; line.explanation.push(...result.explanation);
      if (network === 'out_of_network' && price.balance) line.explanation.push(`Adds ${price.balance} cents of explicitly supplied balance billing without OOP credit.`);
      state.visits.set(rule.id, used + event.quantity);
      if (event.category === 'prescription' && plan.drugBenefitPhases) line.sourceIds.push(plan.drugBenefitPhases.source.id);
    } catch { unresolved('The monetary inputs exceed supported precision; no partial accumulator result is accepted.'); }
    line.sourceIds = [...new Set(line.sourceIds)];
  }
  let careCents = 0; let monetaryOverflow = false;
  for (const line of lines) try { careCents = sum(careCents, line.patientCents ?? 0); } catch { monetaryOverflow = true; warnings.push('The displayed known subtotal is incomplete because monetary precision was exceeded.'); }
  const unpricedCount = lines.filter(line => line.patientCents === null).length;
  let knownSubtotalCents = careCents;
  for (const component of [planPremiumCents, additionalPremiumCents]) {
    try { knownSubtotalCents = sum(knownSubtotalCents, component ?? 0); } catch { monetaryOverflow = true; warnings.push('The displayed known subtotal is incomplete because total monetary precision was exceeded.'); }
  }
  const incompleteTerm = start > profile.coverageStart || end < profile.coverageEnd;
  return { planId: plan.id, premiumCents, planPremiumCents, additionalPremiumCents, careCents, totalCents: unpricedCount || premiumCents === null || !contextVerified || !plan.rulesVerified || incompleteTerm || monetaryOverflow || globalConditionsUnresolved ? null : knownSubtotalCents, knownSubtotalCents, unpricedCount, estimated: premiumEstimated || lines.some(line => line.estimated) || incompleteTerm || assumedSameDayOrder, lines, warnings: [...new Set(warnings)], coverageMonths };
}

export function comparePlans(input: ComparisonInput, plans: Plan[]): ComparisonResult[] {
  const selected = new Set(input.planIds);
  const ids = new Map<string, number>(); for (const plan of plans) ids.set(plan.id, (ids.get(plan.id) ?? 0) + 1);
  return plans.filter(plan => !selected.size || selected.has(plan.id)).map(plan => ({ plan, cost: simulate(input, plan, (ids.get(plan.id) ?? 0) > 1), providerMatches: input.providers.filter(provider => provider.preferred).map(provider => { const match = matchProvider(provider, plan, input.profile.coverageStart); return { providerId: provider.id, status: match.status, details: match.details }; }), medicationMatches: input.medications.filter(medication => medication.ongoing).map(medication => { const match = matchMedication(medication, plan, input.profile.coverageStart); return { medicationId: medication.id, status: match.status, details: match.details }; }) }));
}
