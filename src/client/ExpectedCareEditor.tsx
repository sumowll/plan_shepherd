import { useState, type ReactNode } from 'react';
import { Check, CheckCheck, Plus, Trash2 } from 'lucide-react';
import { SERVICE_CATEGORIES, type ExpectedCareEvent, type Medication, type PersonProfile, type ProviderPreference, type ServiceCategory } from '../shared/contracts';
import { validDate } from '../domain/primitives';
import type { SourceReview } from './reconciliation';
import { createRepeatedCare, previewCareDates, type CareFrequency } from './recurrence';

const categoryNames: Record<ServiceCategory, string> = {
  primary_care: 'Primary care', specialist: 'Specialist', urgent_care: 'Urgent care',
  emergency: 'Emergency care', hospital: 'Hospital stay', outpatient: 'Outpatient care',
  lab: 'Lab work', imaging: 'Imaging', therapy: 'Physical / other therapy', mental_health: 'Mental health',
  preventive: 'Preventive care', prescription: 'Prescription', other: 'Other care',
};
const money = (cents: number | null | undefined) => cents == null ? 'Unknown price' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const niceDate = (date: string) => validDate(date) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : 'Date unknown';
const centsFromInput = (value: string) => value.trim() === '' ? null : Math.round(Number(value) * 100);

function Field({ id, label, hint, error, children, wide = false }: { id: string; label: string; hint?: string; error?: string; children: ReactNode; wide?: boolean }) {
  return <div className={`field${wide ? ' field-wide' : ''}`}>
    <label className="field-label" htmlFor={id}>{label}</label>
    {children}
    {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
    {error && <span className="field-error" id={`${id}-error`}>{error}</span>}
  </div>;
}

export interface ExpectedCareEditorProps {
  item: ExpectedCareEvent;
  index: number;
  profile: PersonProfile;
  providers: ProviderPreference[];
  medications: Medication[];
  sourceReview?: SourceReview;
  onChange: (patch: Partial<ExpectedCareEvent>) => void;
  onRemove: () => void;
  onResolveSource: (useLatest: boolean) => void;
  onRepeat: (additions: ExpectedCareEvent[]) => boolean | void;
}

export function ExpectedCareEditor({ item, index, profile, providers, medications, sourceReview, onChange, onRemove, onResolveSource, onRepeat }: ExpectedCareEditorProps) {
  const prefix = `care-item-${item.id}`;
  const prescription = item.category === 'prescription';
  const [frequency, setFrequency] = useState<CareFrequency>('monthly');
  const [intervalDays, setIntervalDays] = useState('30');
  const [repeatEnd, setRepeatEnd] = useState(profile.coverageEnd);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [addedMessage, setAddedMessage] = useState('');
  const errors: Record<string, string> = {};
  if (!item.label.trim()) errors.description = 'Enter a short description of this care.';
  if (!validDate(item.date)) errors.date = 'Enter a valid expected date.';
  else if (!validDate(profile.coverageStart) || !validDate(profile.coverageEnd) || profile.coverageStart > profile.coverageEnd) errors.date = 'Set valid coverage start and end dates in Your coverage first.';
  else if (item.date < profile.coverageStart || item.date > profile.coverageEnd) errors.date = `Choose a date from ${niceDate(profile.coverageStart)} through ${niceDate(profile.coverageEnd)}.`;
  if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 10000) errors.quantity = 'Enter a quantity greater than 0 and no more than 10,000.';
  if (prescription && item.quantity !== 1) errors.quantity = 'Use exactly 1 fill per care item. Use Repeat this care to add later fills.';
  if (item.dispensedQuantity != null && (!Number.isFinite(item.dispensedQuantity) || item.dispensedQuantity <= 0 || item.dispensedQuantity > 100000)) errors.dispensed = 'Enter an amount greater than 0 and no more than 100,000, or leave it blank.';
  if (item.daysSupply != null && (!Number.isInteger(item.daysSupply) || item.daysSupply < 1 || item.daysSupply > 366)) errors.supply = 'Enter a whole number from 1 to 366 days, or leave it blank.';
  if (item.unitPriceCents != null && (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0)) errors.price = 'Enter a valid cost of $0 or more, or leave it blank if unknown.';
  if (item.balanceBillingCents != null && (!Number.isSafeInteger(item.balanceBillingCents) || item.balanceBillingCents < 0)) errors.balance = 'Enter a valid balance bill of $0 or more, or leave it blank if unknown.';
  if (sourceReview) errors.source = 'Review the source changes above: use the latest details or keep your current scenario.';

  const fieldProps = (key: string, hint = false) => ({ id: `${prefix}-${key}`, 'aria-invalid': Boolean(errors[key]), 'aria-describedby': [hint ? `${prefix}-${key}-hint` : '', errors[key] ? `${prefix}-${key}-error` : ''].filter(Boolean).join(' ') || undefined });
  const change = (patch: Partial<ExpectedCareEvent>) => { setPreviewKey(null); setAddedMessage(''); onChange({ ...patch, confirmed: false }); };
  const recurrence = { startDate: item.date, endDate: repeatEnd, coverageStart: profile.coverageStart, coverageEnd: profile.coverageEnd, frequency, intervalDays: Number(intervalDays) };
  const repeatPreview = previewCareDates(recurrence);
  // Any source, coverage or care change requires a fresh preview before adding.
  const currentPreviewKey = JSON.stringify({ recurrence, item, sourceReview });
  const previewVisible = previewKey === currentPreviewKey;
  const hasErrors = Object.keys(errors).length > 0;

  return <article id={prefix} className={`care-event ${item.confirmed ? 'care-event-confirmed' : ''}`} aria-labelledby={`${prefix}-title`}>
    <div className="care-event-top">
      <span className="event-number">{String(index + 1).padStart(2, '0')}</span>
      <strong id={`${prefix}-title`}>{item.label || 'New expected care'}</strong>
      {item.sourceEventIds?.length ? <span className="draft-tag">From your history</span> : null}
      <button type="button" className="button button-quiet" aria-label={`Remove care item ${index + 1}`} onClick={onRemove}><Trash2 size={16} aria-hidden="true" /> Remove</button>
    </div>
    {sourceReview && <div id={`${prefix}-source`} className="source-review" role="group" tabIndex={-1} aria-label={`Source changes for care item ${index + 1}`}>
      <strong>Source changes need your review</strong><p>{sourceReview.reason}</p>
      {sourceReview.details?.map((detail, detailIndex) => <p key={detailIndex}>{detail}</p>)}
      {sourceReview.latest ? <p>Latest source: {sourceReview.latest.label} · {niceDate(sourceReview.latest.date)} · quantity {sourceReview.latest.quantity} · {money(sourceReview.latest.unitPriceCents)} per item. Using these details replaces your current care fields.</p> : <p>No single completed source item is available to refresh this scenario. Keep it only if you still expect this care, or remove it.</p>}
      <div className="inline-actions">
        {sourceReview.latest && <button type="button" className="button button-secondary" onClick={() => onResolveSource(true)}>Use latest source details</button>}
        <button type="button" className="button button-quiet" onClick={() => onResolveSource(false)}>Keep my current scenario</button>
      </div>
      <p id={`${prefix}-source-error`} className="field-error">{errors.source}</p>
    </div>}
    <div className="form-grid event-grid">
      <Field id={`${prefix}-description`} label="Description" error={errors.description} wide>
        <input {...fieldProps('description')} value={item.label} maxLength={200} placeholder="For example, annual primary care visit" onChange={event => change({ label: event.target.value })} />
      </Field>
      <Field id={`${prefix}-category`} label="Type of care">
        <select {...fieldProps('category')} value={item.category} onChange={event => change({ category: event.target.value as ServiceCategory, quantityUnit: event.target.value === 'prescription' ? 'fill' : 'service', ...(event.target.value === 'prescription' ? { quantity: 1 } : {}) })}>
          {SERVICE_CATEGORIES.map(category => <option key={category} value={category}>{categoryNames[category]}</option>)}
        </select>
      </Field>
      <Field id={`${prefix}-date`} label="Expected date" hint="Choose a date or type the month, day and four-digit year in the order shown." error={errors.date}>
        <input {...fieldProps('date', true)} type="date" min={profile.coverageStart} max={profile.coverageEnd} value={item.date} onChange={event => change({ date: event.target.value })} />
      </Field>
      <Field id={`${prefix}-quantity`} label={prescription ? 'Fills in this item' : 'Quantity'} hint={prescription ? 'Use one fill per dated care item. Repeat this care to add later fills.' : undefined} error={errors.quantity}>
        <input {...fieldProps('quantity', prescription)} type="number" min={prescription ? 1 : 0} max={prescription ? 1 : 10000} step={prescription ? '1' : 'any'} value={item.quantity || ''} onChange={event => change({ quantity: Number(event.target.value) })} />
      </Field>
      <Field id={`${prefix}-provider`} label="Provider">
        <select {...fieldProps('provider')} value={item.providerId ?? ''} onChange={event => change({ providerId: event.target.value || undefined })}>
          <option value="">Not specified</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </Field>
      {prescription && <Field id={`${prefix}-medication`} label="Prescription">
        <select {...fieldProps('medication')} value={item.medicationId ?? ''} onChange={event => change({ medicationId: event.target.value || undefined })}>
          <option value="">Choose a prescription</option>{medications.map(medication => <option key={medication.id} value={medication.id}>{medication.name}</option>)}
        </select>
      </Field>}
      {(prescription || errors.dispensed) && <Field id={`${prefix}-dispensed`} label="Quantity dispensed per fill" error={errors.dispensed}>
        <input {...fieldProps('dispensed')} type="number" min="0" max="100000" step="any" value={item.dispensedQuantity ?? ''} placeholder="For example, 30" onChange={event => change({ dispensedQuantity: event.target.value ? Number(event.target.value) : undefined })} />
      </Field>}
      {(prescription || errors.supply) && <Field id={`${prefix}-supply`} label="Days supplied per fill" error={errors.supply}>
        <input {...fieldProps('supply')} type="number" min="1" max="366" step="1" value={item.daysSupply ?? ''} placeholder="For example, 30" onChange={event => change({ daysSupply: event.target.value ? Number(event.target.value) : undefined })} />
      </Field>}
    </div>
    <details className="advanced-details">
      <summary>Optional cost and service details</summary>
      <p>You can leave these blank. Unknown costs stay marked as unknown in your comparison.</p>
      <div className="form-grid event-grid">
        {!prescription && <Field id={`${prefix}-service`} label="Service code (if known)" hint="A CPT or HCPCS code identifies a medical service. Your provider may list it on an estimate or bill.">
          <input {...fieldProps('service', true)} value={item.serviceCode ?? ''} placeholder="CPT / HCPCS, optional" maxLength={30} onChange={event => change({ serviceCode: event.target.value || undefined })} />
        </Field>}
        <Field id={`${prefix}-price`} label={prescription ? 'Estimated cost per fill' : 'Estimated cost per item'} hint={item.priceBasis === 'historical' ? 'From your history; future prices may differ.' : 'Before insurance. Leave blank if unknown.'} error={errors.price}>
          <div className="input-prefix"><span aria-hidden="true">$</span><input {...fieldProps('price', true)} type="number" min="0" step="0.01" placeholder="Unknown" value={item.unitPriceCents == null ? '' : item.unitPriceCents / 100} onChange={event => change({ unitPriceCents: centsFromInput(event.target.value), priceBasis: 'user_estimate' })} /></div>
        </Field>
        <Field id={`${prefix}-price-type`} label="What does this price represent?" hint="An allowed amount is the price your insurer agrees to use for covered care. Only an allowed amount can be used to estimate covered care here. A billed charge is the provider’s asking price; a cash price is what you pay without insurance.">
          <select {...fieldProps('price-type', true)} value={item.priceType ?? ''} onChange={event => change({ priceType: event.target.value as ExpectedCareEvent['priceType'] || undefined })}>
            <option value="">Not sure</option><option value="allowed">Insurer’s allowed amount</option><option value="cash">Cash / self-pay price</option><option value="billed">Provider’s billed charge</option>
          </select>
        </Field>
        <Field id={`${prefix}-balance`} label="Additional balance bill" hint="An extra amount a provider says you owe beyond your plan’s allowed amount. Enter the total for this care item only if known." error={errors.balance}>
          <div className="input-prefix"><span aria-hidden="true">$</span><input {...fieldProps('balance', true)} type="number" min="0" step="0.01" placeholder="Unknown" value={item.balanceBillingCents == null ? '' : item.balanceBillingCents / 100} onChange={event => change({ balanceBillingCents: centsFromInput(event.target.value) ?? undefined })} /></div>
        </Field>
      </div>
    </details>
    {hasErrors && <div id={`${prefix}-errors`} className="care-errors" role="status">
      <strong>Before you can confirm this care:</strong>
      <ul>{Object.entries(errors).map(([key, message]) => <li key={key}><a href={`#${prefix}-${key}`} onClick={event => {
        event.preventDefault();
        const target = document.getElementById(`${prefix}-${key}`);
        const details = target?.closest('details');
        if (details) details.open = true;
        target?.focus();
        target?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }}>{message}</a></li>)}</ul>
    </div>}
    <div className="event-confirm">
      <span>{item.confirmed ? <><CheckCheck size={15} aria-hidden="true" /> Ready for your comparison</> : 'Review this item before including it.'}</span>
      <button type="button" className={`button ${item.confirmed ? 'button-confirmed' : 'button-secondary'}`} disabled={hasErrors} aria-describedby={hasErrors ? `${prefix}-errors` : undefined} onClick={() => onChange({ confirmed: !item.confirmed })}>
        <Check size={15} aria-hidden="true" />{item.confirmed ? 'Confirmed' : 'Confirm this care'}
      </button>
    </div>
    <details className="advanced-details repeat-care">
      <summary>Repeat this care</summary>
      <p>For regular appointments or prescription refills, review the dates below before adding them. This item is the first visit or fill. Each new item will need your confirmation.</p>
      <div className="form-grid">
        <Field id={`${prefix}-frequency`} label="How often?">
          <select id={`${prefix}-frequency`} value={frequency} onChange={event => { setFrequency(event.target.value as CareFrequency); setPreviewKey(null); setAddedMessage(''); }}>
            <option value="monthly">Every month</option><option value="weekly">Every week</option><option value="every_n_days">Every number of days</option>
          </select>
        </Field>
        {frequency === 'every_n_days' && <Field id={`${prefix}-interval`} label="Days between visits or fills">
          <input id={`${prefix}-interval`} type="number" min="1" max="366" step="1" value={intervalDays} onChange={event => { setIntervalDays(event.target.value); setPreviewKey(null); setAddedMessage(''); }} />
        </Field>}
        <Field id={`${prefix}-repeat-end`} label="Last date for repeats" hint="Choose a date or type the month, day and four-digit year in the order shown. Repeats stay within your coverage dates.">
          <input id={`${prefix}-repeat-end`} type="date" min={item.date || profile.coverageStart} max={profile.coverageEnd} value={repeatEnd} aria-describedby={`${prefix}-repeat-end-hint`} onChange={event => { setRepeatEnd(event.target.value); setPreviewKey(null); setAddedMessage(''); }} />
        </Field>
      </div>
      {frequency === 'monthly' && <p className="field-hint">Repeats use the same day of each month, or the last day when a month is shorter.</p>}
      {hasErrors && <p id={`${prefix}-repeat-blocked`} className="field-error">Complete the items listed above before repeating this care.</p>}
      <button type="button" className="button button-secondary" disabled={hasErrors} aria-describedby={hasErrors ? `${prefix}-errors ${prefix}-repeat-blocked` : undefined} onClick={() => { setPreviewKey(currentPreviewKey); setAddedMessage(''); }}>Preview repeat dates</button>
      {previewVisible && <div className="recurrence-preview" aria-live="polite">
        {repeatPreview.error ? <p className="field-error" role="alert">{repeatPreview.error}</p> : <>
          <p><strong>{repeatPreview.dates.length} new {repeatPreview.dates.length === 1 ? 'care item' : 'care items'}</strong>, plus this original item on {niceDate(item.date)}.</p>
          <ol aria-label="Dates for new care items">{repeatPreview.dates.map(date => <li key={date}><time dateTime={date}>{niceDate(date)}</time></li>)}</ol>
          <p>New items reuse this item’s provider, prescription and amounts. Copied prices are estimates for future care and may change.</p>
          <p>Review these dates for duplicates with any care already in your list. Edit or remove individual items after adding them.</p>
          <button type="button" className="button button-primary" onClick={() => {
            if (hasErrors || repeatPreview.error || !previewVisible) return;
            const added = onRepeat(createRepeatedCare(item, repeatPreview.dates));
            if (added === false) { setAddedMessage('No new items were added. Review the message above.'); return; }
            setPreviewKey(null);
            setAddedMessage(`Added ${repeatPreview.dates.length} care ${repeatPreview.dates.length === 1 ? 'item' : 'items'}. Review and confirm each new item below.`);
          }}><Plus size={16} aria-hidden="true" />Add {repeatPreview.dates.length} repeated {repeatPreview.dates.length === 1 ? 'item' : 'items'}</button>
        </>}
      </div>}
      {addedMessage && <p role="status">{addedMessage}</p>}
    </details>
  </article>;
}
