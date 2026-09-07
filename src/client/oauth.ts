import type { ImportResult } from '../shared/contracts';
import { normalizeFhir, resourcesFromPage, nextPage } from '../connectors/fhir';
import { clearSession, sessionController, releaseController, sessionGeneration } from './privacy';

const pending = new Set<() => void>();
export function resetPatientSession(): void { for (const cancel of pending) cancel(); pending.clear(); clearSession(); }
function random(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function challenge(verifier: string): Promise<string> { return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function json<T>(response: Response): Promise<T> {
  const payload = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || 'The connection could not be completed.');
  return payload as T;
}
export async function connectPatient(id: 'atrius' | 'cigna'): Promise<ImportResult> {
  const popup = window.open('about:blank', `connect-${id}`, 'popup,width=550,height=720');
  if (!popup) throw new Error('Allow the secure sign-in window, then try connecting again.');
  const generation = sessionGeneration(); const controller = sessionController();
  const stop = () => { controller.abort(); popup.close(); };
  pending.add(stop); window.addEventListener('plan-shepherd:clear-session', stop);
  try {
    const config = await json<{ authorizationUrl: string; clientId: string; scopes: string; audience: string; responseMode: string }>(await fetch(`/api/connectors/${id}/authorize`, { signal: controller.signal, cache: 'no-store' }));
    const state = random(); const verifier = random(); const codeChallenge = await challenge(verifier);
    const codePromise = new Promise<string>((resolve, reject) => {
      const cleanup = () => { window.removeEventListener('message', onMessage); controller.signal.removeEventListener('abort', onAbort); window.clearInterval(poll); window.clearTimeout(timeout); };
      const onAbort = () => { cleanup(); reject(new Error('The session was cleared.')); };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== popup) return;
        const data = event.data as Record<string, unknown> | null;
        if (!data || data.type !== 'plan-shepherd:oauth' || data.connector !== id) return;
        if (data.state !== state) { cleanup(); reject(new Error('The sign-in response did not match this session.')); return; }
        cleanup(); popup.close();
        if (data.error || typeof data.code !== 'string') reject(new Error('Sign-in was not completed. Please try again.')); else resolve(data.code);
      };
      const poll = window.setInterval(() => { if (popup.closed) { cleanup(); reject(new Error('The sign-in window was closed.')); } }, 500);
      const timeout = window.setTimeout(() => { cleanup(); popup.close(); reject(new Error('Sign-in timed out. Please connect again.')); }, 5 * 60_000);
      window.addEventListener('message', onMessage); controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const authorize = new URL(config.authorizationUrl);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: `${window.location.origin}/oauth/callback/${id}`, scope: config.scopes, aud: config.audience, state, code_challenge: codeChallenge, code_challenge_method: 'S256', response_mode: config.responseMode })) authorize.searchParams.set(key, value);
    popup.location.href = authorize.href;
    const code = await codePromise;
    const credentials = await json<{ accessToken: string; patientId: string; receipt: string }>(await fetch(`/api/connectors/${id}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }), signal: controller.signal, cache: 'no-store' }));
    const all: unknown[] = []; const warnings: string[] = []; let complete = true;
    const fetchedReferences = new Set<string>();
    type Reference = { reference: string; capability: string };
    const resolveReferences = async (references: Reference[]) => {
      let queue = references;
      // PractitionerRole -> Practitioner/Location is the only supported second hop.
      for (let hop = 0; hop < 2 && queue.length; hop++) {
        const nextHop: Reference[] = [];
        const unique = queue.filter(item => { if (fetchedReferences.has(item.reference)) return false; fetchedReferences.add(item.reference); return true; });
        for (let i = 0; i < unique.length; i += 10) {
          if (fetchedReferences.size > 500) { complete = false; warnings.push('Some provider or medication references exceeded the session limit. Review their identifiers manually.'); return; }
          const reply = await json<{ resources: unknown[]; references: Reference[]; incomplete: boolean }>(await fetch(`/api/connectors/${id}/references`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.accessToken}` },
            body: JSON.stringify({ receipt: credentials.receipt, patientId: credentials.patientId, references: unique.slice(i, i + 10) }), signal: controller.signal, cache: 'no-store',
          }));
          all.push(...reply.resources); nextHop.push(...reply.references);
          if (reply.incomplete) { complete = false; warnings.push('Some referenced provider or medication details were unavailable. Review imported identifiers.'); }
        }
        queue = nextHop;
      }
    };
    const resourceTypes = id === 'atrius' ? ['Patient', 'Encounter', 'MedicationRequest', 'MedicationDispense'] : ['Patient', 'ExplanationOfBenefit'];
    for (const resource of resourceTypes) {
      let next: string | undefined; const seen = new Set<string>(); let pages = 0;
      try {
        do {
          if (++pages > 100 || all.length >= 20000) throw new Error('This import exceeded the session limit; the imported history is partial.');
          const response = await json<{ page: unknown; references: Reference[]; referenceLimitReached: boolean }>(await fetch(`/api/connectors/${id}/resource`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.accessToken}` }, body: JSON.stringify({ receipt: credentials.receipt, patientId: credentials.patientId, resource, from: '2025-01-01', to: '2025-12-31', ...(next ? { next } : {}) }), signal: controller.signal, cache: 'no-store' }));
          const page = response.page;
          all.push(...resourcesFromPage(page)); next = nextPage(page);
          if (response.referenceLimitReached) { complete = false; warnings.push('Provider or medication references were truncated by the provider-page limit.'); }
          try { await resolveReferences(response.references); }
          catch (error) { if (controller.signal.aborted) throw error; complete = false; warnings.push('Some referenced provider or medication details could not be imported. Review their identifiers manually.'); }
          if (next) { if (seen.has(next)) throw new Error('The provider repeated a page; this import is partial.'); seen.add(next); }
        } while (next);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (resource === 'Patient') throw new Error('The connection could not verify patient demographics. Please reconnect.');
        complete = false; warnings.push(`${resource}: ${error instanceof Error ? error.message : 'Unable to finish this import.'}`);
      }
    }
    if (generation !== sessionGeneration()) throw new Error('The session was cleared. Please reconnect.');
    const result = normalizeFhir(all, id, { from: '2025-01-01', to: '2025-12-31', patientId: credentials.patientId, fhirBase: config.audience });
    return { ...result, complete: complete && result.complete, warnings: [...new Set([...warnings, ...result.warnings])] };
  } finally { pending.delete(stop); window.removeEventListener('plan-shepherd:clear-session', stop); popup.close(); releaseController(controller); }
}
