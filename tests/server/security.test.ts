import { withBundledConnections } from '../helpers/connector-env';
import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../../src/server/index';
import { allowedResourceUrl, exchangeCode } from '../../src/connectors/transport';
import { boundedJson } from '../../src/server/http';
import { validateProposals, runAssistant } from '../../src/server/assistant';
import { comparisonSchema } from '../../src/server/validation';
import { connectorConfig } from '../../src/server/config';

afterEach(() => vi.unstubAllGlobals());
describe('patient processing boundaries', () => {
  it('rejects a foreign-origin API request before processing any data', async () => {
    const response = await app.request('http://localhost/api/assistant', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' }, { APP_ENV: 'development', APP_ORIGIN: 'http://localhost' });
    expect(response.status).toBe(403); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('fails closed when no AI retention configuration is present', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(runAssistant({}, { messages: [{ role: 'user', content: 'private text' }], evidence: [] })).rejects.toMatchObject({ code: 'ai_not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects resource pages that exfiltrate a bearer token or change patient', () => {
    const input = { patientId: 'p1', resource: 'Encounter' as const, from: '2025-01-01', to: '2025-12-31' };
    for (const next of ['https://attacker.example/Encounter', 'https://provider.example/other/Encounter', 'https://provider.example/fhir/Encounter?patient=p2', 'https://provider.example/fhir/Patient/p2', 'https://user:password@provider.example/fhir/Encounter']) {
      expect(() => allowedResourceUrl('https://provider.example/fhir', { ...input, next })).toThrow();
    }
    expect(allowedResourceUrl('https://provider.example/fhir', { ...input, next: 'https://provider.example/fhir/Encounter?patient=p1&page=2' }).searchParams.get('patient')).toBe('p1');
  });
  it('does not permit offline access or a write scope', () => {
    expect(() => connectorConfig(withBundledConnections({}, { 'atrius-health': { scopes: 'offline_access patient/*.read' } }), 'atrius-health-patient-access')).toThrow();
    expect(() => connectorConfig(withBundledConnections({}, { 'atrius-health': { scopes: 'patient/*.write' } }), 'atrius-health-patient-access')).toThrow();
  });
  it('rejects oversized payloads even without content-length', async () => {
    await expect(boundedJson(new Response(JSON.stringify({ data: 'x'.repeat(300) })), 100)).rejects.toMatchObject({ code: 'payload_too_large' });
  });
  it('refuses to infer a patient identity from an unverified ID token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access', token_type: 'Bearer', id_token: 'unverified' }))));
    await expect(exchangeCode(withBundledConnections({ PATIENT_PROCESSING_APPROVED: 'true', SESSION_SIGNING_KEY: 's'.repeat(32), EPIC_CLIENT_ID: 'test' }, { 'atrius-health': { authorizationUrl: 'https://provider.example/auth', tokenUrl: 'https://provider.example/token', tokenAuthMethod: 'none', clientSecretEnv: undefined } }), 'atrius-health-patient-access', { code: 'code', verifier: 'v'.repeat(43) }, 'https://app.example')).rejects.toMatchObject({ code: 'missing_patient_context' });
  });
  it('never accepts an AI proposal with an invented evidence identifier', () => {
    const result = validateProposals({ topic: 'providers', proposals: [{ kind: 'provider', name: 'Doctor', category: null, date: null, quantity: null, strength: null, form: null, location: null, evidenceIds: ['invented'] }] }, new Map([['real', {text: 'Therapy', method: 'structured_import'}]]));
    expect(result).toEqual([]);
  });
  it('does not create expected-care proposals with inferred missing dates', () => {
    const result = validateProposals({ topic: 'expected_care', proposals: [{ kind: 'expected_care', name: 'Therapy', category: 'therapy', date: null, quantity: 12, strength: null, form: null, location: null, evidenceIds: ['real'] }] }, new Map([['real', {text: 'Therapy', method: 'structured_import'}]]));
    expect(result).toEqual([]);
  });
  it('sets store:false and exposes no tools to the model', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => {
      sent = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ topic: 'deductible', proposals: [] }) }] }] }));
    }));
    const reply = await runAssistant({ AI_PROCESSING_APPROVED: 'true', AI_RETENTION_VERIFIED: 'true', AI_API_KEY: 'synthetic-key', AI_MODEL: 'configured-test-model' }, { messages: [{ role: 'user', content: 'What is a deductible?' }], evidence: [] });
    expect(sent.store).toBe(false); expect(sent.background).toBe(false); expect(sent.tools).toBeUndefined(); expect(sent.conversation).toBeUndefined(); expect(reply.message).toContain('deductible');
  });
  it('rejects a comparison without a pinned catalog release', () => { expect(comparisonSchema.safeParse({ planIds: ['x'] }).success).toBe(false); });
});
