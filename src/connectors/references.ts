import { z } from 'zod';
import { connectorConfig, setting, type ConnectorId } from '../server/config';
import { AppError, boundedJson, safeFetch } from '../server/http';
import { signReference, verifyReceipt, verifyReference } from './receipt';

type Row = Record<string, any>;
const types = ['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication'];
export interface AuthorizedReference { reference: string; capability: string }
export function referenceTarget(base: string, reference: string): URL | null {
  try {
    const root = new URL(`${base.replace(/\/$/, '')}/`); const target = new URL(reference, root);
    if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.search || target.hash || target.username || target.password) return null;
    const path = target.pathname.slice(root.pathname.length).split('/');
    return path.length === 2 && types.includes(path[0]) && /^[A-Za-z0-9.-]{1,250}$/.test(path[1]) ? target : null;
  } catch { return null; }
}
function references(row: Row): string[] {
  let candidates: unknown[] = [];
  if (row.resourceType === 'Encounter') candidates = [...(row.participant ?? []).map((x: Row) => x.individual), ...(row.location ?? []).map((x: Row) => x.location)];
  if (row.resourceType === 'ExplanationOfBenefit') candidates = [row.provider, row.facility, ...(row.careTeam ?? []).map((x: Row) => x.provider)];
  if (row.resourceType === 'MedicationRequest') candidates = [row.medicationReference, row.requester];
  if (row.resourceType === 'MedicationDispense') candidates = [row.medicationReference];
  if (row.resourceType === 'PractitionerRole') candidates = [row.practitioner, ...(row.location ?? [])];
  return candidates.flatMap(x => x && typeof x === 'object' && typeof (x as Row).reference === 'string' ? [(x as Row).reference] : []);
}
export async function authorizeReferences(env: Record<string, unknown>, id: ConnectorId, patientId: string, token: string, page: unknown): Promise<{ references: AuthorizedReference[]; referenceLimitReached: boolean }> {
  const base = connectorConfig(env, id).base; const row = page as Row;
  const rows: Row[] = row?.resourceType === 'Bundle' && Array.isArray(row.entry) ? row.entry.flatMap((x: Row) => x?.resource ? [x.resource] : []) : [row];
  const refs = [...new Set(rows.filter(Boolean).flatMap(references).filter(ref => referenceTarget(base, ref)))];
  return { references: await Promise.all(refs.slice(0, 250).map(async reference => ({ reference, capability: await signReference(setting(env, 'SESSION_SIGNING_KEY'), id, patientId, token, reference) }))), referenceLimitReached: refs.length > 250 };
}
export const referenceRequestSchema = z.object({ receipt: z.string().min(1).max(4096), patientId: z.string().regex(/^[A-Za-z0-9.-]{1,250}$/), references: z.array(z.object({ reference: z.string().max(2000), capability: z.string().max(8000) })).min(1).max(10) });
export async function getReferences(env: Record<string, unknown>, id: ConnectorId, input: z.infer<typeof referenceRequestSchema>, token: string) {
  const config = connectorConfig(env, id);
  if (!config.enabled) throw new AppError('connector_not_configured', 'This connection is not enabled.', 503);
  await verifyReceipt(setting(env, 'SESSION_SIGNING_KEY'), input.receipt, id, input.patientId, token);
  const resources: unknown[] = []; const additional: AuthorizedReference[] = []; let incomplete = false;
  // Two at a time bounds upstream connections and transient response memory.
  for (let i = 0; i < input.references.length; i += 2) {
    await Promise.all(input.references.slice(i, i + 2).map(async item => {
      await verifyReference(setting(env, 'SESSION_SIGNING_KEY'), item.capability, id, input.patientId, token, item.reference);
      const target = referenceTarget(config.base, item.reference);
      if (!target) throw new AppError('invalid_reference', 'The imported reference is not supported.', 400);
      try {
        const response = await safeFetch(target, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' } });
        if (!response.ok) { incomplete = true; return; }
        const resource = await boundedJson(response, 512000) as Row;
        if (resource.resourceType !== target.pathname.split('/').at(-2) || resource.id !== target.pathname.split('/').at(-1)) { incomplete = true; return; }
        resources.push({ ...resource, __sourceReference: item.reference });
        if (resource.resourceType === 'PractitionerRole') additional.push(...(await authorizeReferences(env, id, input.patientId, token, resource)).references);
      } catch { incomplete = true; }
    }));
  }
  return { resources, references: additional, incomplete };
}
