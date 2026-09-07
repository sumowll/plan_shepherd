import type { ClaimSnapshot, ExpectedCareEvent, HistoricalEvent } from '../shared/contracts';
import { validDate } from './primitives';

const evidenceUnion = (events: HistoricalEvent[]) => [...new Map(events.flatMap(event => event.evidence).map(item => [JSON.stringify(item), { ...item }])).values()];
function compareVersion(a: Pick<HistoricalEvent, 'version' | 'updatedAt'>, b: Pick<HistoricalEvent, 'version' | 'updatedAt'>): number {
  if (a.updatedAt && b.updatedAt && Number.isFinite(Date.parse(a.updatedAt)) && Number.isFinite(Date.parse(b.updatedAt))) {
    const difference = Date.parse(a.updatedAt) - Date.parse(b.updatedAt); if (difference !== 0) return difference;
  }
  if (/^\d+$/.test(a.version ?? '') && /^\d+$/.test(b.version ?? '')) {
    const left = BigInt(a.version!); const right = BigInt(b.version!); return left === right ? 0 : left < right ? -1 : 1;
  }
  return 0;
}
export function normalizeHistory(events: HistoricalEvent[], snapshots: ClaimSnapshot[] = []): HistoricalEvent[] {
  const groups = new Map<string, HistoricalEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.source, event.id]);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const normalized = [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => compareVersion(b, a) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const latest = sorted[0];
    const peers = sorted.filter(event => compareVersion(event, latest) === 0);
    const shape = (event: HistoricalEvent) => JSON.stringify({ ...event, evidence: [], updatedAt: undefined, version: undefined });
    const conflict = new Set(peers.map(shape)).size > 1;
    return { ...latest, evidence: evidenceUnion(group), ...(conflict ? { status: 'unknown' as const, label: `${latest.label} (conflicting source versions; review required)` } : {}) };
  });
  const snapshotGroups = new Map<string, ClaimSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = JSON.stringify([snapshot.source, snapshot.resourceId]);
    snapshotGroups.set(key, [...(snapshotGroups.get(key) ?? []), snapshot]);
  }
  const reconciled = normalized.map(event => {
    const group = event.sourceResourceId ? snapshotGroups.get(JSON.stringify([event.source, event.sourceResourceId])) : undefined;
    if (!group?.length) return event;
    const latest = [...group].sort((a, b) => compareVersion(b, a) || JSON.stringify(a).localeCompare(JSON.stringify(b)))[0];
    const order = compareVersion(latest, event);
    if (order < 0) return event;
    const peers = group.filter(snapshot => compareVersion(snapshot, latest) === 0);
    const conflict = new Set(peers.map(snapshot => JSON.stringify([snapshot.status, snapshot.complete, [...snapshot.eventIds].sort()]))).size > 1;
    if (!conflict && latest.status !== 'cancelled' && latest.eventIds.includes(event.id)) return event;
    if (order === 0 && event.status !== 'completed') return event;
    const cancelled = order > 0 && !conflict && (latest.status === 'cancelled' || (latest.status === 'completed' && latest.complete));
    return { ...event, status: cancelled ? 'cancelled' as const : 'unknown' as const, version: latest.version ?? event.version, updatedAt: latest.updatedAt ?? event.updatedAt, label: `${event.label} (${cancelled ? 'removed or cancelled by a newer claim version' : 'claim source changed; latest service details require review'})` };
  });
  const replaced = new Set(reconciled.filter(event => event.replacesId).map(event => JSON.stringify([event.source, event.replacesId])));
  return reconciled.map(event => replaced.has(JSON.stringify([event.source, event.id])) ? { ...event, status: 'cancelled' as const } : event)
    .sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
export function buildForecast(events: HistoricalEvent[], year: number): ExpectedCareEvent[] {
  if (!Number.isInteger(year) || year < 1901 || year > 9998) return [];
  const active = normalizeHistory(events).filter(event => event.status === 'completed' && validDate(event.date) && Number(event.date.slice(0, 4)) === year - 1 && event.quantity > 0 && Number.isFinite(event.quantity));
  const linkedClaims = active.filter(event => event.kind === 'claim' && event.encounterId);
  return active.filter(event => event.kind !== 'prescription_order')
    .filter(event => event.kind !== 'encounter' || !linkedClaims.some(claim => claim.encounterId === (event.encounterId ?? event.id) && (claim.source === event.source || /^https:\/\//.test(claim.encounterId!)) && (!event.providerId || !claim.providerId || event.providerId === claim.providerId)))
    .map(event => {
      const desiredDate = `${year}${event.date.slice(4)}`;
      const date = validDate(desiredDate) ? desiredDate : `${year}-02-28`;
      const unit = event.allowedCents === undefined ? null : event.allowedCents / event.quantity;
      const possibleOverlap = event.kind === 'encounter' && active.some(other => other.kind === 'claim' && other.date === event.date && other.category === event.category);
      return { id: `forecast:${encodeURIComponent(event.source)}:${encodeURIComponent(event.id)}:${year}`, label: `${event.label}${possibleOverlap ? ' (possible overlap with a claim; review before confirming)' : ''}`, category: event.category, date, quantity: event.quantity, quantityUnit: event.quantityUnit, dispensedQuantity: event.dispensedQuantity, dispensedUnit: event.dispensedUnit, daysSupply: event.daysSupply, providerId: event.providerId, medicationId: event.medicationId, serviceCode: event.serviceCode, unitPriceCents: unit !== null && Number.isSafeInteger(unit) && unit >= 0 ? unit : null, priceBasis: 'historical' as const, priceType: 'allowed' as const, confirmed: false, sourceEventIds: [event.id] };
    });
}
