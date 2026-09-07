import type { EligibilityResult, PersonProfile } from '../shared/contracts';
import { cents, validDate } from './primitives';

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
export function evaluateEligibility(profile: PersonProfile): EligibilityResult[] {
  const common: string[] = [];
  if (!STATES.has(profile.state)) common.push('A supported state of residence is required.');
  if (!/^\d{5}$/.test(profile.zip)) common.push('A five-digit ZIP code is required.');
  if (!/^\d{5}$/.test(profile.countyFips)) common.push('A county FIPS code is required to check plan service areas.');
  if (!validDate(profile.dateOfBirth)) common.push('A valid date of birth is required.');
  if (!validDate(profile.coverageStart) || !validDate(profile.coverageEnd) || profile.coverageStart > profile.coverageEnd) common.push('A valid coverage period is required.');
  if (validDate(profile.dateOfBirth) && profile.dateOfBirth > profile.coverageStart) common.push('Date of birth cannot follow the requested coverage start.');
  if (profile.coverageStart.slice(0, 4) !== '2026' || profile.coverageEnd.slice(0, 4) !== '2026') common.push('This release supports 2026 only.');

  const aca: EligibilityResult = { family: 'aca', status: 'unknown', reasons: [], missing: [...common], sources: ['https://www.healthcare.gov/quick-guide/eligibility/', 'https://www.healthcare.gov/income-and-household-information/household-size/', 'https://www.healthcare.gov/glossary/affordable-coverage/'] };
  if (profile.citizenshipEligible === 'unknown') aca.missing.push('Marketplace citizenship/immigration eligibility has not been confirmed.');
  if (profile.incarcerated === 'unknown') aca.missing.push('Marketplace incarceration eligibility has not been confirmed.');
  if (profile.enrollmentEvent === 'unknown' || profile.enrollmentEvent === 'other') aca.missing.push('Enrollment-period or qualifying-event details need verification.');
  if (profile.citizenshipEligible === 'no' || profile.incarcerated === 'yes') {
    aca.status = 'likely_ineligible';
    aca.reasons.push('A reported Marketplace eligibility requirement is not met; an official determination may account for exceptions.');
  } else if (aca.missing.length === 0) aca.status = 'likely_eligible';
  aca.reasons.push('Preliminary access guidance from reported facts; plan availability and enrollment-event dates still require verification.');
  if (profile.medicarePartA === 'yes' || profile.medicarePartB === 'yes') {
    aca.status = 'unknown';
    aca.reasons.push('Reported Medicare coverage requires coordination review before treating Marketplace coverage as an available replacement.');
  }
  const assistanceMissing: string[] = [];
  if (!Number.isSafeInteger(profile.householdSize) || profile.householdSize < 1) assistanceMissing.push('Tax-household size');
  if (!cents(profile.annualIncomeCents)) assistanceMissing.push('Expected coverage-year household income');
  if (!profile.taxFilingStatus || profile.taxFilingStatus === 'unknown') assistanceMissing.push('Tax filing status');
  if (!profile.claimedAsDependent || profile.claimedAsDependent === 'unknown') assistanceMissing.push('Tax dependency status');
  if (profile.employerOffer === 'unknown') assistanceMissing.push('Employer offer status');
  if (profile.employerOffer === 'yes') {
    if (!cents(profile.employerMonthlyContributionCents)) assistanceMissing.push('Applicable employee premium contribution');
    if (profile.employerMinimumValue === 'unknown') assistanceMissing.push('Employer minimum-value status');
    if (!profile.employerOfferRelationship || profile.employerOfferRelationship === 'unknown') assistanceMissing.push('Whose employer makes the offer');
  }
  aca.missing.push(...assistanceMissing.map(field => `${field} is needed for financial-assistance review.`));
  aca.reasons.push('Financial assistance is not calculated: a single enrollee can belong to a larger tax household, and an employer offer can affect assistance even when not accepted.');

  const medicare: EligibilityResult = { family: 'medicare_advantage', status: 'unknown', reasons: ['Preliminary guidance only; the specific plan service area, enrollment timing and any special-plan conditions must also be verified.'], missing: [...common], sources: ['https://www.medicare.gov/health-drug-plans/health-plans/your-coverage-options/Medicare-Advantage-Plans/join-switch-drop'] };
  if (profile.medicarePartA === 'unknown') medicare.missing.push('Medicare Part A enrollment must be confirmed.');
  if (profile.medicarePartB === 'unknown') medicare.missing.push('Medicare Part B enrollment must be confirmed.');
  if (profile.medicarePartA === 'no' || profile.medicarePartB === 'no') {
    medicare.status = 'likely_ineligible'; medicare.reasons.push('Joining Medicare Advantage generally requires both Medicare Part A and Part B.');
  } else if (medicare.missing.length === 0) medicare.status = 'likely_eligible';

  return [aca, { family: 'short_term', status: 'unknown', reasons: ['Short-term availability, policy term and acceptance depend on current state-specific rules and the issuer policy. Medical records do not establish underwriting acceptance.'], missing: [...common, 'A verified state/date-specific policy and any required underwriting determination.'], sources: ['https://www.cms.gov/files/document/statement-regarding-short-term-limited-duration-insurance.pdf'] }, medicare];
}
