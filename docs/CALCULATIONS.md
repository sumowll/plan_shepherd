# Calculation behavior and qualification

This document describes the implemented deterministic engine in `src/domain`, not an assertion that every real policy has already been modeled or independently validated. Production comparison requires a reviewed catalog release whose benefits, prices, networks, formularies and policy conditions are accurately represented by the supported rule semantics.

The agreed scope is one coverage applicant, nationally, for 2026 ACA Marketplace, short-term medical and Medicare Advantage plans. The application compares plans without an AI recommendation or composite ranking. User inputs, imported evidence and public plan facts remain distinct.

## Inputs and evidence

`src/shared/contracts.ts` defines the common input and output types. `src/server/validation.ts` validates submitted profiles and comparison inputs; `src/catalog/schema.ts` validates public reference data separately.

- A profile includes residence, coverage dates, birth date, reported Medicare enrollment, citizenship/incarceration eligibility answers, enrollment context, tax-household size, income and employer-offer information. Optional tax-filing/dependency and employer-relationship fields retain relevant context even though only one person is enrolling.
- Preferred providers have separate identities and practice locations. Medication records retain exact product identifiers, strength, formulation and intended ongoing use.
- Anticipated care consists of dated, confirmed events. An event contains a service category or an actual supplied billing code, quantity, provider/medication reference and optional explicit price assumption. Clinical labels never create a billing code.
- Prescription events represent **one fill each**. Dispensed pills/units and days supply are separate fields. Represent additional fills as separate dated events so deductible and drug-phase transitions are replayed in order.
- A public plan snapshot contains exact identity, year, geography, term, premium applicability, sourced benefit rules, provider/formulary entries, price observations and verification status. A null monetary field is unknown, not zero. An explicitly unbounded OOP flag distinguishes a known lack of a cap from a missing cap.

Every price and plan rule used in the comparison carries source identifiers. Raw source evidence, drafts and overrides remain session data. The source catalog and its immutable release ID contain public reference information only.

## Preliminary eligibility

`evaluateEligibility(profile)` returns one result per supported family, including reasons, missing information and official source links. It supplies preliminary guidance; it does not make an enrollment determination.

- ACA guidance checks reported basic eligibility and completeness of the relevant intake fields. Medicare enrollment triggers coordination review. Financial-assistance review is explicitly separate from access guidance.
- Medicare Advantage guidance considers reported Part A and Part B enrollment and location/date completeness. It does not infer entitlement from age, diagnoses or claims.
- Short-term results remain unknown until state/date-specific policy availability and issuer acceptance can be verified. The engine does not perform medical underwriting.
- Premium tax credits, cost-sharing reduction qualification, employer affordability and other assistance amounts are **not calculated** by the current engine. The profile collects necessary context without inventing an assistance amount. A user may explicitly enter the additional Medicare premium scenario described below; its stated net amount is used without independently calculating assistance.
- Enrollment-event dates, special-plan qualifications, tax-household exceptions and complete jurisdiction-specific eligibility rules require authoritative, versioned adapters and independent review before the product represents those determinations as implemented.

One enrollee does not imply a one-person tax household. An employer offer is different from current enrollment, and a paid Cigna claim does not establish whether a future employer offer is affordable. See [Marketplace household guidance](https://www.healthcare.gov/income-and-household-information/household-size/) and [employer-offer guidance](https://www.healthcare.gov/glossary/affordable-coverage/).

## Historical normalization and the future-care draft

`normalizeHistory(events, claimSnapshots)` groups repeated records by source and stable event identity. EOB snapshots preserve the containing resource version and line membership, so newer complete revisions retire removed lines and cancelled claims retire their prior lines; partial or conflicting revisions remain unresolved. Source timestamps or numeric versions resolve newer records where possible; equal-version conflicts remain unknown. Explicit replacements cancel the replaced record, and reversed/cancelled events are retained as history rather than replayed as completed care.

`buildForecast(events, year)` uses completed events from the previous calendar year. It moves their dates into the requested year, clamps a leap-day anniversary to February 28 where necessary, and sets every draft to `confirmed: false`. Historical allowed amounts become explicitly labeled price assumptions. Prescription orders do not become fills; one-time or discontinued care is not automatically classified as recurring or ongoing.

Reimport uses a three-way merge to preserve manual provider/medication corrections and selections. Changed claim meaning, changed linked records, or a new claim superseding a forecasted encounter invalidate dependent confirmations. The user can review the newer source draft or keep their edited scenario explicitly; source changes never silently replace a confirmed forecast. Positive fractional medical units and dispensed prescription quantities remain distinct from one dated fill.

An encounter explicitly linked to a claim in the same source is not counted as another bill. Trusted absolute and relative references to the same encounter are normalized consistently. An absolute, shared encounter reference can also establish a link. Coinciding source-local IDs in different systems do not establish identity. Potential encounter/claim overlap is labeled for review; distinct professional, facility and laboratory lines remain separate.

The FHIR adapter normalizes pharmacy claims and MedicationDispense records to one fill, preserving the dispensed quantity separately. It retains nested claim leaf services without copying parent totals onto each leaf. Preauthorization/predetermination EOBs, prepared-only medication records, invalid quantities and unresolved statuses do not become automatically completed utilization. Missing, out-of-range, conflicting or unresolved source information is reported.

FHIR semantics are grounded in the [R4 ExplanationOfBenefit definitions](https://hl7.org/fhir/R4/explanationofbenefit-definitions.html) and [R4 MedicationDispense definitions](https://hl7.org/fhir/R4/medicationdispense-definitions.html). The actual payer/EHR profiles and terminology mappings still require live qualification.

## Provider and medication matching

Provider matching requires an exact NPI and normalized selected location. A name alone is insufficient. Conflicting entries remain unknown. Absence establishes out-of-network status only when the catalog explicitly declares the applicable network complete.

Medication matching uses exact NDC or RxNorm identifiers and supplied strength/formulation. A conflicting NDC is not replaced by a shared RxNorm concept. RxNorm matches need explicit strength/formulation confirmation because the intake contract does not itself certify the concept's level. An unmatched NDC does not waive the strength/formulation requirement when the actual match falls back to RxNorm. Names alone do not establish formulary coverage. Absence from an incomplete formulary remains unknown. Authorization, step therapy and quantity limits produce conditional coverage until their explicit conditions are satisfied.

Network and formulary assertions are checked against the service date; comparison summaries use the coverage start date. Future-effective entries do not establish earlier coverage.

The implementation does not infer brand substitutions, therapeutic equivalence, provider participation from old claims, or pharmacy-network participation from a provider NPI. Full pharmacy-channel pricing, route-sensitive matching and additional terminology crosswalks require their own authoritative inputs and adapters.

## Event-by-event monetary replay

`comparePlans(input, plans)` simulates the same confirmed care input independently under each selected plan. It checks plan identity, year, service area (including supplied partial-county ZIP restrictions), status, period and premium rating applicability. Unverified rules do not produce a complete cost result.

For each candidate:

1. Deduplicate identical event IDs; conflicting duplicates remain unknown. Sort by service date and stable event ID. Same-day ID ordering is explicitly labeled as a scenario assumption because actual adjudication order may differ.
2. Select the applicable category, network, service-code and drug-tier benefit. Multiple equally specific matches remain unknown; source order does not choose a winner.
3. Check policy term, waiting period, visit limits, exclusions and explicit plan/benefit/drug conditions. An unresolved condition is not an approved claim.
4. Select an applicable price using available service, provider/location, medication, unit and effective-date dimensions. Conflicting equally applicable prices remain unknown. A user estimate must explicitly identify an allowed amount for covered adjudication or a cash/billed amount for uncovered spending; those price types are not interchangeable. Historical allowed amounts may supply an explicitly labeled scenario assumption.
5. Apply the configured deductible and copay/coinsurance semantics. When both copay and coinsurance are positive, an explicit combination rule is required. Supported combinations include copay then coinsurance, greater-of and lesser-of. Copay-before-deductible behavior is explicit.
6. Credit only the configured payment components to the configured OOP accumulators. Named accumulator IDs support shared medical/drug deductibles and simultaneous network/combined OOP credits; default medical and drug ledgers are separate.
7. Apply benefit-specific and plan-wide insurer payment caps. Spending above an insurer payout cap becomes additional patient spending without invented OOP credit. An insurer payment maximum is not a patient spending maximum.
8. Produce event costs, sources and explanations; add premiums for the actual intersecting coverage months. A shorter policy is not assumed renewable. A partial-month premium is labeled as an estimate using full billed calendar months.

Amounts are nonnegative safe-integer cents. Multiplication and basis-point ratios use integer/BigInt decimal arithmetic with half-up rounding. Quantity extension supports at most six decimal places and rejects unsupported precision. The FHIR money parser requires USD and converts the supplied decimal representation before rounding to cents; it does not use binary floating-point `value * 100` for adjudication.

The engine presents one specified anticipated-care scenario at a time. It does not generate a utilization prediction, statistical confidence interval, correlated scenario range or guaranteed worst-case annual spending number.

### Synthetic worked example

Assume an invented plan with a $1,000 deductible, 20% coinsurance after that deductible and a $2,000 covered OOP cap. Three chronologically ordered allowed services are $600, $1,000 and $6,000.

| Event | Patient cost | Explanation |
| --- | ---: | --- |
| $600 service | $600 | Applied to the deductible |
| $1,000 service | $520 | Remaining $400 deductible plus 20% of $600 |
| $6,000 service | $880 | Remaining covered OOP capacity |
| $400 excluded service with a supplied cash price | $400 | Outside the covered OOP cap |

Covered care totals $2,000; all four services cost the patient $2,400. At $100 per month, twelve months of premiums add $1,200 for a $3,600 specified-scenario total. These are test parameters, not legal thresholds or an actual plan.

## Medicare premiums

A Medicare Advantage plan premium alone is insufficient for a complete premium comparison. Medicare describes continued Part B premiums and potentially applicable Part A and income-related premiums in its [official cost guidance](https://www.medicare.gov/basics/costs/medicare-costs).

`additionalMonthlyPremiums[planId]` is a manual, nonnegative integer-cent scenario covering Part A/Part B and IRMAA, net of applicable assistance or giveback for that candidate. It must **exclude the candidate plan premium** to avoid double counting. The engine does not determine these amounts or assume a standard rate. Missing, null or invalid input leaves the combined premium and complete cost total unknown; an explicitly entered zero is valid. Valid supplied amounts are marked estimated and multiplied by the intersecting coverage months. Partial months use the same disclosed full-month billing assumption as candidate premiums. ACA and short-term plans ignore this input.

`planPremiumCents` and `additionalPremiumCents` are independent full-period components. `premiumCents` is their sum only when both are known. Known components remain in `knownSubtotalCents` even when the other is unknown; neither affects deductible or OOP accumulators.

## Medicare drug phases

Medicare Advantage prescription simulations require `drugBenefitPhases` with a registered source. Phases specify their transition ledger (`drug_allowed`, qualifying `drug_oop`, or separate `drug_deductible` credit), threshold, cost-sharing rate and qualifying OOP credit behavior. Plan/tier-specific overrides are explicit. Deductible-credit phases use `appliesDeductible` to distinguish exempt tiers and can encode source-specific `deductibleCreditBps` overrides. Exempt copays can still receive qualifying OOP credit without advancing the deductible. Existing `drug_allowed` phases retain their declared gross-spending meaning. A fill can cross supported deductible and spending phases without sending drug spending through the medical OOP cap.

There are no timeless Medicare phase thresholds hardcoded into the engine. The [CMS final CY 2026 Part D instructions](https://www.cms.gov/newsroom/fact-sheets/final-cy-2026-part-d-redesign-program-instructions) are an authoritative rule source to encode and independently review, not a substitute for every candidate's actual benefit design or assistance rules.

Source-specific split-fill copay allocation is currently unresolved when a copay fill crosses phases. Combining this phase adapter with a separate insurer payout cap or medical/shared accumulators is also unresolved. These cases return unknown rather than silently assuming ordinary medical cost sharing. A complete Part D/assistance and payer-liability implementation needs explicit additional source semantics and independently checked fixtures.

## Unknown and conditional results

`careCents` is the sum of priced patient-care lines. `knownSubtotalCents` adds each known premium component. `totalCents` is null if a required line, premium component, rule, context, full requested policy term or plan-level condition remains unresolved. `unpricedCount` counts lines with unknown patient amounts. The visible subtotal must retain its "known subtotal" meaning; it is not a complete annual estimate.

An unresolved earlier event marks potentially affected accumulators as uncertain. Later costs that depend on them remain unknown, while a genuinely separate drug or medical ledger can still produce a known subtotal. The engine does not assume that an unpriced service consumed zero deductible or OOP capacity. Equally applicable price observations are compared after extending their fill/unit basis; conflicting extended amounts remain unknown rather than being selected by record ID. Source and generated condition identifiers are qualified by plan, so an authorization for one candidate cannot satisfy another candidate's condition; contradictory confirmations remain unresolved.

Specific conservative cases include:

- Missing/invalid copay, coinsurance, deductible or OOP semantics; unknown is not zero or unlimited.
- Unconfirmed care drafts, ambiguous identity references, conflicting prices/rules, future-effective benefit sources and missing exact medication identity.
- Unresolved authorization/referral/underwriting/step-therapy conditions; user confirmation is a scenario input, not independent issuer verification.
- A service straddling a visit limit without separate covered/uncovered units and the corresponding cash price.
- Out-of-network balance billing without an explicit amount. A negotiated allowed amount does not establish total patient responsibility.
- Excluded care without a cash/billed price; historical allowed charges do not silently become uncovered cash prices.
- Missing prescription price units or incompatible days supply/dispensed quantity.
- Short-term policy expiry, unsupported source-specific drug rules and amounts beyond supported precision.

## Qualification and regression criteria

`tests/domain/domain.test.ts` and `tests/server/fhir.test.ts` include independently calculated deductible/cap/chronology fixtures, shared versus separate ledgers, payout limits, phase transitions, incomplete prices, exact identities, revisions, reversals, medication units, decimal money, patient ownership, nested claims and date boundaries.

Before publishing a production rule pack, obtain independent expected results for representative candidate designs and every materially different supported rule path. Verify issuer source terms, actual price applicability and eligibility rules as of the release date. Add a fixture before adding an adapter for an unresolved case. A `rulesVerified` flag or passing synthetic tests cannot itself establish that a real policy has been encoded correctly.
