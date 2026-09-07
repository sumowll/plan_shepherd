import { describe, expect, it } from 'vitest';
import { fhirMoneyCents, normalizeFhir, resourcesFromPage, nextPage } from '../../src/connectors/fhir';
import { buildForecast, normalizeHistory } from '../../src/domain';
describe('FHIR adapter', () => {
  it('retains separate claim lines and distinguishes money types', () => {
    const result = normalizeFhir([{ resourceType: 'ExplanationOfBenefit', id: 'claim', status: 'active', outcome: 'complete', provider: { display: 'Dr Test', identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' } }, item: [{ sequence: 1, servicedDate: '2025-02-01', productOrService: { text: 'Office visit' }, adjudication: [{ category: { coding: [{ code: 'submitted' }] }, amount: { value: 150, currency: 'USD' } }, { category: { coding: [{ code: 'eligible' }] }, amount: { value: 100, currency: 'USD' } }, { category: { coding: [{ code: 'copay' }] }, amount: { value: 20, currency: 'USD' } }] }, { sequence: 2, servicedDate: '2025-02-01', productOrService: { text: 'Laboratory test' } }] }], 'cigna');
    expect(result.events).toHaveLength(2); expect(result.events[0].billedCents).toBe(15000); expect(result.events[0].allowedCents).toBe(10000); expect(result.events[0].patientCents).toBe(2000); expect(result.events[1].allowedCents).toBeUndefined(); expect(result.providers[0].preferred).toBe(false);
  });
  it('never treats a prescription order as an ongoing medication or completed fill', () => {
    const result = normalizeFhir([{ resourceType: 'MedicationRequest', id: 'med', status: 'active', authoredOn: '2025-01-01', medicationCodeableConcept: { text: 'Test medicine', coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '123' }] } }], 'atrius');
    expect(result.medications[0].ongoing).toBe(false); expect(result.events[0].kind).toBe('prescription_order'); expect(result.events[0].status).toBe('unknown');
  });
  it('keeps negative/error records and never fabricates absent service dates', () => {
    const result = normalizeFhir([{ resourceType: 'Encounter', id: 'cancelled', status: 'cancelled', period: { start: '2025-01-01' } }, { resourceType: 'Encounter', id: 'undated', status: 'finished' }], 'atrius');
    expect(result.events).toHaveLength(1); expect(result.events[0].status).toBe('cancelled'); expect(result.warnings.some(x => x.includes('service date'))).toBe(true);
  });
  it('recognizes bundle resources and continuation links', () => {
    const page = { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Encounter', id: 'a' } }], link: [{ relation: 'next', url: 'https://provider.example/fhir/Encounter?page=2' }] };
    expect(resourcesFromPage(page)).toHaveLength(1); expect(nextPage(page)).toContain('page=2');
  });
});

const drugCode = (ndc: string) => ({ text: 'Synthetic medicine', coding: [{ system: 'http://hl7.org/fhir/sid/ndc', code: ndc }, { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '123' }] });
const eob = (patch: Record<string, unknown> = {}) => ({ resourceType: 'ExplanationOfBenefit', id: 'claim', status: 'active', outcome: 'complete', use: 'claim', patient: { reference: 'Patient/p' }, ...patch });
const adjudication = (code: string, value: number, currency: string | undefined = 'USD') => ({ category: { coding: [{ code }] }, amount: { value, ...(currency ? { currency } : {}) } });

describe('claim snapshot and encounter reconciliation', () => {
  const line = (sequence: number) => ({ sequence, servicedDate: '2025-02-01', productOrService: { text: 'Service' }, quantity: { value: 1 }, adjudication: [adjudication('eligible', 100)] });
  const claim = (version: string, item: unknown[], patch: Record<string, unknown> = {}) => eob({ meta: { versionId: version, lastUpdated: '2025-03-01T00:00:00Z' }, item, ...patch });
  it('tombstones removed lines from newer complete EOB versions without dropping historical evidence', () => {
    const first = normalizeFhir([claim('1', [line(1), line(2)])], 'cigna');
    const next = normalizeFhir([claim('2', [line(1)])], 'cigna');
    const merged = normalizeHistory([...first.events, ...next.events], next.claimSnapshots);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ status: 'cancelled', version: '2', sourceResourceId: 'ExplanationOfBenefit/claim' });
    expect(merged[1].evidence).toEqual(first.events[1].evidence);
    expect(buildForecast(merged, 2026)).toHaveLength(1);
    expect(normalizeHistory(merged, next.claimSnapshots)).toEqual(merged);
    expect(buildForecast(normalizeHistory([...merged, ...first.events], first.claimSnapshots), 2026)).toHaveLength(1);
  });
  it('applies an explicit cancellation even when the newer EOB has no item lines', () => {
    const first = normalizeFhir([claim('1', [line(1), line(2)])], 'cigna');
    const cancelled = normalizeFhir([claim('2', [], { status: 'cancelled' })], 'cigna');
    expect(cancelled.claimSnapshots?.[0]).toMatchObject({ status: 'cancelled', eventIds: [] });
    const merged = normalizeHistory([...first.events, ...cancelled.events], cancelled.claimSnapshots);
    expect(merged.map(event => event.status)).toEqual(['cancelled', 'cancelled']);
    expect(buildForecast(merged, 2026)).toEqual([]);
  });
  it('marks omitted services unknown when a newer snapshot is incomplete, without inventing deletion', () => {
    const first = normalizeFhir([claim('1', [line(1), line(2)])], 'cigna');
    const next = normalizeFhir([claim('2', [line(1), { ...line(2), servicedDate: 'invalid' }])], 'cigna');
    expect(next.claimSnapshots?.[0].complete).toBe(false);
    const merged = normalizeHistory([...first.events, ...next.events], next.claimSnapshots);
    expect(merged[1].status).toBe('unknown');
    expect(buildForecast(merged, 2026)).toHaveLength(1);
    const unrelated = next.claimSnapshots!.map(snapshot => ({ ...snapshot, resourceId: 'ExplanationOfBenefit/another-claim' }));
    expect(normalizeHistory(first.events, unrelated).map(event => event.status)).toEqual(['completed', 'completed']);
  });
  it('leaves conflicting same-version snapshots unresolved and isolated by source', () => {
    const first = normalizeFhir([claim('1', [line(1)])], 'cigna');
    const changed = normalizeFhir([claim('1', [], { status: 'cancelled' })], 'cigna');
    expect(normalizeHistory(first.events, changed.claimSnapshots)[0].status).toBe('unknown');
    expect(normalizeHistory(first.events, changed.claimSnapshots!.map(snapshot => ({ ...snapshot, source: 'atrius' })))[0].status).toBe('completed');
  });
  it('reconciles multiple versions in one response regardless of arrival order', () => {
    const all = normalizeFhir([claim('2', [line(1)]), claim('1', [line(1), line(2)])], 'cigna');
    const reversed = normalizeFhir([claim('1', [line(1), line(2)]), claim('2', [line(1)])], 'cigna');
    expect(normalizeHistory(all.events, all.claimSnapshots)).toEqual(normalizeHistory(reversed.events, reversed.claimSnapshots));
    expect(buildForecast(normalizeHistory(all.events, all.claimSnapshots), 2026)).toHaveLength(1);
  });
  it('deduplicates trusted absolute encounter links while retaining foreign references', () => {
    const base = 'https://provider.example/fhir';
    const encounter = { resourceType: 'Encounter', id: 'visit', status: 'finished', period: { start: '2025-02-01' }, type: [{ text: 'Service' }] };
    const records = resourcesFromPage({ resourceType: 'Bundle', entry: [{ fullUrl: `${base}/Encounter/visit`, resource: encounter }, { resource: claim('1', [{ ...line(1), encounter: [{ reference: `${base}/Encounter/visit` }] }]) }] });
    const linked = normalizeFhir(records, 'atrius');
    expect(linked.events.map(event => event.encounterId)).toEqual(['Encounter/visit', 'Encounter/visit']);
    expect(buildForecast(linked.events, 2026)).toHaveLength(1);
    const foreign = normalizeFhir([encounter, claim('1', [{ ...line(1), encounter: [{ reference: 'https://other.example/fhir/Encounter/visit' }] }])], 'atrius', { fhirBase: base });
    expect(buildForecast(foreign.events, 2026)).toHaveLength(2);
  });
});

describe('FHIR monetary and identity regressions', () => {
  it('rounds decimal monetary inputs exactly and rejects missing/non-USD currency', () => {
    expect(fhirMoneyCents({ value: 1.005, currency: 'USD' })).toBe(101);
    expect(fhirMoneyCents({ value: 2.675, currency: 'USD' })).toBe(268);
    expect(fhirMoneyCents({ value: 1e-7, currency: 'USD' })).toBe(0);
    expect(fhirMoneyCents({ value: 10 })).toBeUndefined();
    expect(fhirMoneyCents({ value: 10, currency: 'EUR' })).toBeUndefined();
    expect(fhirMoneyCents({ value: -10, currency: 'USD' })).toBeUndefined();
    expect(fhirMoneyCents({ value: 1e20, currency: 'USD' })).toBeUndefined();
  });
  it('deduplicates identical adjudication aliases and leaves conflicting amounts unknown', () => {
    const result = normalizeFhir([eob({ item: [{ sequence: 1, servicedDate: '2025-02-01', adjudication: [adjudication('eligible', 10), adjudication('allowed', 10)] }, { sequence: 2, servicedDate: '2025-02-01', adjudication: [adjudication('eligible', 10), adjudication('allowed', 20)] }] })], 'cigna');
    expect(result.events[0].allowedCents).toBe(1000);
    expect(result.events[1].allowedCents).toBeUndefined();
    expect(result.complete).toBe(false);
  });
  it('does not collapse distinct NDC products through a shared RxNorm code', () => {
    const result = normalizeFhir(['12345678901', '12345678902'].map((ndc, index) => ({ resourceType: 'MedicationDispense', id: String(index), status: 'completed', whenHandedOver: '2025-02-01', medicationCodeableConcept: drugCode(ndc), quantity: { value: 30, unit: 'tablet' } })), 'atrius');
    expect(result.medications).toHaveLength(2);
    expect(new Set(result.events.map(event => event.medicationId)).size).toBe(2);
  });
  it('normalizes pharmacy quantities as fills while preserving dispensed units and supply', () => {
    const result = normalizeFhir([{ resourceType: 'MedicationDispense', id: 'fill', status: 'completed', whenHandedOver: '2025-02-01', medicationCodeableConcept: drugCode('12345678901'), quantity: { value: 30, unit: 'tablet' }, daysSupply: { value: 1, code: 'wk' } }, eob({ type: { coding: [{ code: 'pharmacy' }] }, item: [{ sequence: 1, servicedDate: '2025-03-01', quantity: { value: 90, unit: 'tablet' }, productOrService: drugCode('12345678901'), adjudication: [adjudication('eligible', 90)] }] })], 'cigna');
    expect(result.events.map(event => event.quantity)).toEqual([1, 1]);
    expect(result.events.map(event => event.quantityUnit)).toEqual(['fill', 'fill']);
    expect(result.events.map(event => event.dispensedQuantity)).toEqual([30, 90]);
    expect(result.events[0].daysSupply).toBe(7);
    expect(buildForecast(result.events, 2026)[1]).toMatchObject({ quantity: 1, dispensedQuantity: 90, unitPriceCents: 9000 });
  });
  it('does not misclassify a medically administered drug as a pharmacy fill', () => {
    const result = normalizeFhir([eob({ type: { coding: [{ code: 'professional' }] }, item: [{ sequence: 1, servicedDate: '2025-02-01', productOrService: drugCode('12345678901'), quantity: { value: 2 } }] })], 'cigna');
    expect(result.events[0].kind).toBe('claim');
    expect(result.events[0].category).toBe('other');
    expect(result.events[0].quantity).toBe(2);
  });
  it('does not turn preauthorizations and prepared medication into completed utilization', () => {
    const result = normalizeFhir([eob({ use: 'preauthorization', item: [{ sequence: 1, servicedDate: '2025-02-01' }] }), { resourceType: 'MedicationDispense', id: 'prepared', status: 'completed', whenPrepared: '2025-02-01', medicationCodeableConcept: drugCode('12345678901'), quantity: { value: 30 } }], 'cigna');
    expect(result.events.every(event => event.status === 'unknown')).toBe(true);
    expect(buildForecast(result.events, 2026)).toEqual([]);
  });
  it('keeps nested separately billed leaves without allocating a parent total to each', () => {
    const result = normalizeFhir([eob({ item: [{ sequence: 1, servicedDate: '2025-02-01', adjudication: [adjudication('eligible', 100)], detail: [{ sequence: 1, productOrService: { text: 'Facility' }, adjudication: [adjudication('eligible', 70)] }, { sequence: 2, productOrService: { text: 'Professional' }, adjudication: [adjudication('eligible', 30)] }] }] })], 'cigna');
    expect(result.events).toHaveLength(2);
    expect(result.events.map(event => event.allowedCents)).toEqual([7000, 3000]);
    expect(result.events.map(event => event.id)).toEqual(['cigna:ExplanationOfBenefit:claim:line:1.1', 'cigna:ExplanationOfBenefit:claim:line:1.2']);
    expect(result.complete).toBe(false);
  });
  it('enforces valid service dates and requested history bounds', () => {
    const result = normalizeFhir(['2025-02-30', '2025-01-01junk', '2024-12-31', '2025-03-01'].map((date, index) => ({ resourceType: 'Encounter', id: String(index), status: 'finished', period: { start: date } })), 'atrius', { from: '2025-01-01', to: '2025-12-31' });
    expect(result.events.map(event => event.date)).toEqual(['2025-03-01']);
    expect(result.complete).toBe(false);
  });
  it('retains minimum patient demographics and rejects mismatched clinical subjects', () => {
    const result = normalizeFhir([{ resourceType: 'Patient', id: 'p', name: [{ given: ['Alex'], family: 'Test' }], birthDate: '1980-01-01' }, { resourceType: 'Encounter', id: 'valid', status: 'finished', subject: { reference: 'Patient/p' }, period: { start: '2025-02-01' } }, { resourceType: 'Encounter', id: 'other', status: 'finished', subject: { reference: 'Patient/other' }, period: { start: '2025-02-01' } }], 'atrius', { patientId: 'p' });
    expect(result.patient).toMatchObject({ id: 'p', source: 'atrius', name: 'Alex Test', dateOfBirth: '1980-01-01' });
    expect(result.events).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
  it('does not choose between conflicting patient demographics', () => {
    expect(normalizeFhir([{ resourceType: 'Patient', id: 'p', birthDate: '1980-01-01' }, { resourceType: 'Patient', id: 'p', birthDate: '1990-01-01' }], 'atrius').patient).toBeUndefined();
  });
  it('resolves an authorized PractitionerRole through practitioner and location records', () => {
    const result = normalizeFhir([{ resourceType: 'Practitioner', id: 'doctor', name: [{ text: 'Dr Test' }], identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] }, { resourceType: 'Location', id: 'clinic', address: { line: ['1 Main St'], city: 'Boston', state: 'MA' } }, { resourceType: 'PractitionerRole', id: 'role', practitioner: { reference: 'Practitioner/doctor' }, location: [{ reference: 'Location/clinic' }] }, { resourceType: 'Encounter', id: 'visit', status: 'finished', period: { start: '2025-02-01' }, participant: [{ individual: { reference: 'PractitionerRole/role' } }] }], 'atrius');
    expect(result.providers[0]).toMatchObject({ name: 'Dr Test', npi: '1234567890', location: '1 Main St, Boston, MA' });
    expect(result.events[0].providerId).toBe(result.providers[0].id);
  });
  it('resolves contained medication details without fetching an arbitrary URL', () => {
    const result = normalizeFhir([{ resourceType: 'MedicationDispense', id: 'fill', status: 'completed', whenHandedOver: '2025-02-01', medicationReference: { reference: '#med' }, quantity: { value: 30 }, contained: [{ resourceType: 'Medication', id: 'med', code: drugCode('12345678901'), form: { text: 'tablet' }, ingredient: [{ strength: { numerator: { value: 10, unit: 'mg' }, denominator: { value: 1, unit: 'tablet' } } }] }] }], 'atrius');
    expect(result.medications[0]).toMatchObject({ ndc: '12345678901', form: 'tablet', strength: '10 mg / 1 tablet' });
  });
});
