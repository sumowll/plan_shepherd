import { describe, expect, it } from 'vitest';
import { buildForecast, normalizeHistory } from '../../src/domain';
import { mergeRecords, medicationFields, providerFields, reconcileForecast } from '../../src/client/reconciliation';
import type { HistoricalEvent, Medication, ProviderPreference } from '../../src/shared/contracts';

const provider: ProviderPreference = { id: 'p', name: 'Source clinician', npi: '1234567890', location: 'Original clinic', preferred: false };
const medication: Medication = { id: 'm', name: 'Source medication', rxnorm: '123', strength: '10 mg', quantity: 30, ongoing: false };
const claim: HistoricalEvent = { id: 'claim-line', sourceResourceId: 'eob-1', source: 'atrius', date: '2025-03-01', category: 'outpatient', label: 'Claimed service', kind: 'claim', status: 'completed', providerId: 'p', quantity: 1, allowedCents: 10000, version: '1', evidence: [] };
const confirmed = () => ({ ...buildForecast([claim], 2026)[0], label: 'My revised scenario', date: '2026-09-03', confirmed: true, conditions: [{ conditionId: 'authorization', status: 'satisfied' as const, evidence: [] }] });

describe('session import reconciliation', () => {
  it('keeps explicit provider corrections and selections as source fields change, including when source catches up with a correction', () => {
    const first = mergeRecords([], [provider], undefined, providerFields, 'preferred');
    const second = mergeRecords([{ ...provider, location: 'My clinic', preferred: true }], [{ ...provider, specialty: 'Primary care' }], first.baseline, providerFields, 'preferred');
    expect(second.records[0]).toMatchObject({ location: 'My clinic', preferred: true, specialty: 'Primary care' });
    expect(second.changedIds.has('p')).toBe(true);
    const third = mergeRecords(second.records, [{ ...provider, location: 'My clinic' }], second.baseline, providerFields, 'preferred');
    const fourth = mergeRecords(third.records, [{ ...provider, location: 'Another source clinic' }], third.baseline, providerFields, 'preferred');
    expect(fourth.records[0]).toMatchObject({ location: 'My clinic', preferred: true });
    expect(fourth.changedIds.has('p')).toBe(true);
  });

  it('keeps medication corrections and ongoing choices, while accepting untouched source fields', () => {
    const first = mergeRecords([], [medication], undefined, medicationFields, 'ongoing');
    const next = mergeRecords([{ ...medication, rxnorm: '456', strength: '20 mg', ongoing: true }], [{ ...medication, quantity: 90 }], first.baseline, medicationFields, 'ongoing');
    expect(next.records[0]).toMatchObject({ rxnorm: '456', strength: '20 mg', ongoing: true, quantity: 90 });
    expect(next.changedIds.has('m')).toBe(true);
    expect(mergeRecords(next.records, [], next.baseline, medicationFields, 'ongoing').records).toEqual(next.records);
  });

  it('keeps scenario edits but clears confirmation and conditions after source meaning changes', () => {
    const next = { ...claim, allowedCents: 50000, version: '2' };
    const result = reconcileForecast([confirmed()], [claim], [next], new Set(), new Set(), {}, 2026);
    expect(result.events[0]).toMatchObject({ label: 'My revised scenario', date: '2026-09-03', unitPriceCents: 10000, confirmed: false, conditions: [] });
    expect(result.reviews[confirmed().id].latest).toMatchObject({ date: '2026-03-01', unitPriceCents: 50000 });
  });

  it('invalidates care linked to a changed provider or medication even when its historical claim is unchanged', () => {
    const providerChanged = reconcileForecast([confirmed()], [claim], [claim], new Set(['p']), new Set(), {}, 2026);
    expect(providerChanged.events[0].confirmed).toBe(false);
    const medicineChanged = reconcileForecast([{ ...confirmed(), medicationId: 'm' }], [claim], [claim], new Set(), new Set(['m']), {}, 2026);
    expect(medicineChanged.events[0].conditions).toEqual([]);
    expect(Object.keys(medicineChanged.reviews)).toHaveLength(1);
  });

  it('does not invalidate unchanged reimports or a version-only update', () => {
    const result = reconcileForecast([confirmed()], [claim], [{ ...claim, version: '2', updatedAt: '2026-01-01T00:00:00Z' }], new Set(), new Set(), {}, 2026);
    expect(result.events[0]).toEqual(confirmed()); expect(result.reviews).toEqual({});
  });

  it('marks an explicitly removed claim line for review without inferring deletion from an empty import', () => {
    const emptyImport = normalizeHistory([claim], []);
    expect(reconcileForecast([confirmed()], [claim], emptyImport, new Set(), new Set(), {}, 2026).events[0].confirmed).toBe(true);
    const tombstone = normalizeHistory([claim], [{ source: 'atrius', resourceId: 'eob-1', status: 'completed', eventIds: [], complete: true, version: '2' }]);
    const result = reconcileForecast([confirmed()], [claim], tombstone, new Set(), new Set(), {}, 2026);
    expect(result.events[0].confirmed).toBe(false); expect(result.events[0].label).toBe('My revised scenario');
    expect(result.reviews[confirmed().id].latest).toBeUndefined();
  });

  it('invalidates an unchanged encounter scenario when a newly linked claim replaces its forecast', () => {
    const encounter: HistoricalEvent = { ...claim, id: 'encounter-1', kind: 'encounter', encounterId: 'encounter-1' };
    const linkedClaim = { ...claim, encounterId: 'encounter-1' };
    const event = { ...buildForecast([encounter], 2026)[0], confirmed: true, label: 'My manual visit plan' };
    const result = reconcileForecast([event], [encounter], [encounter, linkedClaim], new Set(), new Set(), {}, 2026);
    expect(result.events[0]).toMatchObject({ confirmed: false, label: 'My manual visit plan' });
    expect(result.reviews[event.id]).toBeDefined();
    expect(buildForecast([encounter, linkedClaim], 2026).map(item => item.sourceEventIds)).toEqual([['claim-line']]);
  });
});
