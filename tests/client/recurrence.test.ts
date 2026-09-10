import { describe, expect, it } from 'vitest';
import { createRepeatedCare, previewCareDates, type CareRecurrence } from '../../src/client/recurrence';
import type { ExpectedCareEvent } from '../../src/shared/contracts';

const schedule: CareRecurrence = { startDate: '2026-01-31', endDate: '2026-12-31', coverageStart: '2026-01-01', coverageEnd: '2026-12-31', frequency: 'monthly' };

describe('repeated care dates', () => {
  it('uses the original monthly date after a shorter month and excludes the original', () => {
    expect(previewCareDates({ ...schedule, endDate: '2026-05-31' })).toEqual({ dates: ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'] });
  });

  it('includes leap day and preserves a leap-day start when crossing years', () => {
    expect(previewCareDates({ ...schedule, startDate: '2028-01-31', endDate: '2028-03-31', coverageStart: '2028-01-01', coverageEnd: '2028-12-31' }).dates).toEqual(['2028-02-29', '2028-03-31']);
    const dates = previewCareDates({ ...schedule, startDate: '2028-02-29', endDate: '2029-03-29', coverageStart: '2028-01-01', coverageEnd: '2029-12-31' }).dates;
    expect(dates.slice(-3)).toEqual(['2029-01-29', '2029-02-28', '2029-03-29']);
  });

  it('repeats weekly and by days on exact UTC calendar dates, including the last allowed date', () => {
    expect(previewCareDates({ ...schedule, startDate: '2026-03-01', endDate: '2026-03-22', frequency: 'weekly' }).dates).toEqual(['2026-03-08', '2026-03-15', '2026-03-22']);
    expect(previewCareDates({ ...schedule, startDate: '2026-11-01', endDate: '2026-12-31', frequency: 'every_n_days', intervalDays: 30 }).dates).toEqual(['2026-12-01', '2026-12-31']);
  });

  it.each([
    { startDate: '2026-02-30' }, { startDate: '' }, { coverageStart: 'bad' },
    { coverageStart: '2026-12-31', coverageEnd: '2026-01-01' },
    { startDate: '2025-12-31' }, { startDate: '2027-01-01' },
    { endDate: '2027-01-01' }, { endDate: '2026-01-31' }, { endDate: '2026-01-30' },
    { endDate: '2026-02-01' }, { endDate: 'invalid' },
    { frequency: 'every_n_days' as const, intervalDays: 0 },
    { frequency: 'every_n_days' as const, intervalDays: 1.5 },
    { frequency: 'every_n_days' as const, intervalDays: Number.NaN },
    { frequency: 'every_n_days' as const, intervalDays: 367 },
    { frequency: 'every_n_days' as const, intervalDays: undefined },
  ])('rejects invalid or out-of-coverage recurrence: %j', invalid => {
    const result = previewCareDates({ ...schedule, ...invalid });
    expect(result.error).toBeTruthy();
    expect(result.dates).toEqual([]);
  });

  it('allows 366 new items but rejects a longer schedule without silently truncating it', () => {
    const daily: CareRecurrence = { ...schedule, startDate: '2028-01-01', endDate: '2029-01-01', coverageStart: '2028-01-01', coverageEnd: '2029-12-31', frequency: 'every_n_days', intervalDays: 1 };
    expect(previewCareDates(daily).dates).toHaveLength(366);
    expect(previewCareDates({ ...daily, endDate: '2029-01-02' })).toEqual({ dates: [], error: expect.stringContaining('more than 366') });
  });
});

describe('repeated care scenarios', () => {
  const original: ExpectedCareEvent = { id: 'original', label: 'Monthly refill', category: 'prescription', date: '2026-01-31', quantity: 1, quantityUnit: 'fill', dispensedQuantity: 30, dispensedUnit: 'tablet', daysSupply: 30, medicationId: 'medication', providerId: 'provider', unitPriceCents: null, confirmed: true, sourceEventIds: ['historical-fill'], conditions: [{ conditionId: 'old-approval', status: 'satisfied' }] };

  it('creates separate unconfirmed fills without duplicating historical source IDs or approvals', () => {
    let id = 0;
    const repeated = createRepeatedCare(original, ['2026-02-28', '2026-03-31'], () => `repeat-${++id}`);
    expect(repeated.map(item => item.id)).toEqual(['repeat-1', 'repeat-2']);
    expect(repeated.map(item => item.date)).toEqual(['2026-02-28', '2026-03-31']);
    for (const item of repeated) {
      expect(item).toMatchObject({ confirmed: false, quantity: 1, quantityUnit: 'fill', dispensedQuantity: 30, dispensedUnit: 'tablet', daysSupply: 30, medicationId: 'medication', providerId: 'provider', unitPriceCents: null });
      expect(item.sourceEventIds).toBeUndefined();
      expect(item.conditions).toBeUndefined();
    }
    expect(original.confirmed).toBe(true);
    expect(original.sourceEventIds).toEqual(['historical-fill']);
    expect(original.conditions).toHaveLength(1);
  });

  it('rejects original, duplicate, impossible and excessive repeat dates', () => {
    for (const dates of [['2026-01-31'], ['2026-02-30'], ['2026-02-28', '2026-02-28'], Array.from({ length: 367 }, () => '2026-02-28')]) {
      expect(() => createRepeatedCare(original, dates)).toThrow(RangeError);
    }
  });

  it('treats a price copied from past care as an estimate for the new dates', () => {
    const historical = { ...original, unitPriceCents: 12500, priceBasis: 'historical' as const, priceType: 'allowed' as const };
    expect(createRepeatedCare(historical, ['2026-02-28'])[0]).toMatchObject({ unitPriceCents: 12500, priceBasis: 'user_estimate', priceType: 'allowed', confirmed: false });
    expect(historical.priceBasis).toBe('historical');
  });
});
