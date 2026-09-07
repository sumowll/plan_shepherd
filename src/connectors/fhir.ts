import type { ClaimSnapshot, Evidence, HistoricalEvent, ImportResult, Medication, ProviderPreference, ServiceCategory } from '../shared/contracts';
import { validDate } from '../domain/primitives';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const positive = (v: unknown): number | undefined => { const n = number(v); return n !== undefined && n > 0 ? n : undefined; };
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const NDC = 'http://hl7.org/fhir/sid/ndc';
const NPI = 'http://hl7.org/fhir/sid/us-npi';
function concept(v: unknown): { label: string; code?: string; rxnorm?: string; ndc?: string } {
  const c = object(v); const codings = list(c.coding).map(object);
  const oneCode = (system: string) => { const codes = [...new Set(codings.filter(x => x.system === system).map(x => str(x.code)).filter(Boolean))]; return codes.length === 1 ? codes[0] : undefined; };
  return { label: str(c.text) || str(codings.find(x => x.display)?.display) || str(codings[0]?.code), code: str(codings[0]?.code) || undefined, rxnorm: oneCode(RXNORM), ndc: oneCode(NDC) };
}
// Monetary JSON numbers are converted through their decimal representation, never value * 100.
export function fhirMoneyCents(v: unknown): number | undefined {
  const m = object(v); const n = number(m.value);
  if (m.currency !== 'USD' || n === undefined || n < 0) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!match) return undefined;
  const fraction = match[2] ?? ''; const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 30) return undefined;
  let amount = BigInt(match[1] + fraction); const scale = fraction.length - exponent - 2;
  if (scale <= 0) amount *= 10n ** BigInt(-scale);
  else { const divisor = 10n ** BigInt(scale); amount = (amount + divisor / 2n) / divisor; }
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : undefined;
}
function humanName(resource: Obj): string {
  if (typeof resource.name === 'string') return resource.name;
  const names = list(resource.name).map(object); const name = names.find(item => item.use === 'official') ?? names[0] ?? {};
  return str(name.text) || [...list(name.given).map(str), str(name.family)].filter(Boolean).join(' ');
}
function category(label: string, pharmacy = false): ServiceCategory {
  if (pharmacy) return 'prescription';
  // These labels only seed an unconfirmed draft category. No billing code is inferred.
  const s = label.toLowerCase();
  if (s.includes('physical therapy') || s.includes('occupational therapy')) return 'therapy';
  if (s.includes('emergency')) return 'emergency';
  if (s.includes('urgent care')) return 'urgent_care';
  if (s.includes('laboratory')) return 'lab';
  if (s.includes('imaging') || s.includes('radiology')) return 'imaging';
  return 'other';
}
function stableId(value: string): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return hash.toString(16);
}
export function resourcesFromPage(page: unknown): Obj[] {
  const data = object(page);
  if (data.resourceType === 'Bundle') return list(data.entry).map((value): Obj => { const entry = object(value); const resource = object(entry.resource); return { ...resource, ...(str(entry.fullUrl) ? { __sourceReference: str(entry.fullUrl) } : {}) }; }).filter(x => typeof x.resourceType === 'string');
  return typeof data.resourceType === 'string' ? [data] : [];
}
export function nextPage(page: unknown): string | undefined { return str(list(object(page).link).map(object).find(x => x.relation === 'next')?.url) || undefined; }
export interface NormalizeFhirOptions { from?: string; to?: string; patientId?: string; fhirBase?: string }
export function normalizeFhir(resources: unknown[], source: string, options: NormalizeFhirOptions = {}): ImportResult {
  if ((options.from && !validDate(options.from)) || (options.to && !validDate(options.to)) || (options.from && options.to && options.from > options.to)) throw new Error('Invalid history date range.');
  const records = resources.map(object); const index = new Map<string, Obj>();
  for (const record of records) if (record.id && record.resourceType) { index.set(`${str(record.resourceType)}/${str(record.id)}`, record); if (str(record.__sourceReference)) index.set(str(record.__sourceReference), record); }
  const providers = new Map<string, ProviderPreference>(); const medications = new Map<string, Medication>();
  const medicationDates = new Map<string, string>();
  const events: HistoricalEvent[] = []; const claimSnapshots: ClaimSnapshot[] = []; const warnings = new Set<string>(); let complete = true; let omissionCount = 0;
  const incomplete = (message: string) => { warnings.add(message); complete = false; omissionCount++; };
  function evidence(record: Obj, text?: string, location?: string): Evidence[] {
    return [{ id: `${source}:${str(record.resourceType)}:${str(record.id)}${location ? `:${location}` : ''}`, source, resourceId: `${str(record.resourceType)}/${str(record.id)}`, date: str(object(record.meta).lastUpdated) || undefined, text: text?.slice(0, 4000), method: 'structured_import', confirmed: false }];
  }
  function resolve(reference: unknown, owner: Obj): Obj | undefined {
    const ref = str(object(reference).reference);
    if (!ref) return undefined;
    if (ref.startsWith('#')) return list(owner.contained).map(object).find(item => item.id === ref.slice(1));
    return index.get(ref);
  }
  function encounterReference(value: unknown, owner: Obj): string | undefined {
    const reference = str(object(value).reference); if (!reference) return undefined;
    const resolved = resolve(value, owner);
    if (resolved?.resourceType === 'Encounter' && str(resolved.id)) return `Encounter/${str(resolved.id)}`;
    const base = options.fhirBase?.replace(/\/$/, '');
    if (base && reference.startsWith(`${base}/Encounter/`) && /^Encounter\/[^/?#]+$/.test(reference.slice(base.length + 1))) return reference.slice(base.length + 1);
    return reference;
  }
  function addressText(address: Obj): string | undefined {
    return [...list(address.line).map(str), str(address.city), str(address.state), str(address.postalCode)].filter(Boolean).join(', ') || undefined;
  }
  function provider(referenceValue: unknown, record: Obj, locationReference?: unknown): string | undefined {
    const reference = object(referenceValue); const key = str(reference.reference); const resolved = resolve(reference, record);
    if (key && !resolved && !reference.identifier) incomplete('Some referenced provider details were not supplied; confirm NPI and service location manually.');
    const practitioner = resolved?.resourceType === 'PractitionerRole' ? resolve(resolved.practitioner, resolved) : resolved;
    const identifiers = [...list(practitioner?.identifier).map(object), object(reference.identifier)];
    const npis = [...new Set(identifiers.filter(x => x.system === NPI).map(x => str(x.value)).filter(x => /^\d{10}$/.test(x)))];
    const npi = npis.length === 1 ? npis[0] : undefined;
    if (npis.length > 1) incomplete('Conflicting provider NPIs require review.');
    const name = str(reference.display) || humanName(practitioner ?? {}) || humanName(resolved ?? {});
    if (!name && !npi) return undefined;
    const roleLocations = list(resolved?.location);
    const location = resolve(locationReference ?? (roleLocations.length === 1 ? roleLocations[0] : undefined), record);
    const addresses = list(practitioner?.address).map(object); const workAddresses = addresses.filter(item => item.use === 'work');
    const address = location ? object(location.address) : workAddresses.length === 1 ? workAddresses[0] : addresses.length === 1 ? addresses[0] : {};
    const locationText = addressText(address);
    const fingerprint = JSON.stringify([npi ? `npi:${npi}` : key || name, locationText]); let id = `${source}:provider:${stableId(fingerprint)}`;
    const current = providers.get(id);
    if (current && (current.npi !== npi || current.location !== locationText)) { incomplete('A provider identity collision requires review.'); id += `:${providers.size}`; }
    providers.set(id, { id, name: name || `Provider ${npi}`, npi, location: locationText, preferred: false, evidence: [...(providers.get(id)?.evidence ?? []), ...evidence(record)].slice(0, 20) });
    return id;
  }
  function daysSupply(value: unknown): number | undefined {
    const duration = object(value); const amount = positive(duration.value); if (amount === undefined) return undefined;
    const unit = str(duration.code || duration.unit).toLowerCase();
    if (!unit || ['d', 'day', 'days'].includes(unit)) return amount;
    if (['wk', 'week', 'weeks'].includes(unit)) return amount * 7;
    if (['h', 'hour', 'hours'].includes(unit)) return amount / 24;
    incomplete('A medication supply duration uses unsupported units and was left unknown.'); return undefined;
  }
  function medication(record: Obj, date: string, drugConcept?: unknown, dispensing?: { quantity?: number; unit?: string; days?: number }): string | undefined {
    const reference = object(record.medicationReference); const resolved = resolve(reference, record);
    const data = concept(drugConcept ?? record.medicationCodeableConcept ?? resolved?.code); const name = data.label || str(reference.display);
    if (!name) { incomplete('A medication reference could not be resolved to a usable identity.'); return undefined; }
    if (reference.reference && !resolved) incomplete('Some medication product details were not supplied; confirm product, strength and formulation manually.');
    const form = concept(resolved?.form).label || undefined;
    const ingredients = list(resolved?.ingredient).map(object); const strengthRatio = ingredients.length === 1 ? object(ingredients[0].strength) : {};
    const numerator = object(strengthRatio.numerator); const denominator = object(strengthRatio.denominator);
    const strength = number(numerator.value) !== undefined && str(numerator.unit) ? `${numerator.value} ${str(numerator.unit)}${number(denominator.value) !== undefined && str(denominator.unit) ? ` / ${denominator.value} ${str(denominator.unit)}` : ''}` : undefined;
    const fingerprint = JSON.stringify([data.ndc ? `ndc:${data.ndc}` : data.rxnorm ? `rxnorm:${data.rxnorm}` : `name:${name}`, strength, form]);
    const id = `${source}:medication:${stableId(fingerprint)}`; const current = medications.get(id);
    const request = object(record.dispenseRequest); const quantityObject = object(record.quantity ?? request.quantity);
    const quantity = dispensing?.quantity ?? positive(quantityObject.value);
    const days = dispensing?.days ?? daysSupply(record.daysSupply ?? request.expectedSupplyDuration);
    const latest = !medicationDates.has(id) || date >= medicationDates.get(id)!;
    const conflict = !!current && date === medicationDates.get(id) && ((current.quantity !== undefined && quantity !== undefined && current.quantity !== quantity) || (current.daysSupply !== undefined && days !== undefined && current.daysSupply !== days));
    if (conflict) incomplete('Multiple same-day dispensing schedules exist for one medication; confirm the intended quantity and supply duration.');
    medications.set(id, { ...current, id, name, rxnorm: data.rxnorm, ndc: data.ndc, strength, form, quantity: conflict ? undefined : latest ? quantity : current?.quantity, daysSupply: conflict ? undefined : latest ? days : current?.daysSupply, ongoing: false, evidence: [...(current?.evidence ?? []), ...evidence(record, name)].slice(0, 20) });
    if (latest) medicationDates.set(id, date);
    return id;
  }
  function serviceDate(raw: unknown, label: string): string | undefined {
    const rawDate = str(raw); const date = rawDate.slice(0, 10);
    if (!validDate(date) || (rawDate.length > 10 && (!rawDate.includes('T') || Number.isNaN(Date.parse(rawDate))))) { incomplete(`${label} without a valid service date was omitted.`); return undefined; }
    if ((options.from && date < options.from) || (options.to && date > options.to)) { warnings.add('Records outside the requested history interval were excluded.'); return undefined; }
    return date;
  }
  const patients = records.filter(record => record.resourceType === 'Patient');
  let patient: ImportResult['patient'];
  const identities = patients.map(record => ({ source, id: str(record.id), name: humanName(record) || undefined, dateOfBirth: validDate(str(record.birthDate)) ? str(record.birthDate) : undefined, evidence: evidence(record) }));
  if (identities.length && new Set(identities.map(item => JSON.stringify([item.id, item.name, item.dateOfBirth]))).size === 1 && (!options.patientId || identities[0].id === options.patientId)) patient = identities[0];
  else if (identities.length) incomplete('Conflicting patient demographics were returned; do not merge this import until identity is resolved.');
  if (options.patientId && !patient) incomplete('The selected patient’s demographics could not be verified from the returned Patient resource.');

  for (const record of records) {
    const type = str(record.resourceType); const rid = str(record.id);
    if (!rid) { incomplete('Some records lack stable source identifiers and were omitted.'); continue; }
    if (options.patientId && ['Encounter', 'MedicationRequest', 'MedicationDispense', 'ExplanationOfBenefit', 'Condition'].includes(type)) {
      const reference = str(object(record.patient ?? record.subject).reference);
      const absolutePatient = options.fhirBase ? `${options.fhirBase.replace(/\/$/, '')}/Patient/${options.patientId}` : undefined;
      if (reference !== `Patient/${options.patientId}` && reference !== absolutePatient) { incomplete('A record without the expected patient binding was omitted.'); continue; }
    }
    const root = `${source}:${type}:${rid}`;
    if (type === 'Encounter') {
      const date = serviceDate(object(record.period).start, 'An encounter'); if (!date) continue;
      const label = concept(list(record.type)[0]).label || 'Recorded encounter';
      const locations = list(record.location).map(object); const location = locations.length === 1 ? locations[0].location : undefined;
      const participantProviders = list(record.participant).map(item => provider(object(item).individual, record, location)).filter((id): id is string => !!id);
      const providerId = new Set(participantProviders).size === 1 ? participantProviders[0] : undefined;
      if (participantProviders.length > 1 && !providerId) warnings.add('An encounter has multiple participating providers; choose the intended provider for anticipated care.');
      events.push({ id: root, source, date, label, category: category(label), kind: 'encounter', status: record.status === 'finished' ? 'completed' : record.status === 'cancelled' || record.status === 'entered-in-error' ? 'cancelled' : 'unknown', quantity: 1, quantityUnit: 'service', encounterId: `Encounter/${rid}`, providerId, version: str(object(record.meta).versionId), updatedAt: str(object(record.meta).lastUpdated), evidence: evidence(record, label) });
    } else if (type === 'MedicationRequest' || type === 'MedicationDispense') {
      const date = serviceDate(type === 'MedicationRequest' ? record.authoredOn : record.whenHandedOver ?? record.whenPrepared, 'A medication record'); if (!date) continue;
      const medicationId = medication(record, date); if (!medicationId) continue; const drug = medications.get(medicationId)!;
      const cancelled = ['cancelled', 'stopped', 'entered-in-error', 'not-done'].includes(str(record.status));
      const quantityData = object(record.quantity ?? object(record.dispenseRequest).quantity);
      const quantity = positive(quantityData.value); const supply = daysSupply(record.daysSupply ?? object(record.dispenseRequest).expectedSupplyDuration);
      const completed = type === 'MedicationDispense' && record.status === 'completed' && !!record.whenHandedOver;
      if (type === 'MedicationDispense' && !quantity) incomplete('A dispense has no valid dispensed quantity; its per-unit drug price remains unknown.');
      events.push({ id: root, source, date, label: drug.name, category: 'prescription', kind: type === 'MedicationDispense' ? 'dispense' : 'prescription_order', status: cancelled ? 'cancelled' : completed ? 'completed' : 'unknown', quantity: 1, quantityUnit: 'fill', dispensedQuantity: quantity, dispensedUnit: str(quantityData.code || quantityData.unit) || undefined, daysSupply: supply, medicationId, providerId: provider(record.requester, record), version: str(object(record.meta).versionId), updatedAt: str(object(record.meta).lastUpdated), evidence: evidence(record, drug.name) });
    } else if (type === 'ExplanationOfBenefit') {
      const firstEvent = events.length; const startingOmissions = omissionCount;
      const claimProvider = provider(record.provider, record, record.facility);
      const claimType = concept(record.type); const pharmacy = claimType.code === 'pharmacy' || claimType.label.toLowerCase() === 'pharmacy';
      const status: HistoricalEvent['status'] = record.status === 'cancelled' || record.status === 'entered-in-error' ? 'cancelled' : record.status === 'active' && record.outcome === 'complete' && record.use === 'claim' ? 'completed' : 'unknown';
      if (record.use !== 'claim') incomplete('An EOB does not confirm a completed claim (it may be a preauthorization or estimate); it is excluded from automatic forecasting.');
      if (record.outcome === 'partial') incomplete('A claim was only partially adjudicated.');
      const careTeam = new Map(list(record.careTeam).map(object).map(member => [number(member.sequence), provider(member.provider, record, record.facility)]));
      function addLine(item: Obj, path: string, inherited: Obj): void {
        const children = list(item.detail ?? item.subDetail).map(object);
        if (children.length) {
          if (list(item.adjudication).length) incomplete('Parent claim totals were not allocated across nested services; individual unknown prices require review.');
          for (const child of children) {
            const sequence = number(child.sequence);
            if (!sequence || !Number.isSafeInteger(sequence)) { incomplete('A nested claim line without a stable sequence was omitted.'); continue; }
            addLine(child, `${path}.${sequence}`, { ...inherited, ...item, detail: undefined, subDetail: undefined });
          }
          return;
        }
        const code = concept(item.productOrService);
        const date = serviceDate(item.servicedDate ?? object(item.servicedPeriod).start ?? inherited.servicedDate ?? object(inherited.servicedPeriod).start ?? object(record.billablePeriod).start, 'A claim line'); if (!date) return;
        if (!item.servicedDate && !object(item.servicedPeriod).start && !inherited.servicedDate && !object(inherited.servicedPeriod).start) warnings.add('A claim line uses the claim billing-period start as an unconfirmed service-date approximation.');
        const adjudications = list(item.adjudication).map(object);
        const amount = (names: string[]): number | undefined => {
          const matching = adjudications.filter(value => list(object(value.category).coding).map(object).some(coding => names.includes(str(coding.code).toLowerCase())));
          if (!matching.length) return undefined;
          const amounts = matching.map(value => fhirMoneyCents(value.amount));
          if (amounts.some(value => value === undefined)) { incomplete('A claim monetary amount has missing/non-USD currency, a negative value, or unsupported precision; it was left unknown.'); return undefined; }
          const distinct = [...new Set(amounts)];
          if (distinct.length !== 1) { incomplete('Conflicting or repeated claim monetary categories require reconciliation; no alias amounts were added together.'); return undefined; }
          return distinct[0];
        };
        const components = [['copay'], ['deductible'], ['coinsurance']].map(amount);
        const knownComponents = components.filter((value): value is number => value !== undefined);
        const patientTotal = knownComponents.length ? knownComponents.reduce((total, value) => total + value, 0) : undefined;
        const quantityData = object(item.quantity); const rawQuantity = positive(quantityData.value);
        if (item.quantity && !rawQuantity) { incomplete('A claim line has an invalid quantity and was retained for review only.'); }
        const quantity = pharmacy ? 1 : rawQuantity ?? 1;
        const medicationId = pharmacy || code.ndc || code.rxnorm ? medication(record, date, item.productOrService, { quantity: rawQuantity, unit: str(quantityData.code || quantityData.unit) }) : undefined;
        if (pharmacy && !rawQuantity) incomplete('A pharmacy claim does not provide a valid dispensed quantity; per-unit pricing remains unknown.');
        const teamIds = list(item.careTeamSequence ?? inherited.careTeamSequence).map(number).map(sequence => careTeam.get(sequence)).filter((id): id is string => !!id);
        const providerId = new Set(teamIds).size === 1 ? teamIds[0] : teamIds.length ? undefined : claimProvider;
        events.push({ id: `${root}:line:${path}`, source, sourceResourceId: `ExplanationOfBenefit/${rid}`, date, label: code.label || 'Claim service', category: category(code.label, pharmacy), kind: pharmacy ? 'dispense' : 'claim', status: item.quantity && !rawQuantity ? 'unknown' : status, providerId, medicationId, serviceCode: code.code, quantity, quantityUnit: pharmacy ? 'fill' : 'service', dispensedQuantity: pharmacy ? rawQuantity : undefined, dispensedUnit: pharmacy ? str(quantityData.code || quantityData.unit) || undefined : undefined, claimId: str(object(record.claim).reference) || root, encounterId: encounterReference(list(item.encounter ?? inherited.encounter)[0], record), allowedCents: amount(['eligible', 'allowed']), billedCents: amount(['submitted']), paidCents: amount(['benefit', 'paid']), patientCents: patientTotal !== undefined && Number.isSafeInteger(patientTotal) ? patientTotal : undefined, version: str(object(record.meta).versionId), updatedAt: str(object(record.meta).lastUpdated), evidence: evidence(record, code.label, `item:${path}`) });
      }
      if (!list(record.item).length) incomplete('A claim has no item-level services; its utilization could not be reconstructed.');
      for (const item of list(record.item).map(object)) {
        const sequence = number(item.sequence);
        if (!sequence || !Number.isSafeInteger(sequence)) { incomplete('A claim line without a stable sequence was omitted.'); continue; }
        addLine(item, String(sequence), {});
      }
      claimSnapshots.push({ source, resourceId: `ExplanationOfBenefit/${rid}`, status, eventIds: events.slice(firstEvent).map(event => event.id), complete: omissionCount === startingOmissions, version: str(object(record.meta).versionId) || undefined, updatedAt: str(object(record.meta).lastUpdated) || undefined });
    }
  }
  warnings.add('Imported history may be incomplete. Categories and anticipated care require review; orders are not proof of dispensing and medicines are not automatically ongoing.');
  return { providers: [...providers.values()], medications: [...medications.values()], events, claimSnapshots, warnings: [...warnings], resourcesRead: records.length, complete, ...(patient ? { patient } : {}) };
}
