import type { ConnectorApiType, ConnectorKind } from './connectors';

export const PLAN_FAMILIES = ['aca', 'short_term', 'medicare_advantage'] as const;
export type PlanFamily = typeof PLAN_FAMILIES[number];
export type CoverageStatus = 'covered' | 'not_covered' | 'conditional' | 'unknown';
export type NetworkStatus = 'in_network' | 'out_of_network' | 'unknown';
export type ServiceCategory = 'primary_care' | 'specialist' | 'urgent_care' | 'emergency' | 'hospital' | 'outpatient' | 'lab' | 'imaging' | 'therapy' | 'mental_health' | 'preventive' | 'prescription' | 'other';
export const SERVICE_CATEGORIES: ServiceCategory[] = ['primary_care', 'specialist', 'urgent_care', 'emergency', 'hospital', 'outpatient', 'lab', 'imaging', 'therapy', 'mental_health', 'preventive', 'prescription', 'other'];
export interface SourceRef { id: string; publisher: string; url: string; retrievedAt: string; effectiveDate?: string; version: string; location?: string }
export interface Evidence { id: string; source: string; resourceId?: string; date?: string; text?: string; method: 'structured_import' | 'user_entered' | 'ai_proposed'; confirmed: boolean }
export interface PersonProfile {
  taxFilingStatus?: 'single' | 'joint' | 'separate' | 'head_of_household' | 'unknown';
  claimedAsDependent?: 'yes' | 'no' | 'unknown';
  employerOfferRelationship?: 'self' | 'household_member' | 'unknown';
  employerOfferStart?: string; employerOfferEnd?: string;
  dateOfBirth: string; state: string; countyFips: string; zip: string;
  householdSize: number; annualIncomeCents: number | null;
  employerOffer: 'yes' | 'no' | 'unknown'; employerMonthlyContributionCents: number | null;
  employerMinimumValue: 'yes' | 'no' | 'unknown';
  medicarePartA: 'yes' | 'no' | 'unknown'; medicarePartB: 'yes' | 'no' | 'unknown';
  tobacco: 'yes' | 'no'; coverageStart: string; coverageEnd: string;
  citizenshipEligible: 'yes' | 'no' | 'unknown'; incarcerated: 'yes' | 'no' | 'unknown';
  enrollmentEvent: 'open_enrollment' | 'loss_of_coverage' | 'other' | 'unknown';
}
export interface ProviderPreference { id: string; name: string; npi?: string; specialty?: string; location?: string; preferred: boolean; evidence?: Evidence[] }
export interface Medication { id: string; name: string; rxnorm?: string; ndc?: string; strength?: string; form?: string; quantity?: number; daysSupply?: number; ongoing: boolean; evidence?: Evidence[] }
export interface ExpectedCareEvent {
  quantityUnit?: 'service' | 'fill'; dispensedQuantity?: number; dispensedUnit?: string; daysSupply?: number;
  priceType?: 'allowed' | 'cash' | 'billed'; balanceBillingCents?: number;
  conditions?: ConditionConfirmation[];
  id: string; label: string; category: ServiceCategory; date: string; quantity: number;
  providerId?: string; medicationId?: string; serviceCode?: string;
  unitPriceCents: number | null; priceBasis?: 'user_estimate' | 'historical';
  confirmed: boolean; sourceEventIds?: string[];
}
export interface HistoricalEvent {
  sourceResourceId?: string;
  quantityUnit?: 'service' | 'fill'; dispensedQuantity?: number; dispensedUnit?: string; daysSupply?: number;
  updatedAt?: string; replacesId?: string;
  id: string; source: string; date: string; category: ServiceCategory; label: string;
  kind: 'encounter' | 'claim' | 'prescription_order' | 'dispense'; status: 'completed' | 'reversed' | 'cancelled' | 'unknown';
  providerId?: string; medicationId?: string; serviceCode?: string; quantity: number;
  billedCents?: number; allowedCents?: number; paidCents?: number; patientCents?: number;
  claimId?: string; encounterId?: string; version?: string; evidence: Evidence[];
}
export interface ClaimSnapshot { source: string; resourceId: string; status: 'completed' | 'cancelled' | 'unknown'; eventIds: string[]; complete: boolean; version?: string; updatedAt?: string }
export interface ImportResult { providers: ProviderPreference[]; medications: Medication[]; events: HistoricalEvent[]; claimSnapshots?: ClaimSnapshot[]; warnings: string[]; resourcesRead: number; complete: boolean; patient?: { source: string; id: string; name?: string; dateOfBirth?: string; evidence: Evidence[] } }
export interface BenefitRule {
  serviceCodes?: string[]; drugTier?: string;
  drugPhaseOverrides?: Record<string, { coinsuranceBps: number; copayCents?: number; deductibleCreditBps?: number }>;
  deductibleAccumulatorId?: string; oopAccumulatorIds?: string[];
  deductibleCountsTowardOop?: boolean; copayCountsTowardOop?: boolean; coinsuranceCountsTowardOop?: boolean;
  costSharingOrder?: 'copay_then_coinsurance' | 'greater_of' | 'lesser_of';
  copayBeforeDeductible?: boolean;
  conditions?: BenefitCondition[];
  id: string; category: ServiceCategory; label: string; coverage: CoverageStatus;
  network: 'in_network' | 'out_of_network' | 'any';
  copayCents: number | null; coinsuranceBps: number | null;
  appliesDeductible: boolean; accumulator: 'medical' | 'drug' | 'none';
  deductibleCents?: number | null; oopMaxCents?: number | null;
  visitLimit?: number; insurerPaymentCapCents?: number; waitingDays?: number;
  priorAuthorization?: boolean; referralRequired?: boolean; explanation: string; source: SourceRef;
}
export interface PlanProvider { npi: string; name: string; location: string; network: NetworkStatus; source: SourceRef }
export interface PlanDrug { rxnorm?: string; ndc?: string; name: string; strength?: string; form?: string; coverage: CoverageStatus; tier?: string; priorAuthorization?: boolean; stepTherapy?: boolean; quantityLimit?: string; source: SourceRef }
export interface PriceObservation { id: string; category: ServiceCategory; serviceCode?: string; providerNpi?: string; providerLocation?: string; medicationCode?: string; unitPriceCents: number; basis: 'contracted' | 'plan_average' | 'regional_estimate'; source: SourceRef; priceType?: 'allowed' | 'cash' | 'billed'; balanceBillingCents?: number; quantityUnit?: 'service' | 'fill' | 'dispensed_unit'; dispensedQuantity?: number; daysSupply?: number }
export interface Plan {
  serviceAreas?: { countyFips: string; zipCodes?: string[]; wholeCounty: boolean; source?: SourceRef }[];
  premiumSource?: SourceRef;
  medicalOopUnbounded?: boolean; drugOopUnbounded?: boolean;
  accumulators?: AccumulatorDefinition[];
  insurerPaymentCapCents?: number | null;
  conditions?: BenefitCondition[];
  drugBenefitPhases?: DrugBenefitPhases;
  id: string; name: string; issuer: string; family: PlanFamily; year: number;
  state: string; countyFips: string[]; status: 'available' | 'withdrawn' | 'unknown';
  effectiveStart: string; effectiveEnd: string; monthlyPremiumCents: number | null;
  premiumEstimated: boolean; deductibleCents: number | null; oopMaxCents: number | null;
  drugDeductibleCents: number | null; drugOopMaxCents: number | null;
  metalLevel?: string; planType?: string; benefits: BenefitRule[]; providers: PlanProvider[]; drugs: PlanDrug[];
  prices: PriceObservation[]; source: SourceRef; documentUrls: { label: string; url: string }[];
  rulesVerified: boolean; underwritingRequired: boolean;
  networkComplete: boolean; formularyComplete: boolean;
  rating?: { minAge?: number; maxAge?: number; tobacco?: boolean; age?: number; countyFips?: string };
}
export interface EligibilityResult { family: PlanFamily; status: 'likely_eligible' | 'likely_ineligible' | 'unknown'; reasons: string[]; missing: string[]; sources: string[] }
export interface CostLine { eventId: string; label: string; coverage: CoverageStatus; network: NetworkStatus; allowedCents: number | null; patientCents: number | null; insurerCents: number | null; estimated: boolean; explanation: string[]; sourceIds: string[] }
export interface CostEstimate { planId: string; premiumCents: number | null; planPremiumCents?: number | null; additionalPremiumCents?: number | null; careCents: number; totalCents: number | null; knownSubtotalCents: number; unpricedCount: number; estimated: boolean; lines: CostLine[]; warnings: string[]; coverageMonths: number }
export interface ComparisonResult { plan: Plan; cost: CostEstimate; providerMatches: { providerId: string; status: NetworkStatus; details: string }[]; medicationMatches: { medicationId: string; status: CoverageStatus; details: string }[] }
export interface ComparisonInput { profile: PersonProfile; providers: ProviderPreference[]; medications: Medication[]; events: ExpectedCareEvent[]; planIds: string[]; releaseId?: string; conditions?: ConditionConfirmation[]; additionalMonthlyPremiums?: Record<string, number | null> }
export interface CatalogCoverage { state: string; family: PlanFamily; year: number; status: 'available' | 'not_offered' | 'source_gap'; planCount: number; lastUpdated: string | null; note: string }
export interface CatalogSearch { plans: Plan[]; coverage: CatalogCoverage[]; releaseId: string | null; total: number; warnings: string[] }
export interface ConditionConfirmation { conditionId: string; status: 'satisfied' | 'not_satisfied' | 'unknown'; evidence?: Evidence[] }
export interface BenefitCondition { id: string; label: string; source?: SourceRef }
export interface AccumulatorDefinition { id: string; deductibleCents: number | null; oopMaxCents: number | null; oopUnbounded?: boolean }
export interface DrugBenefitPhase {
  id: string; label: string;
  until: { ledger: 'drug_allowed' | 'drug_oop' | 'drug_deductible'; cents: number } | null;
  coinsuranceBps: number; copayCents?: number;
  patientOopCreditBps: number; additionalOopCreditBps: number;
}
export interface DrugBenefitPhases { phases: DrugBenefitPhase[]; source: SourceRef }
export interface ConnectorStatus { id: string; key: string; organizationId: string; name: string; kind: ConnectorKind; apiType: ConnectorApiType; configured: boolean; enabled: boolean; reason?: string; testEnvironment?: boolean }
export interface AppStatus { year: number; connectors: ConnectorStatus[]; ai: { enabled: boolean; reason?: string }; catalog: { available: boolean; releaseId: string | null; planCount: number }; productionReady: boolean; issues: string[] }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface AiProposal { id: string; kind: 'expected_care' | 'provider' | 'medication'; value: Record<string, unknown>; evidenceIds: string[]; explanation: string }
export interface AssistantReply { message: string; proposals: AiProposal[]; evidenceIds: string[] }
