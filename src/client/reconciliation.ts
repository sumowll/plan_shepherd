import { buildForecast } from '../domain';
import type { Evidence, ExpectedCareEvent, HistoricalEvent, Medication, ProviderPreference } from '../shared/contracts';

type ImportedRecord = ProviderPreference | Medication;
export interface RecordBaseline<T extends ImportedRecord> { records: T[]; overrides: Record<string, string[]> }
export interface ImportBaseline { providers: RecordBaseline<ProviderPreference>; medications: RecordBaseline<Medication> }
export interface SourceReview { reason: string; latest?: ExpectedCareEvent; details?: string[] }
export const providerFields = ['name', 'npi', 'specialty', 'location'] as const;
export const medicationFields = ['name', 'rxnorm', 'ndc', 'strength', 'form', 'quantity', 'daysSupply'] as const;

/** Three-way merge: a source update never silently replaces a local correction or selection. */
export function mergeRecords<T extends ImportedRecord>(current: T[], incoming: T[], previous: RecordBaseline<T> | undefined, fields: readonly (keyof T)[], selection: keyof T) {
  const records = new Map(current.map(item => [item.id, item]));
  const originals = new Map(previous?.records.map(item => [item.id, item]));
  const overrides = { ...previous?.overrides };
  const changedIds = new Set<string>();
  const changes: Record<string, string[]> = {};
  for (const next of incoming) {
    const local = records.get(next.id); const original = originals.get(next.id);
    if (local) {
      const protectedFields = new Set(overrides[next.id] ?? []);
      for (const field of fields) {
        if (!original || local[field] !== original[field]) protectedFields.add(String(field));
      }
      const merged = { ...local };
      for (const field of fields) if (!protectedFields.has(String(field))) merged[field] = next[field];
      merged[selection] = local[selection];
      merged.evidence = [...new Map([...(local.evidence ?? []), ...(next.evidence ?? [])].map(item => [JSON.stringify(item), item])).values()].slice(-20) as Evidence[];
      overrides[next.id] = [...protectedFields];
      records.set(next.id, merged);
      if (original && fields.some(field => original[field] !== next[field])) {
        changedIds.add(next.id);
        changes[`${selection === 'preferred' ? 'provider' : 'medication'}:${next.id}`] = fields.filter(field => original[field] !== next[field]).map(field => `${next.name}: ${String(field).replace(/([A-Z])/g, ' $1').toLowerCase()} changed from “${original[field] ?? 'not supplied'}” to “${next[field] ?? 'not supplied'}” in the source.`);
      }
    } else records.set(next.id, next);
    originals.set(next.id, next);
  }
  return { records: [...records.values()], baseline: { records: [...originals.values()], overrides }, changedIds, changes };
}

function historyMeaning(event: HistoricalEvent): string {
  // Version/evidence changes alone do not invalidate a user's confirmed scenario.
  const { evidence: _evidence, version: _version, updatedAt: _updatedAt, ...meaning } = event;
  return JSON.stringify(meaning, Object.keys(meaning).sort());
}

export function reconcileForecast(events: ExpectedCareEvent[], previousHistory: HistoricalEvent[], nextHistory: HistoricalEvent[], changedProviders: Set<string>, changedMedications: Set<string>, previousReviews: Record<string, SourceReview>, year: number, recordChanges: Record<string, string[]> = {}) {
  const changedHistory = new Set(previousHistory.filter(old => {
    const next = nextHistory.find(item => item.source === old.source && item.id === old.id);
    return !next || historyMeaning(old) !== historyMeaning(next);
  }).map(item => item.id));
  const drafts = buildForecast(nextHistory, year);
  const nextForecastSources = new Set(drafts.flatMap(event => event.sourceEventIds ?? []));
  // A newly linked claim can suppress an unchanged encounter's forecast. It still
  // invalidates the earlier scenario, just like a corrected historical row.
  for (const draft of buildForecast(previousHistory, year)) {
    for (const id of draft.sourceEventIds ?? []) if (!nextForecastSources.has(id)) changedHistory.add(id);
  }
  const reviews = { ...previousReviews };
  const reconciled = events.map(event => {
    const sourceChanged = event.sourceEventIds?.some(id => changedHistory.has(id));
    const identityChanged = Boolean((event.providerId && changedProviders.has(event.providerId)) || (event.medicationId && changedMedications.has(event.medicationId)));
    if (!sourceChanged && !identityChanged) return event;
    const latest = drafts.filter(draft => draft.sourceEventIds?.some(id => event.sourceEventIds?.includes(id)));
    reviews[event.id] = {
      reason: sourceChanged ? 'The source history changed or was withdrawn. Your current scenario has been kept for review.' : 'The source changed details of a linked provider or prescription. Your corrections and scenario have been kept for review.',
      details: [...new Set([...(previousReviews[event.id]?.details ?? []), ...(recordChanges[`provider:${event.providerId}`] ?? []), ...(recordChanges[`medication:${event.medicationId}`] ?? [])])].slice(-20),
      ...(latest.length === 1 ? { latest: latest[0] } : {}),
    };
    return { ...event, confirmed: false, conditions: [] };
  });
  return { events: reconciled, reviews };
}
