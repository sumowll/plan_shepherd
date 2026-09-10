import { validDate } from '../domain/primitives';
import type { ExpectedCareEvent } from '../shared/contracts';

export type CareFrequency = 'weekly' | 'monthly' | 'every_n_days';
export interface CareRecurrence {
  startDate: string;
  endDate: string;
  coverageStart: string;
  coverageEnd: string;
  frequency: CareFrequency;
  intervalDays?: number;
}
export interface RecurrencePreview { dates: string[]; error?: string }
export const MAX_REPEATED_CARE = 366;

/** Dates describe additional items only: the existing care item is the first occurrence. */
export function previewCareDates(options: CareRecurrence): RecurrencePreview {
  const { startDate, endDate, coverageStart, coverageEnd, frequency, intervalDays } = options;
  const invalid = (error: string): RecurrencePreview => ({ dates: [], error });
  if (!validDate(coverageStart) || !validDate(coverageEnd) || coverageStart > coverageEnd) return invalid('Enter valid coverage start and end dates in Your coverage first.');
  if (!validDate(startDate)) return invalid('Enter a valid expected date for this care first.');
  if (startDate < coverageStart || startDate > coverageEnd) return invalid('The expected date must fall within your coverage dates.');
  if (!validDate(endDate)) return invalid('Choose a valid last date for repeats.');
  if (endDate <= startDate) return invalid('Choose a last date later than this care item’s expected date.');
  if (endDate > coverageEnd) return invalid('The last date for repeats must be on or before your coverage end date.');
  if (!['weekly', 'monthly', 'every_n_days'].includes(frequency)) return invalid('Choose how often this care repeats.');
  if (frequency === 'every_n_days' && (!Number.isInteger(intervalDays) || intervalDays! < 1 || intervalDays! > 366)) return invalid('Enter a whole number from 1 to 366 for days between visits or fills.');

  const anchor = new Date(`${startDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let occurrence = 1; occurrence <= MAX_REPEATED_CARE + 1; occurrence += 1) {
    const next = new Date(anchor);
    if (frequency === 'monthly') {
      // Advance from the original month/day to avoid drifting after February.
      next.setUTCDate(1);
      next.setUTCMonth(anchor.getUTCMonth() + occurrence);
      const endOfMonth = new Date(next);
      endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
      next.setUTCDate(Math.min(anchor.getUTCDate(), endOfMonth.getUTCDate()));
    } else {
      next.setUTCDate(anchor.getUTCDate() + occurrence * (frequency === 'weekly' ? 7 : intervalDays!));
    }
    if (next.getTime() > Date.parse(`${endDate}T00:00:00Z`)) break;
    if (dates.length === MAX_REPEATED_CARE) return invalid('This would add more than 366 care items. Choose an earlier last date or repeat less often.');
    dates.push(next.toISOString().slice(0, 10));
  }
  if (!dates.length) return invalid('No repeats fit before that last date. Choose a later date or repeat more often.');
  return { dates };
}

/** A repeated plan is a new scenario, not another copy of a historical record or its approvals. */
export function createRepeatedCare(item: ExpectedCareEvent, dates: readonly string[], newId: () => string = () => crypto.randomUUID()): ExpectedCareEvent[] {
  if (dates.length > MAX_REPEATED_CARE) throw new RangeError('At most 366 repeated care items can be added at once.');
  if (new Set(dates).size !== dates.length || dates.some(date => !validDate(date) || date <= item.date)) throw new RangeError('Repeat dates must be unique valid dates after the original care item.');
  const { id: _id, sourceEventIds: _sources, conditions: _conditions, ...details } = item;
  return dates.map(date => ({ ...details, ...(item.unitPriceCents != null ? { priceBasis: 'user_estimate' as const } : {}), id: newId(), date, confirmed: false }));
}
