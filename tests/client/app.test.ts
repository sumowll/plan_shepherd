// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { connectionIdentity } from '../helpers/connection-identity';
import App from '../../src/client/App';
import { comparePlans } from '../../src/domain';
import type { AppStatus, AssistantReply, CatalogSearch, ComparisonInput, ComparisonResult, ImportResult, Plan, SourceRef } from '../../src/shared/contracts';

const oauth = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/client/oauth', () => ({ connectPatient: oauth.connect, resetPatientSession: () => window.dispatchEvent(new CustomEvent('plan-shepherd:clear-session')) }));
const status: AppStatus = { year: 2026, connectors: [{ ...connectionIdentity('atrius', 1, 'atrius-health'), name: 'Atrius Health', kind: 'provider', apiType: 'patient_access', configured: true, enabled: true }, { ...connectionIdentity('cigna', 2, 'cigna'), name: 'Cigna', kind: 'payer', apiType: 'patient_access', configured: false, enabled: false }], ai: { enabled: true }, catalog: { available: false, releaseId: null, planCount: 0 }, productionReady: false, issues: [] };
const imported: ImportResult = { providers: [{ id: 'imported-provider', name: 'Imported provider', preferred: false, evidence: [] }], medications: [], events: [], warnings: [], resourcesRead: 2, complete: true, patient: { source: 'Atrius Health', id: 'patient-1', name: 'Test Patient', dateOfBirth: '1980-02-03', evidence: [] } };
let assistantReply: AssistantReply;
let catalogRequest: ((input: Record<string, unknown>) => Promise<CatalogSearch>) | undefined;
let comparisonRequest: ((input: ComparisonInput) => ComparisonResult[]) | undefined;
let assistantBodies: unknown[];

beforeEach(() => {
  vi.clearAllMocks(); assistantBodies = []; catalogRequest = undefined; comparisonRequest = undefined;
  assistantReply = { message: 'Review the provider below.', proposals: [{ id: 'proposal-1', kind: 'provider', value: { name: 'Dr Example', location: 'Boston' }, evidenceIds: ['chat:0'], explanation: 'Extracted from your message.' }], evidenceIds: ['chat:0'] };
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown;
    if (url === '/api/status') data = status;
    else if (url.startsWith('/api/geography/counties')) data = { counties: [{ fips: '25017', name: 'Middlesex County' }] };
    else if (url === '/api/assistant') { assistantBodies.push(JSON.parse(String(init?.body))); data = assistantReply; }
    else if (url === '/api/catalog/search' && catalogRequest) data = await catalogRequest(JSON.parse(String(init?.body)));
    else if (url === '/api/compare' && comparisonRequest) data = { results: comparisonRequest(JSON.parse(String(init?.body))), eligibility: [] };
    else throw new Error(`Unexpected test request: ${url}`);
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function enterProfile(dob = '1980-02-03') {
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: dob } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'MA' } });
  fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: '02144' } });
  await screen.findByRole('option', { name: 'Middlesex County' });
  fireEvent.change(screen.getByLabelText(/^County/), { target: { value: '25017' } });
}
function goStep(name: string) { fireEvent.click(within(screen.getByRole('navigation', { name: 'Coverage steps' })).getByRole('button', { name: new RegExp(name) })); }
async function importRecords(again = false) {
  goStep('Your care');
  fireEvent.click(screen.getByRole('button', { name: again ? 'Import again' : 'Connect account' }));
  await screen.findByRole('dialog', { name: 'CONFIRM YOUR RECORDS' });
  fireEvent.click(screen.getByRole('checkbox', { name: /These are my records/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Add my records' }));
}
const publicSource: SourceRef = { id: 'client-fixture', publisher: 'Synthetic test data', url: 'https://example.org/test', retrievedAt: '2026-01-01', version: 'test' };
function publicPlan(id: string): Plan { return { id, name: `Public plan ${id}`, issuer: 'Synthetic issuer', family: 'aca', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 10000, premiumEstimated: false, deductibleCents: 0, oopMaxCents: 200000, drugDeductibleCents: 0, drugOopMaxCents: 200000, benefits: [], providers: [], drugs: [], prices: [], source: publicSource, documentUrls: [], rulesVerified: true, underwritingRequired: false, networkComplete: true, formularyComplete: true }; }

describe('connection availability', () => {
  it('only offers patient access APIs in the patient record connections', async () => {
    const otherApis = [
      { ...connectionIdentity('cigna-transfer', 3, 'cigna'), name: 'Cigna Payer-to-Payer', kind: 'payer' as const, apiType: 'payer_to_payer' as const, configured: true, enabled: true },
      { ...connectionIdentity('cigna-directory', 4, 'cigna'), name: 'Cigna Provider Directory', kind: 'payer' as const, apiType: 'provider_directory' as const, configured: true, enabled: true },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, connectors: [...status.connectors, ...otherApis] }) } as Response);
    render(createElement(App)); goStep('Your care');
    await screen.findByRole('heading', { name: 'Atrius Health' });
    expect(screen.getByRole('heading', { name: 'Cigna' })).toBeTruthy();
    for (const connector of otherApis) expect(screen.queryByRole('heading', { name: connector.name })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect account' })).toHaveLength(1);
  });

  it('labels a sandbox as test records while allowing test member sign-in', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, connectors: status.connectors.map(connector => connector.key === 'cigna' ? { ...connector, configured: true, enabled: true, testEnvironment: true } : connector) }) } as Response);
    oauth.connect.mockResolvedValue(imported);
    render(createElement(App)); goStep('Your care');
    const testNote = await screen.findByText('Test records only');
    const sandbox = within(testNote.closest('.connector-card') as HTMLElement);
    expect(sandbox.getByRole('heading', { name: 'Cigna' })).toBeTruthy();
    expect(sandbox.getByText('Sign in with a test member account.')).toBeTruthy();
    expect(screen.getByText('Your provider records')).toBeTruthy();
    expect(screen.queryByText('Your claims & care history')).toBeNull();
    const connect = sandbox.getByRole('button', { name: 'Connect account' });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(connect);
    await screen.findByRole('dialog', { name: 'CONFIRM YOUR RECORDS' });
    expect(oauth.connect).toHaveBeenCalledWith(status.connectors[1].id);
  });

  it('retries a failed availability check without clearing entered information and enables account connection', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Service unavailable'));
    oauth.connect.mockResolvedValue(imported);
    render(createElement(App)); await enterProfile(); goStep('Your care');
    const connections = within(screen.getByRole('region', { name: 'Bring your records together' }));
    const retry = await connections.findByRole('button', { name: 'Retry availability' });
    expect(connections.getByRole('status').textContent).toContain('Connection status unavailable.');
    expect(connections.queryByRole('button', { name: 'Connect account' })).toBeNull();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(retry);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(connections.queryByRole('button', { name: 'Connect account' })).toBeNull();
    await act(async () => finish({ ok: true, json: async () => status } as Response));
    expect((connections.getByRole('button', { name: 'Connect account' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Connections and catalog availability could not be checked/)).toBeNull();
    goStep('Your coverage');
    expect((screen.getByLabelText('Date of birth') as HTMLInputElement).value).toBe('1980-02-03');
    goStep('Your care');
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
    await screen.findByRole('dialog', { name: 'CONFIRM YOUR RECORDS' });
    expect(oauth.connect).toHaveBeenCalledWith(status.connectors[0].id);
  });

  it('shows the connection reason and rechecks unavailable connectors', async () => {
    const reason = 'Atrius Health has not enabled this app for patient connections yet.';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, connectors: status.connectors.map(connector => ({ ...connector, configured: false, enabled: false, reason })) }) } as Response);
    render(createElement(App)); goStep('Your care');
    const connections = within(screen.getByRole('region', { name: 'Bring your records together' }));
    await connections.findAllByText(reason);
    expect(connections.queryByText('OPTIONAL')).toBeNull();
    fireEvent.click(connections.getByRole('button', { name: 'Retry availability' }));
    expect((await connections.findByRole('button', { name: 'Connect account' }) as HTMLButtonElement).disabled).toBe(false);
    expect(connections.queryAllByText(reason)).toHaveLength(0);
  });

  it('renders arbitrary registry entries and uses their name when confirming records', async () => {
    const connector = { ...connectionIdentity('hospital-123', 5, 'hospital'), name: 'Example University Hospital', kind: 'provider' as const, apiType: 'patient_access' as const, configured: true, enabled: true };
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, connectors: [connector] }) } as Response);
    oauth.connect.mockResolvedValue({ ...imported, patient: { ...imported.patient!, source: connector.id } });
    render(createElement(App)); goStep('Your care');
    await screen.findByRole('heading', { name: connector.name });
    expect(screen.queryByRole('heading', { name: 'Atrius Health' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Cigna' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search providers and insurers' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Connection pages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry availability' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
    const confirmation = within(await screen.findByRole('dialog', { name: 'CONFIRM YOUR RECORDS' }));
    expect(oauth.connect).toHaveBeenCalledWith(connector.id);
    expect(confirmation.getByText(`Review the identity supplied by ${connector.name} before adding these records to your session.`)).toBeTruthy();
  });

  it('bounds a large registry to twenty cards and supports paging and name search', async () => {
    const connectors = Array.from({ length: 1003 }, (_, index) => ({ ...connectionIdentity(`hospital-${index + 1}`, index + 1), name: `Hospital ${String(index + 1).padStart(4, '0')}`, kind: 'provider' as const, apiType: 'patient_access' as const, configured: true, enabled: true }));
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, connectors }) } as Response);
    render(createElement(App)); goStep('Your care');
    const connections = within(screen.getByRole('region', { name: 'Bring your records together' }));
    await connections.findByRole('heading', { name: 'Hospital 0001' });
    expect(connections.getAllByRole('button', { name: 'Connect account' })).toHaveLength(20);
    expect(connections.getByText('1–20 of 1003 connections')).toBeTruthy();
    expect((connections.getByRole('button', { name: 'Previous connections' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(connections.getByRole('button', { name: 'Next connections' }));
    expect(connections.queryByRole('heading', { name: 'Hospital 0001' })).toBeNull();
    expect(connections.getByRole('heading', { name: 'Hospital 0021' })).toBeTruthy();
    expect(connections.getByText('21–40 of 1003 connections')).toBeTruthy();
    const search = connections.getByRole('searchbox', { name: 'Search providers and insurers' });
    fireEvent.change(search, { target: { value: '  hOsPiTaL 100  ' } });
    expect(connections.getAllByRole('button', { name: 'Connect account' })).toHaveLength(4);
    expect(connections.getByRole('heading', { name: 'Hospital 1003' })).toBeTruthy();
    expect(connections.queryByRole('navigation', { name: 'Connection pages' })).toBeNull();
    fireEvent.change(search, { target: { value: 'not a registered name' } });
    expect(connections.getByText('No providers or insurers match your search.')).toBeTruthy();
    expect(connections.queryByRole('button', { name: 'Connect account' })).toBeNull();
    fireEvent.change(search, { target: { value: '' } });
    expect(connections.getByText('1–20 of 1003 connections')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Hospital 002' } });
    expect(connections.getAllByRole('button', { name: 'Connect account' })).toHaveLength(10);
  });

  it('shows loading and empty registry states without inventing connector cards', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(createElement(App)); goStep('Your care');
    const connections = within(screen.getByRole('region', { name: 'Bring your records together' }));
    expect(connections.getByRole('status').textContent).toBe('Checking connection availability…');
    expect(connections.queryByRole('button', { name: 'Connect account' })).toBeNull();
    await act(async () => finish({ ok: true, json: async () => ({ ...status, connectors: [] }) } as Response));
    expect(connections.getByRole('status').textContent).toBe('No provider or insurer connections are available yet. You can add your care details below.');
    expect(connections.queryByRole('heading', { name: 'Atrius Health' })).toBeNull();
    fireEvent.click(connections.getByRole('button', { name: 'Retry availability' }));
    expect((await connections.findByRole('button', { name: 'Connect account' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('reimports and complete catalog navigation', () => {
  it('preserves corrected provider/medication details and selections across reimports, invalidating care only when source meaning changes', async () => {
    const record: ImportResult = { ...imported, providers: [{ id: 'p', name: 'Source physician', location: 'Original clinic', preferred: false }], medications: [{ id: 'm', name: 'Source prescription', strength: '10 mg', ongoing: false }], events: [{ id: 'visit', source: 'atrius', date: '2025-03-01', category: 'outpatient', label: 'Recorded visit', kind: 'claim', status: 'completed', providerId: 'p', quantity: 1, allowedCents: 10000, version: '1', evidence: [] }] };
    oauth.connect.mockResolvedValue(record);
    render(createElement(App)); await enterProfile(); await importRecords();
    fireEvent.click(screen.getByRole('checkbox', { name: /Source physician/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Source physician' }));
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Corrected clinic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Source prescription/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Source prescription' }));
    fireEvent.change(screen.getByLabelText('Strength'), { target: { value: '20 mg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    goStep('The year ahead'); fireEvent.click(screen.getByRole('button', { name: 'Use recent history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    await importRecords(true);
    expect((screen.getByRole('checkbox', { name: /Source physician/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Source prescription/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Corrected clinic/)).toBeTruthy(); expect(screen.getByText(/20 mg/)).toBeTruthy();
    goStep('The year ahead'); expect(screen.getByText('Ready for your comparison')).toBeTruthy();
    oauth.connect.mockResolvedValue({ ...record, providers: [{ ...record.providers[0], location: 'New source clinic' }] });
    await importRecords(true);
    expect(screen.getByText(/Corrected clinic/)).toBeTruthy();
    goStep('The year ahead'); expect(screen.queryByText('Ready for your comparison')).toBeNull();
    expect(screen.getByRole('group', { name: 'Source changes for care item 1' })).toBeTruthy();
    expect(screen.getByText(/location changed from “Original clinic” to “New source clinic”/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my current scenario' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    expect(screen.getByText('Ready for your comparison')).toBeTruthy();
  });

  it('keeps edited forecast values pending review, refreshes explicitly, and handles a removed claim line', async () => {
    const claim = { id: 'claim-line', sourceResourceId: 'eob-1', source: 'atrius', date: '2025-03-01', category: 'outpatient' as const, label: 'Recorded claim', kind: 'claim' as const, status: 'completed' as const, quantity: 1, allowedCents: 10000, version: '1', evidence: [] };
    oauth.connect.mockResolvedValueOnce({ ...imported, events: [claim] }).mockResolvedValueOnce({ ...imported, events: [{ ...claim, allowedCents: 50000, version: '2' }] }).mockResolvedValueOnce({ ...imported, events: [], claimSnapshots: [{ source: 'atrius', resourceId: 'eob-1', status: 'completed', complete: true, eventIds: [], version: '3' }] });
    render(createElement(App)); await enterProfile(); await importRecords();
    goStep('The year ahead'); fireEvent.click(screen.getByRole('button', { name: 'Use recent history' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My revised care' } });
    fireEvent.change(screen.getByLabelText('Expected date'), { target: { value: '2026-09-03' } });
    fireEvent.change(screen.getByLabelText(/^Estimated cost per item/), { target: { value: '175' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    await importRecords(true); goStep('The year ahead');
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('My revised care');
    expect((screen.getByLabelText('Expected date') as HTMLInputElement).value).toBe('2026-09-03');
    expect((screen.getByLabelText(/^Estimated cost per item/) as HTMLInputElement).value).toBe('175');
    expect(screen.queryByText('Ready for your comparison')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use recent history' }));
    expect(screen.getAllByLabelText('Description')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use latest source details' }));
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Recorded claim');
    expect((screen.getByLabelText(/^Estimated cost per item/) as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    await importRecords(true); goStep('The year ahead');
    expect(screen.queryByRole('button', { name: 'Use latest source details' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my current scenario' }));
    expect((screen.getByLabelText(/^Estimated cost per item/) as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    expect(screen.getByText('Ready for your comparison')).toBeTruthy();
  });

  it('confirms a fractional medical quantity and a fractional dispensed amount without changing one fill per event', async () => {
    oauth.connect.mockResolvedValue({ ...imported, events: [{ id: 'fractional', source: 'atrius', date: '2025-03-01', category: 'outpatient', label: 'Fractional medical unit', kind: 'claim', status: 'completed', quantity: 0.5, allowedCents: 5000, evidence: [] }] });
    render(createElement(App)); await enterProfile(); await importRecords(); goStep('The year ahead');
    fireEvent.click(screen.getByRole('button', { name: 'Use recent history' }));
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByLabelText(/^Estimated cost per item/) as HTMLInputElement).value).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    expect(screen.getByText('Ready for your comparison')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type of care'), { target: { value: 'prescription' } });
    fireEvent.change(screen.getByLabelText('Quantity dispensed per fill'), { target: { value: '0.5' } });
    expect((screen.getByLabelText(/^Fills in this item/) as HTMLInputElement).value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    expect(screen.getByText('Ready for your comparison')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Quantity dispensed per fill'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches every matching plan and navigates pinned pages while preserving selections for comparison', async () => {
    const plans = Array.from({ length: 21 }, (_, index) => publicPlan(String(index)));
    plans[20].issuer = 'Distant insurer';
    const requests: Record<string, unknown>[] = [];
    catalogRequest = async input => { requests.push(input); const filtered = input.query ? plans.filter(plan => plan.issuer.includes(String(input.query))) : plans; return { plans: filtered.slice(Number(input.offset), Number(input.offset) + Number(input.limit)), total: filtered.length, releaseId: 'pinned-release', coverage: [], warnings: [] }; };
    let compared: ComparisonInput | undefined;
    comparisonRequest = input => { compared = input; return []; };
    render(createElement(App)); await enterProfile(); goStep('Compare plans');
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Public plan 0 for comparison' }));
    expect(screen.getAllByRole('checkbox', { name: /Select Public plan/ })).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Public plan 20 for comparison' }));
    expect(screen.getByRole('button', { name: 'Deselect Public plan 0' })).toBeTruthy();
    expect(requests[1]).toMatchObject({ offset: 20, limit: 20, releaseId: 'pinned-release', query: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    const selectedFirst = await screen.findByRole('checkbox', { name: 'Select Public plan 0 for comparison' });
    expect((selectedFirst as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Search plans or insurers'), { target: { value: 'Distant insurer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect((await screen.findByRole('checkbox', { name: 'Select Public plan 20 for comparison' }) as HTMLInputElement).checked).toBe(true);
    expect(requests.at(-1)).toMatchObject({ query: 'Distant insurer', releaseId: 'pinned-release', offset: 0, limit: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected plans' }));
    await waitFor(() => expect(compared?.planIds).toEqual(['0', '20']));
    expect(compared?.releaseId).toBe('pinned-release');
    fireEvent.change(screen.getByLabelText('Search plans or insurers'), { target: { value: 'No such insurer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search catalog' }));
    await screen.findByText('No plans match that search.');
    expect(screen.getByRole('button', { name: 'Deselect Public plan 0' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search plans or insurers'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search catalog' }));
    await screen.findByText('21 plans in the catalog');
    expect(requests.at(-1)?.releaseId).toBe('pinned-release');
  });

  it('keeps prior selections when a pinned release becomes unavailable and resets them on an explicit new search', async () => {
    const plan = publicPlan('old'); let available = true;
    catalogRequest = async input => input.releaseId && !available ? { plans: [], total: 0, releaseId: null, coverage: [], warnings: [] } : { plans: [plan], total: 21, releaseId: available ? 'old-release' : 'new-release', coverage: [], warnings: [] };
    render(createElement(App)); await enterProfile(); goStep('Compare plans');
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Public plan old for comparison' }));
    available = false;
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/This catalog release is no longer available/);
    expect(screen.getByRole('button', { name: 'Deselect Public plan old' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    const choice = await screen.findByRole('checkbox', { name: 'Select Public plan old for comparison' });
    expect((choice as HTMLInputElement).checked).toBe(false);
  });

  it('does not restore a pending catalog page after coverage changes', async () => {
    let finishPage!: (catalog: CatalogSearch) => void;
    catalogRequest = async input => input.offset === 20 ? new Promise(resolve => { finishPage = resolve; }) : { plans: Array.from({ length: 20 }, (_, index) => publicPlan(String(index))), total: 21, releaseId: 'old-release', coverage: [], warnings: [] };
    render(createElement(App)); await enterProfile(); goStep('Compare plans');
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    await screen.findByRole('checkbox', { name: 'Select Public plan 0 for comparison' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    goStep('Your coverage');
    fireEvent.change(screen.getByLabelText('ZIP code'), { target: { value: '02145' } });
    await act(async () => finishPage({ plans: [publicPlan('late')], total: 21, releaseId: 'old-release', coverage: [], warnings: [] }));
    goStep('Compare plans');
    expect(screen.queryByRole('checkbox', { name: 'Select Public plan late for comparison' })).toBeNull();
    expect(screen.getByText('Clarity starts with the right options.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find available plans' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('consumer session flow', () => {
  it('renders the welcome screen without connected services or personal data', () => {
    const html = renderToString(createElement(App));
    expect(html).toContain('Good coverage starts');
    expect(html).toContain('Continue to your care');
    expect(html).not.toContain('Imported provider');
  });

  it('allows manual profile, provider and prescription entry and explicitly confirmed expected care', async () => {
    render(createElement(App)); await enterProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to your care' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    fireEvent.change(screen.getByLabelText('Provider or facility name'), { target: { value: 'My physician' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(screen.getByRole('checkbox', { name: /My physician/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a prescription' }));
    fireEvent.change(screen.getByLabelText('Medication name'), { target: { value: 'My prescription' } });
    fireEvent.change(screen.getByLabelText('Quantity per fill'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Days supplied per fill'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add prescription' }));
    fireEvent.click(screen.getByRole('button', { name: 'Plan the year ahead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add expected care' }));
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Primary care visit' } });
    fireEvent.change(screen.getByLabelText(/Estimated cost per item/), { target: { value: '175' } });
    fireEvent.change(screen.getByLabelText(/What does this price represent/), { target: { value: 'allowed' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: (screen.getByRole('option', { name: 'My physician' }) as HTMLOptionElement).value } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    expect(screen.getByText('Ready for your comparison')).toBeTruthy();
    goStep('Your care');
    fireEvent.click(screen.getByRole('button', { name: 'Edit My physician' }));
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'New clinic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    goStep('The year ahead');
    expect(screen.queryByText('Ready for your comparison')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this care' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    expect(screen.queryByText('Ready for your comparison')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Type of care/), { target: { value: 'prescription' } });
    const fills = screen.getByLabelText(/^Fills in this item/) as HTMLInputElement;
    expect(fills.value).toBe('1');
    fireEvent.change(fills, { target: { value: '2' } });
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(fills, { target: { value: '1' } });
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('requires explicit AI proposal acceptance and sends only selected evidence and messages', async () => {
    render(createElement(App));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/status', expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'My provider is Dr Example in Boston.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await screen.findByRole('button', { name: 'Confirm & add to my information' });
    expect(assistantBodies).toEqual([{ messages: [{ role: 'user', content: 'My provider is Dr Example in Boston.' }], evidence: [] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Close A LITTLE HELP ALONG THE WAY' }));
    goStep('Your care');
    expect(screen.queryByRole('checkbox', { name: /Dr Example/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add to my information' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close A LITTLE HELP ALONG THE WAY' }));
    expect(screen.getByRole('checkbox', { name: /Dr Example/ })).toBeTruthy();
  });

  it('blocks a mismatched import until identity is reviewed and does not merge before confirmation', async () => {
    oauth.connect.mockResolvedValue(imported);
    render(createElement(App)); await enterProfile('1981-02-03');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to your care' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
    await screen.findByRole('dialog', { name: 'CONFIRM YOUR RECORDS' });
    expect(screen.queryByRole('checkbox', { name: /Imported provider/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /These are my records/ }));
    expect((screen.getByRole('button', { name: 'Add my records' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Your date of birth/), { target: { value: '1980-02-03' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /These are my records/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add my records' }));
    expect(screen.getByRole('checkbox', { name: /Imported provider/ })).toBeTruthy();
  });

  it('clears personal state and rejects a catalog response that arrives after clearing', async () => {
    let complete!: (data: CatalogSearch) => void;
    catalogRequest = () => new Promise(resolve => { complete = resolve; });
    render(createElement(App)); await enterProfile(); goStep('Compare plans');
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear session' }));
    await act(async () => complete({ plans: [], total: 0, releaseId: 'stale-release', coverage: [], warnings: ['Stale response should never appear'] }));
    expect((screen.getByLabelText('Date of birth') as HTMLInputElement).value).toBe('');
    goStep('Compare plans');
    expect(screen.queryByText('Stale response should never appear')).toBeNull();
    expect(screen.getByText('Clarity starts with the right options.')).toBeTruthy();
  });

  it('discards patient records returned by a connection after the session was cleared', async () => {
    let complete!: (data: ImportResult) => void;
    oauth.connect.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(createElement(App)); await enterProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to your care' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear session' }));
    await act(async () => complete(imported));
    expect(screen.queryByRole('dialog', { name: 'CONFIRM YOUR RECORDS' })).toBeNull();
    goStep('Your care');
    expect(screen.queryByRole('checkbox', { name: /Imported provider/ })).toBeNull();
    expect(screen.queryByText(/resources imported/)).toBeNull();
  });

  it('applies all-selected coverage filters to preferred providers and ongoing medications', async () => {
    const source: SourceRef = { id: 'selection-test', publisher: 'Synthetic test data', url: 'https://example.org/test', retrievedAt: '2026-01-01', version: 'test' };
    const candidate: Plan = { id: 'selection-plan', name: 'Selection test plan', issuer: 'Synthetic issuer', family: 'aca', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 10000, premiumEstimated: false, deductibleCents: 10000, oopMaxCents: 50000, drugDeductibleCents: 0, drugOopMaxCents: 50000, benefits: [], providers: [{ name: 'Chosen doctor', npi: '1234567890', location: 'Main clinic', network: 'in_network', source }], drugs: [{ name: 'Chosen medicine', rxnorm: '123', strength: '10 mg', form: 'tablet', coverage: 'covered', source }], prices: [], source, documentUrls: [], rulesVerified: true, underwritingRequired: false, networkComplete: true, formularyComplete: true };
    catalogRequest = async () => ({ plans: [candidate], total: 1, releaseId: 'selection-release', coverage: [], warnings: [] });
    comparisonRequest = input => comparePlans(input, [candidate]);
    render(createElement(App)); await enterProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to your care' }));
    for (const [name, npi] of [['Chosen doctor', '1234567890'], ['Old doctor', '9999999999']]) {
      fireEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
      fireEvent.change(screen.getByLabelText('Provider or facility name'), { target: { value: name } });
      fireEvent.change(screen.getByLabelText(/^NPI/), { target: { value: npi } });
      fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Main clinic' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Old doctor/ }));
    for (const [name, rxnorm] of [['Chosen medicine', '123'], ['Past medicine', '999']]) {
      fireEvent.click(screen.getByRole('button', { name: 'Add a prescription' }));
      fireEvent.change(screen.getByLabelText('Medication name'), { target: { value: name } });
      fireEvent.change(screen.getByLabelText(/^RxNorm code/), { target: { value: rxnorm } });
      fireEvent.change(screen.getByLabelText('Strength'), { target: { value: '10 mg' } });
      fireEvent.change(screen.getByLabelText('Form'), { target: { value: 'tablet' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add prescription' }));
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Past medicine/ }));
    goStep('Compare plans'); fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Selection test plan for comparison' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected plans' }));
    await screen.findByText('How your plans compare');
    fireEvent.click(screen.getByRole('checkbox', { name: 'All selected providers in network' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'All selected medications covered' }));
    const comparison = within(screen.getByText('How your plans compare').closest('section')!);
    expect(comparison.getByText('Chosen doctor')).toBeTruthy();
    expect(comparison.getByText('Chosen medicine')).toBeTruthy();
    expect(comparison.queryByText('Old doctor')).toBeNull();
    expect(comparison.queryByText('Past medicine')).toBeNull();
    expect(comparison.queryByText(/No compared plans meet both filters/)).toBeNull();
  });

  it('keeps Medicare premiums unknown until entered, shows components, and clears them on a new search', async () => {
    const source: SourceRef = { id: 'ma-premium-test', publisher: 'Synthetic test data', url: 'https://example.org/test', retrievedAt: '2026-01-01', version: 'test' };
    const candidate: Plan = { id: 'ma-premium-plan', name: 'Medicare premium test plan', issuer: 'Synthetic issuer', family: 'medicare_advantage', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 10000, premiumEstimated: false, deductibleCents: 0, oopMaxCents: 50000, drugDeductibleCents: 0, drugOopMaxCents: 50000, benefits: [], providers: [], drugs: [], prices: [], source, documentUrls: [], rulesVerified: true, underwritingRequired: false, networkComplete: true, formularyComplete: true };
    catalogRequest = async () => ({ plans: [candidate], total: 1, releaseId: 'ma-release', coverage: [], warnings: [] });
    const submitted: ComparisonInput[] = [];
    comparisonRequest = input => { submitted.push(input); return comparePlans(input, [candidate]); };
    render(createElement(App)); await enterProfile('1950-02-03');
    goStep('Compare plans'); fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Medicare premium test plan for comparison' }));
    const amount = screen.getByLabelText(/^Other Medicare premiums per month/) as HTMLInputElement;
    expect(amount.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected plans' }));
    await screen.findByText('Still incomplete');
    expect(submitted[0].additionalMonthlyPremiums).toEqual({});
    fireEvent.change(amount, { target: { value: '125' } });
    expect(screen.queryByText('How your plans compare')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected plans' }));
    await screen.findByText('How your plans compare');
    expect(submitted[1].additionalMonthlyPremiums).toEqual({ [candidate.id]: 12500 });
    const comparison = within(screen.getByText('How your plans compare').closest('section')!);
    expect(comparison.getByText('Plan premiums (12 months)').nextElementSibling?.textContent).toBe('$1,200');
    expect(comparison.getByText('Other Medicare premiums (12 months)').nextElementSibling?.textContent).toBe('$1,500');
    expect(comparison.queryByText('Still incomplete')).toBeNull();
    fireEvent.change(amount, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected plans' }));
    await screen.findByText('How your plans compare');
    expect(submitted[2].additionalMonthlyPremiums).toEqual({ [candidate.id]: 0 });
    expect(screen.queryByText('Still incomplete')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find available plans' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Medicare premium test plan for comparison' }));
    expect((screen.getByLabelText(/^Other Medicare premiums per month/) as HTMLInputElement).value).toBe('');
  });
});
