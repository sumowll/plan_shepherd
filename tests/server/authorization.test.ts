import { withBundledConnections } from '../helpers/connector-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledConnectionId } from '../helpers/connection-identity';
import app from '../../src/server/index';
import { exchangeCode, getResourcePage, resourceRequestSchema } from '../../src/connectors/transport';
import { signReceipt, verifyReceipt, signReference, verifyReference } from '../../src/connectors/receipt';
import { authorizeReferences, getReferences, referenceTarget } from '../../src/connectors/references';
import { normalizeFhir } from '../../src/connectors/fhir';
import { comparisonSchema } from '../../src/server/validation';

const atriusId = bundledConnectionId('atrius-health-patient-access');
const cignaId = bundledConnectionId('cigna-patient-access');
const secret = 'synthetic-test-signing-key-32-characters';
const base = 'https://provider.example/fhir';
const tokenUrl = 'https://provider.example/token';
const env = withBundledConnections({ APP_ENV: 'development', APP_ORIGIN: 'https://app.example', PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: secret,
  EPIC_CLIENT_ID: 'test-client', CIGNA_PATIENT_ACCESS_CLIENT_ID: 'test-payer',
}, { 'atrius-health': { fhirBaseUrl: base, authorizationUrl: 'https://provider.example/auth', tokenUrl, tokenAuthMethod: 'none', clientSecretEnv: undefined },
  cigna: { fhirBaseUrl: base, tokenAuthMethod: 'none', clientSecretEnv: undefined } });
const token = 'synthetic-access-token';
const patientId = 'p1';
const read = { patientId, resource: 'Encounter' as const, from: '2025-01-01', to: '2025-12-31' };
const patient = { resourceType: 'Patient', id: patientId, birthDate: '1980-02-03' };
const encounter = { resourceType: 'Encounter', id: 'e1', status: 'finished', subject: { reference: 'Patient/p1' }, period: { start: '2025-03-04' }, participant: [{ individual: { reference: 'Practitioner/pr1' } }] };
const bundle = (...resources: unknown[]) => ({ resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })) });
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/fhir+json' } });
function mockTokenResponse(scope: string, expiresIn = 600) {
  const upstream = vi.fn().mockResolvedValue(jsonResponse({ access_token: token, token_type: 'Bearer', patient: patientId, expires_in: expiresIn, scope }));
  vi.stubGlobal('fetch', upstream); return upstream;
}
async function api(path: string, body: unknown, bearer: string | undefined = token) {
  return app.request(`https://app.example${path}`, { method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }, env);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('patient token receipts', () => {
  it('requires UUID identity for new receipts and reference capabilities', async () => {
    await expect(signReceipt(secret, 'atrius-health-patient-access', patientId, token, 600)).rejects.toThrow();
    await expect(signReference(secret, 'atrius-health-patient-access', patientId, token, 'Practitioner/pr1')).rejects.toThrow();
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    await expect(verifyReceipt(secret, receipt, 'atrius-health-patient-access', patientId, token)).rejects.toMatchObject({ code: 'invalid_session' });
  });

  it.each(['launch/patient patient/*.read', 'patient/Patient.r patient/Encounter.rs', 'patient/*.s'])('accepts patient read-only granted scope %s and binds the exchange to its registered callback', async scope => {
    const upstream = mockTokenResponse(scope);
    const result = await exchangeCode(env, 'atrius-health-patient-access', { code: 'one-time-code', verifier: 'v'.repeat(43) }, env.APP_ORIGIN);
    expect(result).toMatchObject({ accessToken: token, patientId, scopes: scope, expiresIn: 600 });
    await expect(verifyReceipt(secret, result.receipt, atriusId, patientId, token)).resolves.toBeUndefined();
    const [url, options] = upstream.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(tokenUrl);
    const sent = new URLSearchParams(String(options.body));
    expect(sent.get('redirect_uri')).toBe('https://app.example/oauth/callback/atrius-health-patient-access');
    expect(sent.get('client_id')).toBe('test-client');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code_verifier')).toBe('v'.repeat(43));
    expect(sent.has('client_secret')).toBe(false);
  });

  it.each(['patient/*.write', 'patient/*.cruds', 'patient/Encounter.u', 'user/*.read', 'system/*.rs', 'patient/*.read offline_access'])('rejects excess granted scope %s', async scope => {
    mockTokenResponse(scope);
    await expect(exchangeCode(env, 'atrius-health-patient-access', { code: 'code', verifier: 'v'.repeat(43) }, env.APP_ORIGIN)).rejects.toMatchObject({ code: 'unsafe_scope' });
  });

  it('prevents changing the token, patient, connector, signing secret, or signed payload', async () => {
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    for (const input of [
      [secret, receipt, atriusId, 'p2', token], [secret, receipt, cignaId, patientId, token],
      [secret, receipt, atriusId, patientId, 'different-token'], ['another-signing-secret-that-is-long-enough', receipt, atriusId, patientId, token],
    ]) await expect(verifyReceipt(...input as [string, string, string, string, string])).rejects.toMatchObject({ code: 'invalid_session' });
    const [payload, signature] = receipt.split('.');
    const changed = JSON.parse(Buffer.from(payload, 'base64url').toString()); changed.patientId = 'p2';
    await expect(verifyReceipt(secret, `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`, atriusId, 'p2', token)).rejects.toMatchObject({ code: 'invalid_session' });
  });

  it('expires at the shorter token lifetime and never permits a receipt beyond 30 minutes', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now); const shortReceipt = await signReceipt(secret, atriusId, patientId, token, 10);
    const longReceipt = await signReceipt(secret, atriusId, patientId, token, 86400);
    vi.mocked(Date.now).mockReturnValue(now + 10001);
    await expect(verifyReceipt(secret, shortReceipt, atriusId, patientId, token)).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(verifyReceipt(secret, longReceipt, atriusId, patientId, token)).resolves.toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(now + 1800001);
    await expect(verifyReceipt(secret, longReceipt, atriusId, patientId, token)).rejects.toMatchObject({ code: 'invalid_session' });
  });
});

describe('authorized resource pages and reference capabilities', () => {
  it('fetches a patient-owned page only after validating its token receipt', async () => {
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    const upstream = vi.fn().mockResolvedValue(jsonResponse(bundle(encounter))); vi.stubGlobal('fetch', upstream);
    expect(await getResourcePage(env, 'atrius-health-patient-access', { ...read, receipt }, token)).toEqual(bundle(encounter));
    const [url, options] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/fhir/Encounter'); expect(url.searchParams.get('patient')).toBe(patientId);
    expect(url.searchParams.getAll('date')).toEqual(['ge2025-01-01', 'le2025-12-31']);
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    upstream.mockClear();
    await expect(getResourcePage(env, 'atrius-health-patient-access', { ...read, receipt, patientId: 'p2' }, token)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { ...encounter, subject: { reference: 'Patient/p2' } },
    { ...encounter, subject: undefined },
    { ...encounter, subject: { reference: 'https://another.example/fhir/Patient/p1' } },
    { resourceType: 'Observation', id: 'unrequested', subject: { reference: 'Patient/p1' } },
  ])('refuses missing, foreign, or unrequested record ownership before returning references', async resource => {
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(bundle(resource))));
    const response = await api('/api/connectors/atrius-health-patient-access/resource', { ...read, receipt });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await response.json() as { error?: unknown }).error).toBeTruthy();
  });

  it('never exposes an arbitrary FHIR read endpoint or authorizes arbitrary embedded references', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    expect(resourceRequestSchema.safeParse({ ...read, receipt, resource: 'Practitioner' }).success).toBe(false);
    const response = await api('/api/connectors/atrius-health-patient-access/resource', { ...read, receipt, resource: 'Observation' });
    expect(response.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
    const page = bundle({ ...encounter, participant: [{ individual: { reference: 'Practitioner/pr1' } }, { individual: { reference: 'Patient/p2' } }, { individual: { reference: 'https://attacker.example/Practitioner/x' } }], arbitrary: { reference: 'Practitioner/unrelated' } });
    const authorized = await authorizeReferences(env, 'atrius-health-patient-access', patientId, token, page);
    expect(authorized.references.map(item => item.reference)).toEqual(['Practitioner/pr1']);
    for (const reference of ['Patient/p2', 'Observation/o1', '../Practitioner/p1', 'Practitioner/pr1/_history/1', 'Practitioner/pr1?foo=bar', 'Practitioner/pr1#part', 'https://attacker.example/fhir/Practitioner/pr1', 'https://user:password@provider.example/fhir/Practitioner/pr1']) expect(referenceTarget(base, reference)).toBeNull();
  });

  it('binds a reference capability to its exact URL, token, patient, connector and expiration', async () => {
    const reference = 'Practitioner/pr1'; const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const capability = await signReference(secret, atriusId, patientId, token, reference);
    await expect(verifyReference(secret, capability, atriusId, patientId, token, reference)).resolves.toBeUndefined();
    for (const [connector, patient, bearer, url] of [
      [cignaId, patientId, token, reference], [atriusId, 'p2', token, reference],
      [atriusId, patientId, 'different-token', reference], [atriusId, patientId, token, 'Practitioner/pr2'],
      [atriusId, patientId, token, `${base}/${reference}`],
    ]) await expect(verifyReference(secret, capability, connector, patient, bearer, url)).rejects.toMatchObject({ code: 'invalid_reference' });
    vi.mocked(Date.now).mockReturnValue(now + 300001);
    await expect(verifyReference(secret, capability, atriusId, patientId, token, reference)).rejects.toMatchObject({ code: 'invalid_reference' });
  });

  it('resolves a referenced practitioner NPI and only follows the approved PractitionerRole hop', async () => {
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    const roleEncounter = { ...encounter, participant: [{ individual: { reference: 'PractitionerRole/role1' } }] };
    const authorized = await authorizeReferences(env, 'atrius-health-patient-access', patientId, token, bundle(roleEncounter));
    const role = { resourceType: 'PractitionerRole', id: 'role1', practitioner: { reference: 'Practitioner/pr1' }, location: [{ reference: 'Location/office1' }], unrelated: { reference: 'Practitioner/other' } };
    const practitioner = { resourceType: 'Practitioner', id: 'pr1', name: [{ family: 'Example', given: ['Alex'] }], identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] };
    const location = { resourceType: 'Location', id: 'office1', name: 'Main clinic', address: { city: 'Boston', state: 'MA' } };
    const upstream = vi.fn(async (url: URL) => jsonResponse(url.pathname.endsWith('/role1') ? role : url.pathname.endsWith('/pr1') ? practitioner : location)); vi.stubGlobal('fetch', upstream);
    const first = await getReferences(env, 'atrius-health-patient-access', { receipt, patientId, references: authorized.references }, token);
    expect(first.references.map(item => item.reference).sort()).toEqual(['Location/office1', 'Practitioner/pr1']);
    const second = await getReferences(env, 'atrius-health-patient-access', { receipt, patientId, references: first.references }, token);
    expect(second.references).toEqual([]); expect(second.incomplete).toBe(false);
    const normalized = normalizeFhir([patient, roleEncounter, ...first.resources, ...second.resources], 'atrius-health', { patientId, fhirBase: base, from: '2025-01-01', to: '2025-12-31' });
    expect(normalized.providers.some(provider => provider.npi === '1234567890')).toBe(true);
    const calls = upstream.mock.calls.map(([url]) => url.pathname).sort();
    expect(calls).toEqual(['/fhir/Location/office1', '/fhir/Practitioner/pr1', '/fhir/PractitionerRole/role1']);
    upstream.mockClear();
    await expect(getReferences(env, 'atrius-health-patient-access', { receipt, patientId, references: [{ ...authorized.references[0], reference: 'Practitioner/other' }] }, token)).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('drops reference responses whose actual resource type or ID does not match their authorized path', async () => {
    const receipt = await signReceipt(secret, atriusId, patientId, token, 600);
    const authorized = await authorizeReferences(env, 'atrius-health-patient-access', patientId, token, bundle(encounter));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ resourceType: 'Practitioner', id: 'another-person' })));
    const result = await getReferences(env, 'atrius-health-patient-access', { receipt, patientId, references: authorized.references }, token);
    expect(result.resources).toEqual([]); expect(result.incomplete).toBe(true);
  });
});

describe('callback and API limits', () => {
  it('requires a bearer token and validates PKCE and connector IDs before any upstream request', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await api('/api/connectors/atrius-health-patient-access/resource', {}, '')).status).toBe(401);
    expect((await api('/api/connectors/atrius-health-patient-access/token', { code: 'x', verifier: 'too-short' })).status).toBe(400);
    expect((await api('/api/connectors/unknown/token', { code: 'x', verifier: 'v'.repeat(43) })).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bounds form callbacks and rejects content types other than URL-encoded form data', async () => {
    const url = 'https://app.example/oauth/callback/atrius-health-patient-access';
    expect((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(415);
    const oversized = await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${'x'.repeat(16001)}` }, env);
    expect(oversized.status).toBe(413); expect(oversized.headers.get('Cache-Control')).toBe('no-store');
  });

  it('escapes callback payloads, fixes the opener target origin and removes query data from history', async () => {
    const code = '</script><script>window.stolen=true</script>';
    const query = new URLSearchParams({ code, state: 'expected-state' });
    const response = await app.request(`https://app.example/oauth/callback/atrius-health-patient-access?${query}`, {}, env);
    const html = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(html).not.toContain(code); expect(html).toContain('\\u003c/script>');
    expect(html).toContain(',"https://app.example")');
    expect(html).toContain("history.replaceState(null,'','/oauth/complete')");
    expect(html).toContain('"state":"expected-state"');
  });

  it('applies rate limits to callbacks as well as API requests', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    for (const path of ['/oauth/callback/atrius-health-patient-access?code=x&state=y', '/api/health']) {
      const response = await app.request(`https://app.example${path}`, { headers: { 'CF-Connecting-IP': '192.0.2.1' } }, { ...env, API_RATE_LIMITER: limiter });
      expect(response.status).toBe(429);
    }
    expect(limiter.limit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(limiter.limit.mock.calls)).not.toContain('192.0.2.1');
  });
});

describe('unambiguous comparison identities', () => {
  const valid = { profile: { dateOfBirth: '1980-01-01', state: 'MA', countyFips: '25017', zip: '02144', householdSize: 1, annualIncomeCents: null, employerOffer: 'unknown', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown', medicarePartA: 'unknown', medicarePartB: 'unknown', tobacco: 'no', coverageStart: '2026-01-01', coverageEnd: '2026-12-31', citizenshipEligible: 'unknown', incarcerated: 'unknown', enrollmentEvent: 'unknown' }, providers: [{ id: 'p1', name: 'Provider', preferred: true }], medications: [{ id: 'm1', name: 'Prescription', ongoing: true }], events: [{ id: 'e1', label: 'Visit', category: 'primary_care', date: '2026-03-01', quantity: 1, unitPriceCents: null, providerId: 'p1', confirmed: true }], planIds: ['plan1'], releaseId: 'release1' };
  it('accepts distinct confirmed records with existing references', () => expect(comparisonSchema.safeParse(valid).success).toBe(true));
  it.each(['providers', 'medications', 'events'] as const)('rejects duplicate %s IDs', key => expect(comparisonSchema.safeParse({ ...valid, [key]: [...valid[key], valid[key][0]] }).success).toBe(false));
  it.each(['providerId', 'medicationId'] as const)('rejects a dangling %s instead of silently changing the calculation input', key => expect(comparisonSchema.safeParse({ ...valid, events: [{ ...valid.events[0], [key]: 'missing' }] }).success).toBe(false));
});
