import type { CoverageStatus, Medication, NetworkStatus, Plan, PlanDrug, ProviderPreference } from '../shared/contracts';
import { normalized, validDate } from './primitives';
import { normalizeNdc } from '../shared/identifiers';

export function matchProvider(provider: ProviderPreference, plan: Plan, asOf = plan.effectiveStart): { status: NetworkStatus; details: string; sourceIds: string[] } {
  if (!validDate(asOf)) return { status: 'unknown', details: 'A valid coverage date is required for network verification.', sourceIds: [] };
  if (!provider.npi || !/^\d{10}$/.test(provider.npi)) return { status: 'unknown', details: 'An exact provider NPI is required; a name match is insufficient.', sourceIds: [] };
  if (!normalized(provider.location)) return { status: 'unknown', details: 'Confirm the intended provider location to verify this network.', sourceIds: [] };
  const identity = plan.providers.filter(item => item.npi === provider.npi && normalized(item.location) === normalized(provider.location));
  const matches = identity.filter(item => !item.source.effectiveDate || (validDate(item.source.effectiveDate) && item.source.effectiveDate <= asOf));
  if (identity.length && !matches.length) return { status: 'unknown', details: 'Matching network entries are not effective on the requested date.', sourceIds: [...new Set(identity.map(item => item.source.id))] };
  const completeForDate = plan.networkComplete && (!plan.source.effectiveDate || (validDate(plan.source.effectiveDate) && plan.source.effectiveDate <= asOf));
  if (!matches.length) return { status: completeForDate ? 'out_of_network' : 'unknown', details: completeForDate ? 'The exact provider and location are absent from this complete plan network release.' : 'This release has no verified exact provider/location match; incomplete or future-effective data does not establish absence on this date.', sourceIds: [plan.source.id] };
  const statuses = new Set(matches.map(item => item.network));
  return { status: statuses.size === 1 ? matches[0].network : 'unknown', details: statuses.size === 1 ? 'Matched exact NPI and location in this plan release.' : 'Conflicting network entries require verification.', sourceIds: [...new Set(matches.map(item => item.source.id))] };
}
export function matchMedication(medication: Medication, plan: Plan, asOf = plan.effectiveStart): { status: CoverageStatus; details: string; drugs: PlanDrug[]; sourceIds: string[] } {
  if (!validDate(asOf)) return { status: 'unknown', details: 'A valid coverage date is required for formulary verification.', drugs: [], sourceIds: [] };
  const hasNdc = /^\d{10,11}$/.test(normalizeNdc(medication.ndc));
  const hasRx = /^\d+$/.test(medication.rxnorm ?? '');
  if (!hasNdc && !hasRx) return { status: 'unknown', details: 'Confirm an exact NDC or RxNorm product identifier; names alone are not sufficient.', drugs: [], sourceIds: [] };
  const exactNdc = plan.drugs.filter(drug => hasNdc && drug.ndc && normalizeNdc(drug.ndc) === normalizeNdc(medication.ndc));
  const possibleIdentity = exactNdc.length ? exactNdc : plan.drugs.filter(drug => !(hasNdc && drug.ndc) && hasRx && drug.rxnorm === medication.rxnorm);
  const identity = possibleIdentity.filter(drug => !drug.source.effectiveDate || (validDate(drug.source.effectiveDate) && drug.source.effectiveDate <= asOf));
  if (possibleIdentity.length && !identity.length) return { status: 'unknown', details: 'Matching formulary entries are not effective on the requested date.', drugs: [], sourceIds: [...new Set(possibleIdentity.map(drug => drug.source.id))] };
  const matches = identity.filter(drug => (!medication.strength || normalized(drug.strength) === normalized(medication.strength)) && (!medication.form || normalized(drug.form) === normalized(medication.form)));
  if (!exactNdc.length && hasRx && (!hasNdc || identity.length > 0) && (!medication.strength || !medication.form)) return { status: 'unknown', details: 'Confirm strength and formulation for this RxNorm medication match; an unmatched NDC does not establish the product.', drugs: [], sourceIds: identity.map(drug => drug.source.id) };
  if (identity.length && !matches.length) return { status: 'unknown', details: 'The identifier match has missing or conflicting strength/formulation details.', drugs: identity, sourceIds: identity.map(drug => drug.source.id) };
  const completeForDate = plan.formularyComplete && (!plan.source.effectiveDate || (validDate(plan.source.effectiveDate) && plan.source.effectiveDate <= asOf));
  if (!matches.length) return { status: completeForDate ? 'not_covered' : 'unknown', details: completeForDate ? 'The exact medication is absent from this complete formulary release.' : 'No exact match in data complete and effective for the requested date; coverage remains unknown.', drugs: [], sourceIds: [plan.source.id] };
  const statuses = new Set(matches.map(drug => drug.coverage));
  const conditions = matches.some(drug => drug.priorAuthorization || drug.stepTherapy || drug.quantityLimit);
  const status = statuses.size === 1 ? matches[0].coverage : 'unknown';
  return { status: status === 'covered' && conditions ? 'conditional' : status, details: statuses.size !== 1 ? 'Conflicting formulary entries require verification.' : conditions ? 'Exact medication match with utilization conditions requiring confirmation.' : 'Matched exact medication identity and supplied strength/formulation.', drugs: matches, sourceIds: [...new Set(matches.map(drug => drug.source.id))] };
}
