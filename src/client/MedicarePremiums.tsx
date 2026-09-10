import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

const maxCents = 100_000_000_000;
function amountInCents(value: string): number | null {
  if (!value.trim()) return null;
  const dollars = Number(value);
  const cents = Math.round(dollars * 100);
  return Number.isFinite(dollars) && dollars >= 0 && cents <= maxCents && Math.abs(dollars * 100 - cents) < 0.00001 ? cents : null;
}
const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const guideFields = [
  { key: 'partA', label: 'Part A premium per month', hint: 'Use the monthly amount from your Medicare statement. Enter 0 only if you have no Part A premium.' },
  { key: 'partB', label: 'Part B premium per month', hint: 'Use the monthly amount from your Medicare or Social Security statement.' },
  { key: 'adjustments', label: 'Income-related adjustments per month', hint: 'Add any separate Medicare income-related charges. Enter 0 if none apply. Do not repeat charges already included in Part A or Part B above.' },
  { key: 'reductions', label: 'Assistance and premium reductions per month', hint: 'Enter only confirmed help or reductions that apply with this plan and have not already been subtracted above. Enter 0 if none apply.' },
] as const;
type GuideKey = typeof guideFields[number]['key'];

export function MedicarePremiums({ planId, planName, value, onChange }: {
  planId: string; planName: string; value: number | null; onChange: (cents: number | null) => void;
}) {
  const id = useId();
  const [totalDraft, setTotalDraft] = useState(value == null ? '' : String(value / 100));
  const [totalBadInput, setTotalBadInput] = useState(false);
  const [guide, setGuide] = useState<Record<GuideKey, string>>({ partA: '', partB: '', adjustments: '', reductions: '' });
  const [applied, setApplied] = useState(false);
  useEffect(() => { setTotalDraft(current => amountInCents(current) === value ? current : value == null ? '' : String(value / 100)); }, [value]);
  const amounts = guideFields.map(field => amountInCents(guide[field.key]));
  const complete = amounts.every(amount => amount !== null);
  const total = complete ? amounts[0]! + amounts[1]! + amounts[2]! - amounts[3]! : null;
  const totalValid = total != null && total >= 0 && total <= maxCents;
  const directError = totalBadInput || (totalDraft.trim() !== '' && amountInCents(totalDraft) == null);
  return <section className="card medicare-premiums" aria-labelledby={`${id}-title`} data-plan-id={planId}>
    <span className="eyebrow">YOUR MEDICARE PREMIUMS</span><h3 id={`${id}-title`}>{planName}</h3>
    <p className="field-hint">Add the Medicare premiums you would still pay each month with this plan. The comparison adds this amount to the plan’s own premium.</p>
    <div className="field"><label className="field-label" htmlFor={`${id}-total`}>Other Medicare premiums per month for this plan</label>
      <div className="input-prefix"><span aria-hidden="true">$</span><input id={`${id}-total`} type="number" min="0" max="1000000000" step="0.01" autoComplete="off" placeholder="Unknown" value={totalDraft}
        aria-invalid={directError} aria-describedby={`${id}-total-hint${directError ? ` ${id}-total-error` : ''}`}
        onChange={event => { const next = event.target.value; setTotalDraft(next); setTotalBadInput(event.target.validity.badInput); setApplied(false); onChange(amountInCents(next)); }} /></div>
      <span className="field-hint" id={`${id}-total-hint`}>Use the total you would pay after confirmed assistance and reductions. Leave blank if unknown; enter 0 only if no other premiums apply. Do not include this plan’s own premium.</span>
      {directError && <span className="field-error" id={`${id}-total-error`}>Enter an amount from $0 to $1,000,000,000, with no more than two decimal places. This entry stays unknown until corrected.</span>}
    </div>
    <details className="form-details premium-guide"><summary>Help me add up these premiums <ChevronDown size={17} /></summary>
      <p>Use your Medicare, Social Security, or insurer statement. Enter monthly dollar amounts in each box. Leave an amount blank if you do not know it; use 0 only when you have confirmed it does not apply.</p>
      <p className="field-hint">Check each amount once. If a statement already includes an adjustment or subtracts assistance, do not count that same amount again below. Use any plan-specific reductions confirmed for {planName}.</p>
      <div className="form-grid">{guideFields.map(field => {
        const invalid = guide[field.key].trim() !== '' && amountInCents(guide[field.key]) == null;
        return <div className="field" key={field.key}><label className="field-label" htmlFor={`${id}-${field.key}`}>{field.label}</label>
          <div className="input-prefix"><span aria-hidden="true">$</span><input id={`${id}-${field.key}`} type="number" min="0" max="1000000000" step="0.01" placeholder="Unknown" autoComplete="off" value={guide[field.key]}
            aria-invalid={invalid} aria-describedby={`${id}-${field.key}-hint${invalid ? ` ${id}-${field.key}-error` : ''}`}
            onChange={event => { const next = event.target.value; setGuide(current => ({ ...current, [field.key]: next })); setApplied(false); }} /></div>
          <span className="field-hint" id={`${id}-${field.key}-hint`}>{field.hint}</span>
          {invalid && <span className="field-error" id={`${id}-${field.key}-error`}>Enter a nonnegative dollar amount with no more than two decimal places, up to $1,000,000,000.</span>}
        </div>;
      })}</div>
      <div className="premium-guide-total" aria-live="polite">
        {!complete ? <p>Complete all four amounts, including any confirmed zeros, to calculate a total.</p>
          : !totalValid ? <p className="field-error">{total! < 0 ? 'The reductions exceed the premiums entered. Check your statement before using a total.' : 'The calculated amount is too large. Check the amounts entered.'}</p>
            : <p>Calculated other Medicare premiums: <strong>{dollars(total!)} per month</strong></p>}
        <p className="field-hint">The comparison changes only when you choose “Use this total” or edit the total above.</p>
        <button type="button" className="button button-secondary" disabled={!totalValid} onClick={() => {
          if (!totalValid || total == null) return;
          setTotalDraft(String(total / 100)); setTotalBadInput(false); onChange(total); setApplied(true);
        }}>Use this total</button>
        {applied && <p role="status">Total added to this plan’s comparison.</p>}
      </div>
    </details>
  </section>;
}
