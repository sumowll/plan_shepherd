// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CoverageForm } from '../../src/client/CoverageForm';
import { MedicarePremiums } from '../../src/client/MedicarePremiums';
import type { PersonProfile } from '../../src/shared/contracts';

const validProfile: PersonProfile = {
  dateOfBirth: '1950-02-03', state: 'MA', countyFips: '25017', zip: '02144', householdSize: 1,
  annualIncomeCents: null, employerOffer: 'unknown', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown',
  medicarePartA: 'unknown', medicarePartB: 'unknown', tobacco: 'no', coverageStart: '2026-01-01', coverageEnd: '2026-12-31',
  citizenshipEligible: 'unknown', incarcerated: 'unknown', enrollmentEvent: 'unknown',
};
function ProfileHarness({ initial = validProfile, onContinue = vi.fn(), countyError = false, onRetryCounties = vi.fn() }: {
  initial?: PersonProfile; onContinue?: () => void; countyError?: boolean; onRetryCounties?: () => void;
}) {
  const [profile, setProfile] = useState(initial);
  return createElement(CoverageForm, {
    profile, onChange: (key, value) => setProfile(current => ({ ...current, [key]: value })),
    counties: [{ fips: '25017', name: 'Middlesex County' }], countyBusy: false, countyError, onRetryCounties, onContinue,
  });
}
function PremiumHarness({ initial = null, changed = vi.fn() }: { initial?: number | null; changed?: (cents: number | null) => void }) {
  const [value, setValue] = useState(initial);
  return createElement(MedicarePremiums, { planId: 'medicare-a', planName: 'Example Medicare plan', value,
    onChange: next => { setValue(next); changed(next); },
  });
}
function input(label: string) { return screen.getByLabelText(label) as HTMLInputElement; }
function fillGuide({ partA = '0', partB = '200', adjustments = '20', reductions = '10' } = {}) {
  fireEvent.change(input('Part A premium per month'), { target: { value: partA } });
  fireEvent.change(input('Part B premium per month'), { target: { value: partB } });
  fireEvent.change(input('Income-related adjustments per month'), { target: { value: adjustments } });
  fireEvent.change(input('Assistance and premium reductions per month'), { target: { value: reductions } });
}
afterEach(cleanup);

describe('senior-friendly coverage intake', () => {
  it('allows the required essentials to continue with optional answers unknown and Medicare visible', () => {
    const onContinue = vi.fn();
    render(createElement(ProfileHarness, { onContinue }));
    expect(screen.getByRole('combobox', { name: 'Are you enrolled in Medicare Part A?' })).toBeTruthy();
    expect(screen.getByText('Your household').closest('details')?.open).toBe(false);
    expect(input('Date of birth').getAttribute('aria-describedby')).toContain('hint');
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('links required field errors to the exact entry that needs attention', () => {
    const onContinue = vi.fn();
    render(createElement(ProfileHarness, { initial: { ...validProfile, dateOfBirth: '', zip: '123' }, onContinue }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).not.toHaveBeenCalled();
    const summary = within(screen.getByRole('alert'));
    expect(summary.getByRole('link', { name: /Date of birth/ }).getAttribute('href')).toBe('#coverage-dateOfBirth');
    fireEvent.click(summary.getByRole('link', { name: /ZIP code/ }));
    expect(document.activeElement).toBe(input('ZIP code'));
    expect(input('ZIP code').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input('ZIP code'), { target: { value: '02144' } });
    fireEvent.change(input('Date of birth'), { target: { value: '1950-02-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('validates birth dates and a coverage range inside 2026', () => {
    const onContinue = vi.fn();
    render(createElement(ProfileHarness, { onContinue }));
    fireEvent.change(input('Date of birth'), { target: { value: '2027-01-01' } });
    fireEvent.change(input('Coverage begins'), { target: { value: '2026-09-01' } });
    fireEvent.change(input('Coverage ends'), { target: { value: '2026-05-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(input('Date of birth').getAttribute('aria-invalid')).toBe('true');
    expect(input('Coverage ends').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input('Date of birth'), { target: { value: '1950-02-03' } });
    fireEvent.change(input('Coverage ends'), { target: { value: '2027-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.change(input('Coverage ends'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('keeps the county retry actionable when the disabled county selector cannot validate itself', () => {
    const onContinue = vi.fn(); const onRetryCounties = vi.fn();
    render(createElement(ProfileHarness, { countyError: true, onContinue, onRetryCounties }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('link', { name: /County/ }));
    const retry = screen.getByRole('button', { name: 'Retry counties' });
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(onRetryCounties).toHaveBeenCalledOnce();
  });

  it('opens optional questions when an error summary link targets an invalid entry inside them', () => {
    const onContinue = vi.fn();
    render(createElement(ProfileHarness, { initial: { ...validProfile, householdSize: 0 }, onContinue }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete and continue' }));
    const details = screen.getByText('Your household').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('link', { name: /People in your tax household/ }));
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(input('People in your tax household'));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('shows employer follow-up questions only when coverage is offered', () => {
    render(createElement(ProfileHarness));
    expect(screen.queryByLabelText('Whose employment provides the offer?')).toBeNull();
    fireEvent.change(screen.getByLabelText('Is employer coverage offered to you?'), { target: { value: 'yes' } });
    expect(screen.getByLabelText('Whose employment provides the offer?')).toBeTruthy();
    expect(screen.getByLabelText('Does the plan meet minimum value?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Is employer coverage offered to you?'), { target: { value: 'no' } });
    expect(screen.queryByLabelText('Your monthly cost for employer coverage')).toBeNull();
  });
});

describe('guided Medicare premium entry', () => {
  it('distinguishes unknown, explicit zero, and invalid direct premium entries', () => {
    const changed = vi.fn();
    render(createElement(PremiumHarness, { changed }));
    const total = input('Other Medicare premiums per month for this plan');
    expect(total.value).toBe('');
    fireEvent.change(total, { target: { value: '0' } });
    expect(changed).toHaveBeenLastCalledWith(0);
    fireEvent.change(total, { target: { value: '' } });
    expect(changed).toHaveBeenLastCalledWith(null);
    fireEvent.change(total, { target: { value: '35' } });
    expect(changed).toHaveBeenLastCalledWith(3500);
    fireEvent.change(total, { target: { value: '-12' } });
    expect(total.value).toBe('-12');
    expect(total.getAttribute('aria-invalid')).toBe('true');
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it('keeps the existing total until all guide amounts are supplied and the user explicitly applies it', () => {
    const changed = vi.fn();
    render(createElement(PremiumHarness, { initial: 12345, changed }));
    fireEvent.click(screen.getByText('Help me add up these premiums'));
    const useTotal = screen.getByRole('button', { name: 'Use this total' }) as HTMLButtonElement;
    expect(useTotal.disabled).toBe(true);
    fireEvent.change(input('Part B premium per month'), { target: { value: '200' } });
    expect(useTotal.disabled).toBe(true);
    expect(input('Other Medicare premiums per month for this plan').value).toBe('123.45');
    fillGuide();
    expect(useTotal.disabled).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(input('Other Medicare premiums per month for this plan').value).toBe('123.45');
    fireEvent.click(useTotal);
    expect(changed).toHaveBeenLastCalledWith(21000);
    expect(input('Other Medicare premiums per month for this plan').value).toBe('210');
    fireEvent.change(input('Part B premium per month'), { target: { value: '' } });
    expect(useTotal.disabled).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(input('Other Medicare premiums per month for this plan').value).toBe('210');
  });

  it('requires confirmed zeros and refuses a negative result instead of silently clamping it', () => {
    const changed = vi.fn();
    render(createElement(PremiumHarness, { changed }));
    fireEvent.click(screen.getByText('Help me add up these premiums'));
    fillGuide({ partA: '0', partB: '0', adjustments: '0', reductions: '1' });
    const useTotal = screen.getByRole('button', { name: 'Use this total' }) as HTMLButtonElement;
    expect(useTotal.disabled).toBe(true);
    expect(screen.getByText(/The reductions exceed the premiums entered/)).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(input('Assistance and premium reductions per month'), { target: { value: '0' } });
    fireEvent.click(useTotal);
    expect(changed).toHaveBeenLastCalledWith(0);
    fireEvent.change(input('Part B premium per month'), { target: { value: '12.345' } });
    expect(useTotal.disabled).toBe(true);
  });
});
