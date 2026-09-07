// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ConditionReview } from '../../src/client/ConditionReview';
import type { ConditionConfirmation, ExpectedCareEvent, Medication, Plan, SourceRef } from '../../src/shared/contracts';

const source: SourceRef = { id: 'condition-fixture', publisher: 'Synthetic test data', url: 'https://example.org/conditions', retrievedAt: '2026-01-01', version: 'test' };
const medication: Medication = { id: 'medication', name: 'Synthetic medication', rxnorm: '123', strength: '10 mg', form: 'tablet', ongoing: true };
const care: ExpectedCareEvent = { id: 'care', label: 'June refill', category: 'prescription', medicationId: medication.id, date: '2026-06-01', quantity: 1, unitPriceCents: null, confirmed: true };
function plan(id: string, name: string): Plan {
  return { id, name, issuer: 'Synthetic issuer', family: 'short_term', year: 2026, state: 'MA', countyFips: ['25017'], status: 'available', effectiveStart: '2026-01-01', effectiveEnd: '2026-12-31', monthlyPremiumCents: 10000, premiumEstimated: false, deductibleCents: 10000, oopMaxCents: 50000, drugDeductibleCents: 0, drugOopMaxCents: 50000, underwritingRequired: true, conditions: [{ id: 'same-source-clause', label: 'Source acceptance condition', source }], benefits: [{ id: 'same-benefit-id', category: 'prescription', label: 'Prescription benefit', coverage: 'conditional', network: 'any', copayCents: 1000, coinsuranceBps: 0, appliesDeductible: false, accumulator: 'drug', priorAuthorization: true, conditions: [{ id: 'same-benefit-clause', label: 'Source treatment condition', source }], explanation: 'Synthetic test benefit', source }], providers: [], drugs: [{ ...medication, coverage: 'covered', priorAuthorization: true, source }], prices: [], source, documentUrls: [], rulesVerified: true, networkComplete: false, formularyComplete: true };
}
const plans = [plan('plan-a', 'Plan A'), plan('plan-b', 'Plan B')];
function Harness({ events: initial = [care] }: { events?: ExpectedCareEvent[] }) {
  const [conditions, setConditions] = useState<ConditionConfirmation[]>([]);
  const [events, setEvents] = useState(initial);
  return createElement(ConditionReview, {
    plans, providers: [], medications: [medication], events, conditions,
    onPlanChange: (conditionId, status) => setConditions(current => [...current.filter(item => item.conditionId !== conditionId), { conditionId, status }]),
    onEventChange: (eventId, conditionId, status) => setEvents(current => current.map(event => event.id === eventId ? { ...event, conditions: [...(event.conditions ?? []).filter(item => item.conditionId !== conditionId), { conditionId, status }] } : event)),
  });
}
afterEach(cleanup);
const selectedValue = (element: HTMLElement) => { if (!(element instanceof HTMLSelectElement)) throw new Error('Expected a select control'); return element.value; };

describe('plan-specific condition review', () => {
  it('isolates every source, benefit and medication confirmation even when two plans reuse the same source IDs', () => {
    render(createElement(Harness));
    const first = within(screen.getByText('Plan A').closest('details')!);
    const second = within(screen.getByText('Plan B').closest('details')!);
    const firstFields = first.getAllByRole('combobox');
    expect(firstFields).toHaveLength(5);
    for (const field of firstFields) fireEvent.change(field, { target: { value: 'satisfied' } });
    expect(first.getAllByRole('combobox').map(selectedValue)).toEqual(Array(5).fill('satisfied'));
    expect(second.getAllByRole('combobox').map(selectedValue)).toEqual(Array(5).fill('unknown'));
  });

  it('keeps a treatment confirmation tied to its care item within the same plan', () => {
    render(createElement(Harness, { events: [care, { ...care, id: 'later-care', label: 'July refill', date: '2026-07-01' }] }));
    const first = within(screen.getByText('Plan A').closest('details')!);
    const june = within(first.getByText(/June refill/).parentElement!);
    const july = within(first.getByText(/July refill/).parentElement!);
    fireEvent.change(june.getAllByRole('combobox')[0], { target: { value: 'satisfied' } });
    expect(selectedValue(june.getAllByRole('combobox')[0])).toBe('satisfied');
    expect(july.getAllByRole('combobox').map(selectedValue)).toEqual(Array(3).fill('unknown'));
  });
});
