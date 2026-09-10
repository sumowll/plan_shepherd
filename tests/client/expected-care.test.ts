// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpectedCareEditor, type ExpectedCareEditorProps } from '../../src/client/ExpectedCareEditor';
import type { ExpectedCareEvent, PersonProfile } from '../../src/shared/contracts';

const profile: PersonProfile = { dateOfBirth: '1950-01-01', state: 'MA', countyFips: '25017', zip: '02144', householdSize: 1, annualIncomeCents: null, employerOffer: 'unknown', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown', medicarePartA: 'unknown', medicarePartB: 'unknown', tobacco: 'no', coverageStart: '2026-01-01', coverageEnd: '2026-12-31', citizenshipEligible: 'unknown', incarcerated: 'unknown', enrollmentEvent: 'unknown' };
const care: ExpectedCareEvent = { id: 'care', label: 'Regular visit', category: 'primary_care', date: '2026-01-31', quantity: 1, unitPriceCents: null, confirmed: false };
const props = (patch: Partial<ExpectedCareEditorProps> = {}): ExpectedCareEditorProps => ({ item: care, index: 0, profile, providers: [], medications: [], onChange: vi.fn(), onRemove: vi.fn(), onResolveSource: vi.fn(), onRepeat: vi.fn(), ...patch });
afterEach(cleanup);

describe('expected care guidance', () => {
  it('links the disabled confirmation to field errors and focuses the field needing attention', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(createElement(ExpectedCareEditor, props({ item: { ...care, label: '', quantity: 0 } })));
    const confirm = screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const guidance = document.getElementById(confirm.getAttribute('aria-describedby')!);
    expect(guidance?.textContent).toContain('Enter a short description of this care.');
    expect(screen.getByLabelText('Description').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('link', { name: 'Enter a short description of this care.' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Description'));
    expect(scroll).toHaveBeenCalled();
  });

  it('opens optional details when a pricing error is selected', () => {
    render(createElement(ExpectedCareEditor, props({ item: { ...care, unitPriceCents: -100 } })));
    const cost = screen.getByLabelText('Estimated cost per item');
    const details = cost.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Enter a valid cost of $0 or more, or leave it blank if unknown.' }));
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(cost);
  });

  it.each([
    { quantity: Infinity }, { quantity: 10001 }, { date: '2026-02-30' }, { date: '2027-01-01' },
    { category: 'prescription' as const, quantity: 2 }, { dispensedQuantity: 0 }, { dispensedQuantity: 100001 },
    { daysSupply: 1.5 }, { daysSupply: 367 }, { unitPriceCents: 1.5 }, { balanceBillingCents: -1 },
  ])('preserves the confirmation guard for invalid care %j', invalid => {
    render(createElement(ExpectedCareEditor, props({ item: { ...care, ...invalid } })));
    const button = screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.querySelectorAll('a').length).toBeGreaterThan(0);
  });

  it('allows fractional medical units and fractional dispensed quantities for a single fill', () => {
    const { rerender } = render(createElement(ExpectedCareEditor, props({ item: { ...care, quantity: 0.5 } })));
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(false);
    rerender(createElement(ExpectedCareEditor, props({ item: { ...care, category: 'prescription', dispensedQuantity: 0.5 } })));
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps source review explicit before confirmation or repeating', () => {
    const callbacks = props({ sourceReview: { reason: 'The source changed.', latest: care } });
    render(createElement(ExpectedCareEditor, callbacks));
    expect(screen.getByRole('group', { name: 'Source changes for care item 1' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm this care' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my current scenario' }));
    expect(callbacks.onResolveSource).toHaveBeenCalledWith(false);
    expect(callbacks.onRepeat).not.toHaveBeenCalled();
  });
});

describe('repeating care review', () => {
  it('previews every new date before explicit addition and requires another preview after changes', () => {
    const callbacks = props();
    const { rerender } = render(createElement(ExpectedCareEditor, callbacks));
    const repeat = screen.getByText('Repeat this care').closest('details')!;
    repeat.open = true;
    expect(screen.queryByRole('button', { name: /Add .* repeated/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Last date for repeats'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview repeat dates' }));
    expect(within(screen.getByRole('list', { name: 'Dates for new care items' })).getAllByRole('listitem').map(node => node.textContent)).toEqual(['Feb 28, 2026', 'Mar 31, 2026']);
    expect(callbacks.onRepeat).not.toHaveBeenCalled();
    rerender(createElement(ExpectedCareEditor, { ...callbacks, item: { ...care, label: 'Changed visit' } }));
    expect(screen.queryByRole('button', { name: 'Add 2 repeated items' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview repeat dates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 repeated items' }));
    expect(callbacks.onRepeat).toHaveBeenCalledWith([expect.objectContaining({ label: 'Changed visit', date: '2026-02-28', confirmed: false }), expect.objectContaining({ label: 'Changed visit', date: '2026-03-31', confirmed: false })]);
    expect(screen.queryByRole('button', { name: 'Add 2 repeated items' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Added 2 care items.');
  });
});
