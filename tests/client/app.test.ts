// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../src/client/App';
import { comparePlans } from '../../src/domain';
import type { AppStatus, AssistantReply, CatalogSearch, ComparisonInput, ComparisonResult, ImportResult, Plan, SourceRef } from '../../src/shared/contracts';

const oauth = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/client/oauth', () => ({ connectPatient: oauth.connect, resetPatientSession: () => window.dispatchEvent(new CustomEvent('plan-shepherd:clear-session')) }));
const status: AppStatus = { year: 2026, connectors: [{ id: 'atrius', name: 'Atrius Health', configured: true, enabled: true }, { id: 'cigna', name: 'Cigna', configured: false, enabled: false }], ai: { enabled: true }, catalog: { available: false, releaseId: null, planCount: 0 }, productionReady: false, issues: [] };
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
