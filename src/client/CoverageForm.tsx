import { cloneElement, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ArrowRight, ChevronDown, LockKeyhole, Users } from 'lucide-react';
import type { PersonProfile } from '../shared/contracts';

const states = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
const dateHelp = 'Type the month, day, and four-digit year in the format shown, or use the calendar button.';
type Control = HTMLInputElement | HTMLSelectElement;
type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };
type Errors = Record<string, string>;

function Field({ name, label, hint, required, error, children }: {
  name: string; label: string; hint?: string; required?: boolean; error?: string; children: ReactElement<ControlProps>;
}) {
  const id = `coverage-${name}`;
  return <div className="field">
    <div className="field-label"><label htmlFor={id}>{label}</label> <span className="field-requirement">{required ? 'Required' : 'Optional'}</span></div>
    {cloneElement(children, { id, 'aria-describedby': [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined, 'aria-invalid': Boolean(error) })}
    {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
    {error && <span className="field-error" id={`${id}-error`}>{error}</span>}
  </div>;
}

function TriSelect({ value, onChange, ...props }: ControlProps & {
  value: 'yes' | 'no' | 'unknown'; onChange: (value: 'yes' | 'no' | 'unknown') => void;
}) {
  return <select {...props} value={value} onChange={event => onChange(event.target.value as 'yes' | 'no' | 'unknown')}>
    <option value="unknown">Not sure yet</option><option value="yes">Yes</option><option value="no">No</option>
  </select>;
}

function inputError(control: Control): string | undefined {
  if (control.disabled || control.validity.valid) return undefined;
  if (control.validity.badInput) return control instanceof HTMLInputElement && control.type === 'date' ? 'Enter a complete, valid date.' : 'Enter a number.';
  if (control.validity.valueMissing) return control instanceof HTMLSelectElement ? 'Choose an option to continue.' : 'Complete this field to continue.';
  if (control.validity.patternMismatch) return 'Enter all five digits of your ZIP code.';
  if (control instanceof HTMLInputElement) {
    if (control.type === 'date') {
      if (control.id === 'coverage-dateOfBirth') return 'Enter a birth date from 1900 up to the day your coverage begins.';
      if (control.id === 'coverage-employerOfferEnd') return 'The offer must end on or after it begins.';
      if (control.id === 'coverage-employerOfferStart') return 'The offer must begin on or before it ends.';
      return 'Choose dates in 2026, with coverage ending on or after it begins.';
    }
    if (control.validity.rangeUnderflow || control.validity.rangeOverflow) return `Enter an amount from ${control.min} to ${control.max}.`;
    if (control.validity.stepMismatch) return control.step === '1' ? 'Enter a whole number.' : 'Enter dollars and cents, with no more than two decimal places.';
  }
  return 'Check this entry before continuing.';
}

function revealAndFocus(control: HTMLElement | HTMLSelectElement) {
  let parent = control.parentElement;
  while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
  control.focus();
}

export function CoverageForm({ profile, onChange, counties, countyBusy, countyError, onRetryCounties, onContinue }: {
  profile: PersonProfile;
  onChange: <K extends keyof PersonProfile>(key: K, value: PersonProfile[K]) => void;
  counties: { fips: string; name: string }[];
  countyBusy: boolean;
  countyError: boolean;
  onRetryCounties: () => void;
  onContinue: () => void;
}) {
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Recheck reported errors after dependent limits change or follow-up fields disappear.
    setErrors(current => {
      const next: Errors = {};
      for (const [id, previous] of Object.entries(current)) {
        const control = formRef.current?.querySelector(`#${id}`);
        if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;
        const error = id === 'coverage-countyFips' && (countyError || countyBusy || !profile.countyFips)
          ? previous : inputError(control);
        if (error) next[id] = error;
      }
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [profile, countyBusy, countyError]);
  const cents = (value: string) => value.trim() === '' ? null : Math.round(Number(value) * 100);
  function checkField(control: Control) {
    const error = inputError(control);
    setErrors(current => { const next = { ...current }; if (error) next[control.id] = error; else delete next[control.id]; return next; });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Errors = {};
    for (const control of Array.from(event.currentTarget.elements)) {
      if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;
      const error = inputError(control);
      if (error) next[control.id] = error;
    }
    if (!profile.countyFips || countyBusy || countyError || !counties.some(county => county.fips === profile.countyFips)) {
      next['coverage-countyFips'] = countyError ? 'Retry the county list, then choose your county.' : countyBusy ? 'Wait for the county list to load, then choose your county.' : 'Choose your state and county to continue.';
    }
    setErrors(next); setSubmitted(true);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => summaryRef.current?.focus());
    } else onContinue();
  }
  const field = (name: keyof PersonProfile, label: string, children: ReactElement<ControlProps>, hint?: string, required = false) =>
    <Field name={name} label={label} hint={hint} required={required} error={errors[`coverage-${name}`]}>{children}</Field>;
  return <form ref={formRef} autoComplete="off" noValidate className="card profile-card" onSubmit={submit}
    onBlurCapture={event => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) checkField(event.target); }}
    onChangeCapture={event => { if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) && errors[event.target.id]) checkField(event.target); }}>
    <div className="card-heading"><span className="section-icon"><Users size={20} /></span><div><h2>A few essentials</h2><p>For the person choosing coverage.</p></div><span className="section-count">01 / 04</span></div>
    <p className="form-introduction">Start with the required details below. You can leave optional questions unanswered and return to them later.</p>
    {submitted && Object.keys(errors).length > 0 && <div className="form-error-summary notice notice-warning" role="alert" tabIndex={-1} ref={summaryRef}>
      <div><strong>Please check these details to continue.</strong><ul>{Object.entries(errors).map(([id, error]) => <li key={id}><a href={`#${id}`} onClick={event => {
        event.preventDefault();
        const control = document.getElementById(id);
        if (control instanceof HTMLSelectElement && control.disabled) {
          const fallback = document.getElementById(countyError ? 'coverage-retry-counties' : 'coverage-state');
          if (fallback) revealAndFocus(fallback);
        } else if (control) revealAndFocus(control);
      }}>{error} ({({ 'coverage-dateOfBirth': 'Date of birth', 'coverage-state': 'State', 'coverage-zip': 'ZIP code', 'coverage-countyFips': 'County', 'coverage-coverageStart': 'Coverage begins', 'coverage-coverageEnd': 'Coverage ends', 'coverage-householdSize': 'People in your tax household', 'coverage-annualIncomeCents': 'Annual household income', 'coverage-employerMonthlyContributionCents': 'Employer coverage cost', 'coverage-employerOfferStart': 'Offer begins', 'coverage-employerOfferEnd': 'Offer ends' } as Record<string, string>)[id] ?? 'Optional details'})</a></li>)}</ul></div>
    </div>}
    <section className="coverage-group" aria-labelledby="coverage-about-title"><h3 id="coverage-about-title">1. About you</h3>
      <div className="form-grid">
        {field('dateOfBirth', 'Date of birth', <input type="date" value={profile.dateOfBirth} max={profile.coverageStart || '2026-12-31'} min="1900-01-01" required onChange={event => onChange('dateOfBirth', event.target.value)} />, `${dateHelp} For example, February 3, 1950 is 02/03/1950 in month/day/year format.`, true)}
      </div>
    </section>
    <section className="coverage-group" aria-labelledby="coverage-location-title"><h3 id="coverage-location-title">2. Where you live</h3><p className="field-hint">Plans available to you depend on your home address.</p>
      <div className="form-grid">
        {field('state', 'State', <select required value={profile.state} onChange={event => onChange('state', event.target.value)}><option value="">Choose your state</option>{states.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>, undefined, true)}
        {field('zip', 'ZIP code', <input inputMode="numeric" value={profile.zip} placeholder="For example, 02144" required pattern="[0-9]{5}" maxLength={5} onChange={event => onChange('zip', event.target.value)} />, 'Enter your five-digit home ZIP code.', true)}
        {field('countyFips', 'County', <select value={profile.countyFips} required disabled={!profile.state || countyBusy || countyError} onChange={event => onChange('countyFips', event.target.value)}><option value="">{countyBusy ? 'Loading counties…' : !profile.state ? 'Choose a state first' : countyError ? 'County list unavailable' : 'Choose your county'}</option>{counties.map(county => <option key={county.fips} value={county.fips}>{county.name}</option>)}</select>, countyError ? 'The county list could not be loaded. Use Retry counties below.' : 'Choose the county where you live.', true)}
      </div>
      {countyError && <button id="coverage-retry-counties" type="button" className="button button-secondary" onClick={onRetryCounties}>Retry counties</button>}
    </section>
    <section className="coverage-group" aria-labelledby="coverage-dates-title"><h3 id="coverage-dates-title">3. When you need coverage</h3><p className="field-hint">This comparison covers 2026. Change the dates if you need only part of the year.</p>
      <div className="form-grid">
        {field('coverageStart', 'Coverage begins', <input type="date" min="2026-01-01" max={profile.coverageEnd && profile.coverageEnd < '2026-12-31' ? profile.coverageEnd : '2026-12-31'} required value={profile.coverageStart} onChange={event => onChange('coverageStart', event.target.value)} />, dateHelp, true)}
        {field('coverageEnd', 'Coverage ends', <input type="date" min={profile.coverageStart > '2026-01-01' ? profile.coverageStart : '2026-01-01'} max="2026-12-31" required value={profile.coverageEnd} onChange={event => onChange('coverageEnd', event.target.value)} />, `${dateHelp} For example, January 31, 1955.`, true)}
      </div>
    </section>
    <section className="coverage-group" aria-labelledby="coverage-medicare-title"><h3 id="coverage-medicare-title">4. Your Medicare coverage</h3><p className="field-hint">If you have Medicare, check your Medicare card for Part A and Part B. It is fine to choose “Not sure yet.”</p>
      <div className="form-grid">
        {field('medicarePartA', 'Are you enrolled in Medicare Part A?', <TriSelect value={profile.medicarePartA} onChange={value => onChange('medicarePartA', value)} />, 'Part A is hospital insurance.')}
        {field('medicarePartB', 'Are you enrolled in Medicare Part B?', <TriSelect value={profile.medicarePartB} onChange={value => onChange('medicarePartB', value)} />, 'Part B is medical insurance, including doctor visits.')}
      </div>
    </section>
    <details className="form-details"><summary>Your household <span className="field-requirement">Optional</span><ChevronDown size={17} /></summary>
      <p className="field-hint">These answers help check whether you may qualify for financial help. A tax household usually includes you, your spouse, and anyone you claim on your tax return.</p>
      <div className="form-grid">
        {field('householdSize', 'People in your tax household', <input type="number" min="1" max="30" step="1" required value={profile.householdSize || ''} onChange={event => onChange('householdSize', Number(event.target.value))} />, 'Starts at 1 for you. Update it if your tax household includes others.')}
        {field('annualIncomeCents', 'Expected annual household income', <input type="number" min="0" max="1000000000" step="0.01" value={profile.annualIncomeCents == null ? '' : profile.annualIncomeCents / 100} placeholder="Annual income in dollars" onChange={event => onChange('annualIncomeCents', cents(event.target.value))} />, 'Enter dollars for the whole year, before taxes. Leave blank if you’re unsure; enter 0 only if you expect no income.')}
        {field('taxFilingStatus', 'Tax filing status', <select value={profile.taxFilingStatus ?? 'unknown'} onChange={event => onChange('taxFilingStatus', event.target.value as PersonProfile['taxFilingStatus'])}><option value="unknown">Not sure yet</option><option value="single">Single</option><option value="joint">Married filing jointly</option><option value="separate">Married filing separately</option><option value="head_of_household">Head of household</option></select>)}
        {field('claimedAsDependent', 'Will someone claim you as a dependent?', <TriSelect value={profile.claimedAsDependent ?? 'unknown'} onChange={value => onChange('claimedAsDependent', value)} />, 'For example, someone may include you as a dependent on their tax return.')}
      </div>
    </details>
    <details className="form-details"><summary>Coverage through work <span className="field-requirement">Optional</span><ChevronDown size={17} /></summary>
      <p className="field-hint">Include coverage available through your job or a household member’s job.</p>
      <div className="form-grid">
        {field('employerOffer', 'Is employer coverage offered to you?', <TriSelect value={profile.employerOffer} onChange={value => onChange('employerOffer', value)} />)}
        {profile.employerOffer === 'yes' && <>
          {field('employerOfferRelationship', 'Whose employment provides the offer?', <select value={profile.employerOfferRelationship ?? 'unknown'} onChange={event => onChange('employerOfferRelationship', event.target.value as PersonProfile['employerOfferRelationship'])}><option value="unknown">Not sure / not applicable</option><option value="self">My employment</option><option value="household_member">A household member’s employment</option></select>)}
          {field('employerMonthlyContributionCents', 'Your monthly cost for employer coverage', <input type="number" min="0" max="1000000000" step="0.01" value={profile.employerMonthlyContributionCents == null ? '' : profile.employerMonthlyContributionCents / 100} placeholder="Monthly cost in dollars" onChange={event => onChange('employerMonthlyContributionCents', cents(event.target.value))} />, 'Enter the monthly amount you would pay for the applicable offer. Check the employer’s benefits information. Leave blank if unknown.')}
          {field('employerMinimumValue', 'Does the plan meet minimum value?', <TriSelect value={profile.employerMinimumValue} onChange={value => onChange('employerMinimumValue', value)} />, '“Minimum value” is a coverage standard used when checking financial help. Look for this phrase in the employer’s Summary of Benefits and Coverage, or ask the benefits office.')}
          {field('employerOfferStart', 'Offer begins (if known)', <input type="date" max={profile.employerOfferEnd} value={profile.employerOfferStart ?? ''} onChange={event => onChange('employerOfferStart', event.target.value || undefined)} />, dateHelp)}
          {field('employerOfferEnd', 'Offer ends (if known)', <input type="date" min={profile.employerOfferStart} value={profile.employerOfferEnd ?? ''} onChange={event => onChange('employerOfferEnd', event.target.value || undefined)} />, dateHelp)}
        </>}
      </div>
    </details>
    <details className="form-details"><summary>Other enrollment details <span className="field-requirement">Optional</span><ChevronDown size={17} /></summary>
      <p className="field-hint">These answers help explain your enrollment options. Leave “Not sure yet” selected when you do not know.</p>
      <div className="form-grid">
        {field('citizenshipEligible', 'Citizenship or immigration requirement', <TriSelect value={profile.citizenshipEligible} onChange={value => onChange('citizenshipEligible', value)} />, 'Do you meet the citizenship or immigration requirement for the coverage you are considering? Choose “Not sure yet” if you need help checking.')}
        {field('incarcerated', 'Are you currently incarcerated?', <TriSelect value={profile.incarcerated} onChange={value => onChange('incarcerated', value)} />)}
        {field('enrollmentEvent', 'Enrollment circumstance', <select value={profile.enrollmentEvent} onChange={event => onChange('enrollmentEvent', event.target.value as PersonProfile['enrollmentEvent'])}><option value="unknown">Not sure yet</option><option value="open_enrollment">Open enrollment</option><option value="loss_of_coverage">Losing other coverage</option><option value="other">Another enrollment event</option></select>, 'Open enrollment is the regular sign-up period. Losing coverage or another qualifying change may create a different chance to enroll.')}
        {field('tobacco', 'Tobacco use', <select value={profile.tobacco} onChange={event => onChange('tobacco', event.target.value as PersonProfile['tobacco'])}><option value="no">No</option><option value="yes">Yes</option></select>)}
      </div>
    </details>
    <div className="form-footer"><span><LockKeyhole size={14} /> Only used in this session</span><button className="button button-primary" type="submit">Complete and continue <ArrowRight size={17} /></button></div>
  </form>;
}
