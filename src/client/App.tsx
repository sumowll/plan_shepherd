import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown,
  CircleHelp, ClipboardList, ExternalLink, FileHeart, Heart, Layers3, Leaf,
  LoaderCircle, LockKeyhole, MapPin, MessageCircle, Plus, Search,
  SlidersHorizontal, Sparkles, Stethoscope, Users, X,
} from 'lucide-react';
import type {
  AiProposal, AppStatus, AssistantReply, BenefitRule, CatalogSearch, ChatMessage,
  ComparisonResult, ConditionConfirmation, ConnectorStatus, EligibilityResult, Evidence, ExpectedCareEvent,
  HistoricalEvent, ImportResult, Medication, PersonProfile, Plan, PlanFamily,
  ProviderPreference, ServiceCategory, SourceRef,
} from '../shared/contracts';
import { PLAN_FAMILIES, SERVICE_CATEGORIES } from '../shared/contracts';
import { buildForecast, evaluateEligibility, normalizeHistory } from '../domain/index';
import { validDate } from '../domain/primitives';
import { connectPatient, resetPatientSession } from './oauth';
import { MedicationEditor, ProviderEditor } from './RecordEditors';
import { ConditionReview } from './ConditionReview';
import { ConnectionDirectory, type ConnectionImport } from './ConnectionDirectory';
import { mergeRecords, reconcileForecast, providerFields, medicationFields, type ImportBaseline, type SourceReview } from './reconciliation';
import { CoverageForm } from './CoverageForm';
import { MedicarePremiums } from './MedicarePremiums';
import { ExpectedCareEditor } from './ExpectedCareEditor';
import { HelpGuide } from './HelpGuide';
import { ComparisonOverview } from './ComparisonOverview';
import './styles.css';
import './accessibility.css';

const YEAR = 2026;
const familyNames: Record<PlanFamily, string> = { aca: 'ACA plans', short_term: 'Short-term plans', medicare_advantage: 'Medicare Advantage' };
const categoryNames: Record<ServiceCategory, string> = {
  primary_care: 'Primary care', specialist: 'Specialist', urgent_care: 'Urgent care',
  emergency: 'Emergency care', hospital: 'Hospital stay', outpatient: 'Outpatient care',
  lab: 'Lab work', imaging: 'Imaging', therapy: 'Physical / other therapy', mental_health: 'Mental health',
  preventive: 'Preventive care', prescription: 'Prescription', other: 'Other care',
};
const stateNames = [
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
const steps = [
  { title: 'Your coverage', detail: 'Start with the essentials', icon: Users },
  { title: 'Your care', detail: 'Providers & prescriptions', icon: Heart },
  { title: 'The year ahead', detail: 'Your expected care', icon: ClipboardList },
  { title: 'Compare plans', detail: 'See the complete picture', icon: Layers3 },
];
const emptyProfile = (): PersonProfile => ({
  dateOfBirth: '', state: '', countyFips: '', zip: '', householdSize: 1, annualIncomeCents: null,
  employerOffer: 'unknown', employerMonthlyContributionCents: null, employerMinimumValue: 'unknown',
  medicarePartA: 'unknown', medicarePartB: 'unknown', tobacco: 'no', coverageStart: `${YEAR}-01-01`,
  coverageEnd: `${YEAR}-12-31`, citizenshipEligible: 'unknown', incarcerated: 'unknown',
  enrollmentEvent: 'unknown', taxFilingStatus: 'unknown', claimedAsDependent: 'unknown', employerOfferRelationship: 'unknown',
});
const money = (cents: number | null | undefined, fallback = 'Not available') => cents == null
  ? fallback : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const centsFromInput = (value: string) => value.trim() === '' ? null : Math.round(Number(value) * 100);
const niceDate = (date: string) => date && !Number.isNaN(Date.parse(date))
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(date)) : 'Date unknown';
const titleCase = (text: string) => text.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const safeUrl = (value: string) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
const newId = () => crypto.randomUUID();

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field${wide ? ' field-wide' : ''}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warning' | 'success' }) {
  return <div className={`notice notice-${kind}`}>{kind === 'success' ? <Check size={17} /> : <CircleHelp size={17} />}<div>{children}</div></div>;
}
function StatusBadge({ value }: { value: string }) {
  const labels: Record<string, string> = { in_network: 'In network', out_of_network: 'Out of network', covered: 'Covered', not_covered: 'Not covered', conditional: 'Conditions apply', unknown: 'Unconfirmed', likely_eligible: 'May be eligible', likely_ineligible: 'May not be eligible' };
  return <span className={`status-badge status-${value}`}>{['covered', 'in_network', 'likely_eligible'].includes(value) && <Check size={12} />}{labels[value] ?? titleCase(value)}</span>;
}
function SourceLink({ source }: { source: SourceRef }) {
  const url = safeUrl(source.url);
  return <span className="source-reference">{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.publisher}<ExternalLink size={11} /></a> : <span>{source.publisher}</span>}<span>Version {source.version}{source.location ? ` · ${source.location}` : ''} · Retrieved {niceDate(source.retrievedAt)}</span></span>;
}
function EmptyState({ icon: Icon = Search, title, children, action }: { icon?: typeof Search; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={26} strokeWidth={1.5} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
function Dialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => { ref.current?.close(); }; }, []);
  return <dialog ref={ref} className={`dialog ${className}`} aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-inner"><div className="dialog-top"><span className="eyebrow">{title}</span><button className="icon-button" onClick={onClose} aria-label={`Close ${title}`}><X size={20} /> Close</button></div>{children}</div></dialog>;
}
function BenefitItem({ benefit }: { benefit: BenefitRule }) {
  return <div className="benefit-item"><div className="benefit-name"><strong>{benefit.label}</strong><StatusBadge value={benefit.coverage} /></div><p>{benefit.explanation}</p><div className="benefit-facts"><span>{titleCase(benefit.network)}</span><span>Copay: {money(benefit.copayCents, 'Unknown')}</span><span>Coinsurance: {benefit.coinsuranceBps == null ? 'Unknown' : `${benefit.coinsuranceBps / 100}%`}</span><span>{benefit.appliesDeductible ? 'Deductible applies' : 'No deductible applied'}</span>{benefit.visitLimit != null && <span>{benefit.visitLimit} visit limit</span>}{benefit.waitingDays != null && <span>{benefit.waitingDays}-day waiting period</span>}{benefit.priorAuthorization && <span>Prior authorization</span>}{benefit.referralRequired && <span>Referral required</span>}{benefit.insurerPaymentCapCents != null && <span>Insurer payment cap: {money(benefit.insurerPaymentCapCents)}</span>}</div>{benefit.conditions?.map(condition => <p className="condition-line" key={condition.id}>Condition: {condition.label}</p>)}<SourceLink source={benefit.source} /></div>;
}

export default function App() {
  const [step, setStep] = useState(0);
  const [textSize, setTextSize] = useState('standard');
  const [clearOpen, setClearOpen] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<boolean[]>(() => steps.map(() => false));
  const [undo, setUndo] = useState<{ label: string; restore: () => void } | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [profile, setProfile] = useState<PersonProfile>(emptyProfile);
  const [providers, setProviders] = useState<ProviderPreference[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [history, setHistory] = useState<HistoricalEvent[]>([]);
  const [events, setEvents] = useState<ExpectedCareEvent[]>([]);
  const [importBaselines, setImportBaselines] = useState<Record<string, ImportBaseline>>({});
  const [sourceReviews, setSourceReviews] = useState<Record<string, SourceReview>>({});
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusBusy, setStatusBusy] = useState(true);
  const [statusRetry, setStatusRetry] = useState(0);
  const [imports, setImports] = useState<Record<string, ConnectionImport>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ id: string; name: string; connector: ConnectorStatus; data: ImportResult } | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [importedBirthDate, setImportedBirthDate] = useState<string | null>(null);
  const [counties, setCounties] = useState<{ fips: string; name: string }[]>([]);
  const [countyBusy, setCountyBusy] = useState(false);
  const [countyError, setCountyError] = useState(false);
  const [countyRetry, setCountyRetry] = useState(0);
  const [conditions, setConditions] = useState<ConditionConfirmation[]>([]);
  const [additionalMonthlyPremiums, setAdditionalMonthlyPremiums] = useState<Record<string, number | null>>({});
  const [catalog, setCatalog] = useState<CatalogSearch | null>(null);
  const [detailedPlans, setDetailedPlans] = useState<Record<string, Plan>>({});
  const [catalogPlans, setCatalogPlans] = useState<Record<string, Plan>>({});
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [families, setFamilies] = useState<PlanFamily[]>([...PLAN_FAMILIES]);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<ComparisonResult[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [compareBusy, setCompareBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyNetwork, setOnlyNetwork] = useState(false);
  const [onlyDrugs, setOnlyDrugs] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'warning' | 'success' } | null>(null);
  const [detailPlan, setDetailPlan] = useState<Plan | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [appliedProposals, setAppliedProposals] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [evidenceQuery, setEvidenceQuery] = useState('');
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [medicationFormOpen, setMedicationFormOpen] = useState(false);
  const generation = useRef(0);
  const catalogRequestId = useRef(0);
  const activeRequests = useRef(new Set<AbortController>());
  const mainRef = useRef<HTMLElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const comparisonContext = useRef('');
  const searchContext = useRef('');
  comparisonContext.current = JSON.stringify({ profile, providers, medications, events, conditions, additionalMonthlyPremiums, selected, releaseId: catalog?.releaseId });
  searchContext.current = JSON.stringify({ profile, families });

  const eligibility = useMemo(() => evaluateEligibility(profile), [profile]);
  const connectorNames = useMemo(() => new Map([
    ...Object.values(imports).map(({ connector }) => [connector.id, connector.name] as const),
    ...(status?.connectors ?? []).map(connector => [connector.id, connector.name] as const),
  ]), [status, imports]);
  const sourceName = (source: string) => connectorNames.get(source) ?? source;
  const confirmedEvents = events.filter(event => event.confirmed);
  const pendingEvents = events.length - confirmedEvents.length;
  const profileReady = Boolean(validDate(profile.dateOfBirth) && profile.dateOfBirth >= '1900-01-01' && profile.dateOfBirth <= profile.coverageStart && validDate(profile.coverageStart) && validDate(profile.coverageEnd) && profile.coverageStart >= `${YEAR}-01-01` && profile.coverageEnd <= `${YEAR}-12-31` && profile.coverageStart <= profile.coverageEnd && profile.state && !countyBusy && !countyError && counties.some(county => county.fips === profile.countyFips) && /^\d{5}$/.test(profile.zip));
  const evidence = useMemo(() => Array.from(new Map([
    ...providers.flatMap(item => item.evidence ?? []), ...medications.flatMap(item => item.evidence ?? []),
    ...history.flatMap(item => item.evidence),
  ].map(item => [item.id, item])).values()), [providers, medications, history]);

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    activeRequests.current.add(controller);
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', signal: controller.signal });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        let description = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'This request could not be completed. Please try again.';
        if (error && typeof error === 'object' && 'fields' in error && Array.isArray(error.fields)) {
          description = 'Please review: ' + error.fields.slice(0, 4).map((field: { path?: string; message?: string }) => `${titleCase((field.path ?? '').replaceAll('.', ' ').replace(/([A-Z])/g, ' $1'))} — ${field.message ?? 'Check this value'}`).join('; ');
        }
        throw new Error(description);
      }
      return data as T;
    } finally { activeRequests.current.delete(controller); }
  }

  useEffect(() => {
    let current = true;
    setStatusBusy(true);
    request<AppStatus>('/api/status')
      .then(value => { if (current) { setStatus(value); setStatusError(false); } })
      .catch(() => { if (current) setStatusError(true); })
      .finally(() => { if (current) setStatusBusy(false); });
    return () => { current = false; };
  }, [statusRetry]);

  useEffect(() => {
    let current = true;
    setCounties([]); setCountyError(false);
    if (!profile.state) { setCountyBusy(false); return; }
    setCountyBusy(true);
    request<{ counties: { fips: string; name: string }[] }>(`/api/geography/counties?state=${profile.state}`)
      .then(data => { if (current) setCounties(data.counties); })
      .catch(() => { if (current) setCountyError(true); })
      .finally(() => { if (current) setCountyBusy(false); });
    return () => { current = false; };
  }, [profile.state, countyRetry]);

  useEffect(() => {
    const clear = () => {
      setClearOpen(false); setUndo(null); setCompletedSteps(steps.map(() => false)); setFocusTarget(null);
      generation.current += 1;
      catalogRequestId.current += 1;
      for (const controller of activeRequests.current) controller.abort();
      activeRequests.current.clear();
      setProfile(emptyProfile()); setProviders([]); setMedications([]); setHistory([]); setEvents([]);
      setImportBaselines({}); setSourceReviews({}); setCatalogPlans({}); setCatalogOffset(0); setCatalogQuery('');
      setImports({}); setCatalog(null); setDetailedPlans({}); setSelected([]); setResults([]); setQuery(''); setFamilies([...PLAN_FAMILIES]);
      setConnecting(null); setCatalogBusy(false); setCompareBusy(false); setOnlyNetwork(false); setOnlyDrugs(false);
      setPendingImport(null); setIdentityConfirmed(false); setImportedBirthDate(null); setCounties([]); setCountyBusy(false); setCountyError(false); setConditions([]); setAdditionalMonthlyPremiums({});
      setAssistantOpen(false); setChat([]); setChatInput(''); setAiBusy(false); setAiError(''); setProposals([]); setAppliedProposals([]); setSelectedEvidence([]); setEvidenceQuery('');
      setDetailPlan(null); setProviderFormOpen(false); setMedicationFormOpen(false); setStep(0);
      setMessage({ text: 'Your session has been cleared. Start fresh whenever you’re ready.', kind: 'success' });
    };
    window.addEventListener('plan-shepherd:clear-session', clear);
    return () => { window.removeEventListener('plan-shepherd:clear-session', clear); for (const controller of activeRequests.current) controller.abort(); };
  }, []);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [chat, aiBusy, proposals]);
  useEffect(() => { invalidateStep(0); }, [profile]);
  useEffect(() => { invalidateStep(1); }, [providers, medications, history]);
  useEffect(() => { invalidateStep(2); }, [events, sourceReviews, profile.coverageStart, profile.coverageEnd]);
  useEffect(() => { setResults([]); invalidateStep(3); }, [profile, providers, medications, events, conditions, additionalMonthlyPremiums, selected, catalog?.releaseId]);

  function navigate(next: number) {
    setStep(next); setMessage(null);
    setFocusTarget('main-content');
  }
  function invalidateStep(index: number) {
    setCompletedSteps(current => current[index] ? current.map((complete, stepIndex) => stepIndex === index ? false : complete) : current);
  }
  function completeStep(index: number) {
    if (index === 0 && !profileReady) return;
    if (index === 2 && pendingEvents > 0) {
      reviewCare();
      setMessage({ text: 'Confirm or remove unfinished care items before completing this step.', kind: 'warning' });
      return;
    }
    if (index === 3 && (!results.length || compareBusy || catalogBusy)) return;
    setCompletedSteps(current => current.map((complete, stepIndex) => stepIndex === index || complete));
    if (index < steps.length - 1) navigate(index + 1);
  }
  function updateProfile<K extends keyof PersonProfile>(key: K, value: PersonProfile[K]) {
    setUndo(null);
    if (selected.length) setMessage({ text: 'Your coverage changed. Find plans again so the comparison uses your updated information.', kind: 'info' });
    catalogRequestId.current += 1; setCatalogBusy(false); setCatalogPlans({}); setCatalogOffset(0); setCatalogQuery(''); setQuery('');
    setProfile(current => ({ ...current, [key]: value, ...(key === 'state' ? { countyFips: '' } : {}) })); setCatalog(null); setDetailedPlans({}); setSelected([]); setConditions([]); setAdditionalMonthlyPremiums({});
    clearEventConditions();
  }
  function updateEvent(id: string, patch: Partial<ExpectedCareEvent>) {
    setUndo(null);
    setEvents(current => current.map(event => event.id === id ? { ...event, ...patch, ...(patch.confirmed === false ? { conditions: [] } : {}) } : event));
  }
  function clearEventConditions() {
    setEvents(current => current.some(event => event.conditions?.length) ? current.map(event => ({ ...event, conditions: [] })) : current);
  }
  function updateProvider(changed: ProviderPreference) {
    setUndo(null);
    const previous = providers.find(provider => provider.id === changed.id);
    const identityChanged = previous && (['name', 'npi', 'specialty', 'location'] as const).some(key => previous[key] !== changed[key]);
    setProviders(current => current.map(provider => provider.id === changed.id ? changed : provider));
    if (identityChanged) setMessage({ text: 'Your care details changed. Review any linked care items again before comparing plans.', kind: 'info' });
    if (identityChanged) setEvents(current => current.map(event => event.providerId === changed.id ? { ...event, confirmed: false, conditions: [] } : event));
  }
  function updateMedication(changed: Medication) {
    setUndo(null);
    const previous = medications.find(medication => medication.id === changed.id);
    const identityChanged = previous && (['name', 'rxnorm', 'ndc', 'strength', 'form', 'quantity', 'daysSupply'] as const).some(key => previous[key] !== changed[key]);
    setMedications(current => current.map(medication => medication.id === changed.id ? changed : medication));
    if (identityChanged) setMessage({ text: 'Your care details changed. Review any linked care items again before comparing plans.', kind: 'info' });
    if (identityChanged) setEvents(current => current.map(event => event.medicationId === changed.id ? { ...event, confirmed: false, conditions: [] } : event));
  }
  async function connect(connector: ConnectorStatus) {
    const { id, name } = connector;
    const version = generation.current;
    setConnecting(id); setMessage(null);
    try {
      const data: ImportResult = await connectPatient(id);
      if (version !== generation.current) return;
      setPendingImport({ id, name, connector, data }); setIdentityConfirmed(false);
    } catch (error) { if (version === generation.current) setMessage({ text: error instanceof Error ? error.message : 'The connection could not be completed.', kind: 'warning' }); }
    finally { if (version === generation.current) setConnecting(null); }
  }
  function confirmImport() {
    if (!pendingImport || !identityConfirmed || !profile.dateOfBirth || (importedBirthDate && importedBirthDate !== profile.dateOfBirth) || (pendingImport.data.patient?.dateOfBirth && pendingImport.data.patient.dateOfBirth !== profile.dateOfBirth)) return;
    setUndo(null);
    const { id, data, connector } = pendingImport;
    setImportedBirthDate(profile.dateOfBirth);
    const nextProviders = mergeRecords(providers, data.providers, importBaselines[id]?.providers, providerFields, 'preferred');
    const nextMedications = mergeRecords(medications, data.medications, importBaselines[id]?.medications, medicationFields, 'ongoing');
    const nextHistory = normalizeHistory([...history, ...data.events], data.claimSnapshots);
    const reconciled = reconcileForecast(events, history, nextHistory, nextProviders.changedIds, nextMedications.changedIds, sourceReviews, YEAR, { ...nextProviders.changes, ...nextMedications.changes });
    setProviders(nextProviders.records); setMedications(nextMedications.records); setHistory(nextHistory);
    setImportBaselines(current => ({ ...current, [id]: { providers: nextProviders.baseline, medications: nextMedications.baseline } }));
    setEvents(reconciled.events); setSourceReviews(reconciled.reviews);
    setImports(current => ({ ...current, [id]: { connector, resources: data.resourcesRead, complete: data.complete, warnings: data.warnings } }));
    setMessage({ text: Object.keys(reconciled.reviews).length ? 'Source changes need your review in The year ahead. Your manual corrections and selections have been kept.' : data.complete ? 'Your records are ready to review. Your corrections and selections have been kept.' : 'Some records were imported. Review the notes below before using this history.', kind: Object.keys(reconciled.reviews).length || !data.complete ? 'warning' : 'success' });
    setPendingImport(null); setIdentityConfirmed(false);
  }
  function addProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim(); if (!name) return;
    const provider: ProviderPreference = { id: newId(), name, npi: String(data.get('npi') ?? '').trim() || undefined, specialty: String(data.get('specialty') ?? '').trim() || undefined, location: String(data.get('location') ?? '').trim() || undefined, preferred: true, evidence: [{ id: newId(), source: 'You', method: 'user_entered', confirmed: true }] };
    setProviders(current => [...current, provider]); form.reset(); setProviderFormOpen(false);
  }
  function addMedication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim(); if (!name) return;
    setMedications(current => [...current, { id: newId(), name, strength: String(data.get('strength') ?? '').trim() || undefined, form: String(data.get('form') ?? '').trim() || undefined, rxnorm: String(data.get('rxnorm') ?? '').trim() || undefined, ndc: String(data.get('ndc') ?? '').trim() || undefined, quantity: data.get('quantity') ? Number(data.get('quantity')) : undefined, daysSupply: data.get('daysSupply') ? Number(data.get('daysSupply')) : undefined, ongoing: true, evidence: [{ id: newId(), source: 'You', method: 'user_entered', confirmed: true }] }]);
    form.reset(); setMedicationFormOpen(false);
  }
  function addCare() {
    setEvents(current => [...current, { id: newId(), label: '', category: 'primary_care', date: profile.coverageStart, quantity: 1, unitPriceCents: null, confirmed: false }]);
  }
  function draftForecast() {
    const drafts = buildForecast(history, YEAR);
    const existing = new Set(events.flatMap(event => event.sourceEventIds ?? []));
    const additions = drafts.filter(event => !(event.sourceEventIds ?? []).some(id => existing.has(id)));
    setEvents(current => [...current, ...additions]);
    setMessage({ text: additions.length ? `${additions.length} care ${additions.length === 1 ? 'item is' : 'items are'} ready for review. Adjust dates and quantities, then confirm what you expect to need.` : Object.keys(sourceReviews).length ? 'Review the source changes on your existing care items below. Your current scenario has been preserved.' : 'No new completed care from the prior calendar year is available to carry forward. You can add expected care below.', kind: additions.length ? 'success' : 'info' });
  }
  function resolveSourceReview(eventId: string, useLatest: boolean) {
    const review = sourceReviews[eventId];
    if (!review || (useLatest && !review.latest)) return;
    setEvents(current => current.map(event => event.id === eventId ? useLatest ? { ...review.latest!, id: event.id, confirmed: false, conditions: [] } : { ...event, priceBasis: 'user_estimate', confirmed: false, conditions: [] } : event));
    setSourceReviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== eventId)));
  }
  function removeCare(eventId: string) {
    const removed = events.find(item => item.id === eventId);
    const review = sourceReviews[eventId];
    if (!removed) return;
    setUndo({ label: `${removed.label || 'Care item'} removed.`, restore: () => {
      setEvents(current => current.some(item => item.id === removed.id) ? current : [...current, { ...removed, confirmed: false, conditions: [] }]);
      if (review) setSourceReviews(current => ({ ...current, [eventId]: review }));
    } });
    setEvents(current => current.filter(event => event.id !== eventId));
    setSourceReviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== eventId)));
  }
  function removeProvider(provider: ProviderPreference) {
    const linked = new Set(events.filter(item => item.providerId === provider.id).map(item => item.id));
    setUndo({ label: `${provider.name} removed.`, restore: () => {
      setProviders(current => current.some(item => item.id === provider.id) ? current : [...current, provider]);
      setEvents(current => current.map(item => linked.has(item.id) && !item.providerId ? { ...item, providerId: provider.id, confirmed: false, conditions: [] } : item));
    } });
    setProviders(current => current.filter(item => item.id !== provider.id));
    setEvents(current => current.map(item => item.providerId === provider.id ? { ...item, providerId: undefined, confirmed: false, conditions: [] } : item));
  }
  function removeMedication(medication: Medication) {
    const linked = new Set(events.filter(item => item.medicationId === medication.id).map(item => item.id));
    setUndo({ label: `${medication.name} removed.`, restore: () => {
      setMedications(current => current.some(item => item.id === medication.id) ? current : [...current, medication]);
      setEvents(current => current.map(item => linked.has(item.id) && !item.medicationId ? { ...item, medicationId: medication.id, confirmed: false, conditions: [] } : item));
    } });
    setMedications(current => current.filter(item => item.id !== medication.id));
    setEvents(current => current.map(item => item.medicationId === medication.id ? { ...item, medicationId: undefined, confirmed: false, conditions: [] } : item));
  }
  function reviewCare() {
    navigate(2);
    setFocusTarget(events.find(item => !item.confirmed) ? `care-item-${events.find(item => !item.confirmed)!.id}` : 'main-content');
  }
  useEffect(() => {
    if (!focusTarget) return;
    const target = document.getElementById(focusTarget);
    if (target) {
      target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
      if (focusTarget === 'main-content') window.scrollTo({ top: 0, behavior: 'auto' });
      else target.scrollIntoView({ block: 'start' });
    }
    setFocusTarget(null);
  }, [step, focusTarget]);
  const hasPersonalWork = Boolean(JSON.stringify(profile) !== JSON.stringify(emptyProfile()) || providers.length || medications.length || events.length || chat.length);
  useEffect(() => {
    if (!hasPersonalWork) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPersonalWork]);
  async function searchCatalog(options?: { offset?: number; query?: string; keepRelease?: boolean }) {
    if (!profileReady) { setMessage({ text: 'Review your birth date, location, and 2026 coverage dates in Your coverage first.', kind: 'warning' }); return; }
    if (!families.length) { setMessage({ text: 'Choose at least one coverage category to search.', kind: 'warning' }); return; }
    const version = generation.current; const context = searchContext.current; const requestId = ++catalogRequestId.current;
    const offset = options?.offset ?? 0; const appliedQuery = (options?.query ?? '').trim();
    const releaseId = options?.keepRelease ? catalog?.releaseId ?? undefined : undefined;
    setCatalogBusy(true); setMessage(null);
    if (!options?.keepRelease) { setResults([]); setDetailedPlans({}); setCatalogPlans({}); setCatalog(null); setConditions([]); setAdditionalMonthlyPremiums({}); setSelected([]); setQuery(''); setCatalogQuery(''); setCatalogOffset(0); clearEventConditions(); }
    try {
      const birth = new Date(`${profile.dateOfBirth}T00:00:00Z`); const start = new Date(`${profile.coverageStart}T00:00:00Z`);
      const age = start.getUTCFullYear() - birth.getUTCFullYear() - (start.getUTCMonth() < birth.getUTCMonth() || (start.getUTCMonth() === birth.getUTCMonth() && start.getUTCDate() < birth.getUTCDate()) ? 1 : 0);
      const data = await request<CatalogSearch>('/api/catalog/search', { state: profile.state, countyFips: profile.countyFips, zip: profile.zip, year: YEAR, families, age, dateOfBirth: profile.dateOfBirth, tobacco: profile.tobacco === 'yes', coverageStart: profile.coverageStart, coverageEnd: profile.coverageEnd, limit: 20, offset, query: appliedQuery, releaseId });
      if (version !== generation.current || context !== searchContext.current || requestId !== catalogRequestId.current) return;
      if (releaseId && data.releaseId !== releaseId) throw new Error('This catalog release is no longer available. Choose Find available plans to start a new search.');
      setCatalog(data); setCatalogOffset(offset); setCatalogQuery(appliedQuery);
      setCatalogPlans(current => ({ ...current, ...Object.fromEntries(data.plans.map(plan => [plan.id, plan])) }));
    } catch (error) { if (version === generation.current && context === searchContext.current && requestId === catalogRequestId.current) setMessage({ text: error instanceof Error ? error.message : 'The catalog could not be searched.', kind: 'warning' }); }
    finally { if (version === generation.current && requestId === catalogRequestId.current) setCatalogBusy(false); }
  }
  async function compareSelected() {
    if (!selected.length) return;
    if (selected.some(id => additionalMonthlyPremiums[id] != null && (!Number.isSafeInteger(additionalMonthlyPremiums[id]) || additionalMonthlyPremiums[id]! < 0 || additionalMonthlyPremiums[id]! > 100_000_000_000))) { setMessage({ text: 'Review the other Medicare premiums. Enter a nonnegative monthly amount, or leave it blank if unknown.', kind: 'warning' }); return; }
    if (pendingEvents) { setMessage({ text: `Review and confirm the ${pendingEvents} unfinished care ${pendingEvents === 1 ? 'item' : 'items'} in The year ahead before comparing costs.`, kind: 'warning' }); return; }
    const version = generation.current; const context = comparisonContext.current; setCompareBusy(true); setMessage(null);
    try {
      const data = await request<{ results: ComparisonResult[]; eligibility: EligibilityResult[] }>('/api/compare', { profile, providers, medications, events, conditions, additionalMonthlyPremiums, planIds: selected, releaseId: catalog?.releaseId ?? undefined });
      if (version === generation.current && context === comparisonContext.current) { setDetailedPlans(Object.fromEntries(data.results.map(result => [result.plan.id, result.plan]))); setResults(data.results); requestAnimationFrame(() => document.getElementById('comparison-results')?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })); }
    } catch (error) { if (version === generation.current) setMessage({ text: error instanceof Error ? error.message : 'The plans could not be compared.', kind: 'warning' }); }
    finally { if (version === generation.current) setCompareBusy(false); }
  }
  async function askAssistant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const input = chatInput.trim(); if (!input || aiBusy || chat.length >= 30) return;
    const messages: ChatMessage[] = [...chat, { role: 'user', content: input }];
    const version = generation.current; setChat(messages); setChatInput(''); setAiBusy(true); setAiError('');
    try {
      const reply = await request<AssistantReply>('/api/assistant', { messages, evidence: evidence.filter(item => selectedEvidence.includes(item.id)) });
      if (version === generation.current) { setChat(current => [...current, { role: 'assistant', content: reply.message }]); setProposals(current => [...current, ...reply.proposals]); }
    } catch (error) { if (version === generation.current) setAiError(error instanceof Error ? error.message : 'The assistant could not respond. Your forms are still available.'); }
    finally { if (version === generation.current) setAiBusy(false); }
  }
  function applyProposal(proposal: AiProposal) {
    const value = proposal.value;
    const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : '';
    const proof: Evidence[] = proposal.evidenceIds.map(id => ({ id: newId(), source: evidence.find(item => item.id === id)?.source ?? id, resourceId: id, method: 'ai_proposed', confirmed: true }));
    if (proposal.kind === 'provider' && text('name').trim()) setProviders(current => [...current, { id: newId(), name: text('name'), npi: text('npi') || undefined, specialty: text('specialty') || undefined, location: text('location') || undefined, preferred: true, evidence: proof }]);
    else if (proposal.kind === 'medication' && text('name').trim()) setMedications(current => [...current, { id: newId(), name: text('name'), rxnorm: text('rxnorm') || undefined, ndc: text('ndc') || undefined, strength: text('strength') || undefined, form: text('form') || undefined, ongoing: value.ongoing === true, evidence: proof }]);
    else if (proposal.kind === 'expected_care' && text('label').trim()) {
      const category = text('category') as ServiceCategory;
      const date = text('date'); const quantity = value.quantity;
      if (!SERVICE_CATEGORIES.includes(category) || !/^2026-\d{2}-\d{2}$/.test(date) || typeof quantity !== 'number' || quantity <= 0 || (category === 'prescription' && quantity !== 1)) { setAiError('This suggestion needs more detail. Ask for a valid 2026 date, care category, and quantity. Each prescription fill needs its own dated item. You can also use the form.'); return; }
      setEvents(current => [...current, { id: newId(), label: text('label'), category, date, quantity, unitPriceCents: typeof value.unitPriceCents === 'number' && value.unitPriceCents >= 0 ? value.unitPriceCents : null, priceBasis: 'user_estimate', providerId: providers.some(item => item.id === text('providerId')) ? text('providerId') : undefined, medicationId: medications.some(item => item.id === text('medicationId')) ? text('medicationId') : undefined, confirmed: true }]);
    } else { setAiError('This suggestion is missing a name or care description. You can enter it in the form.'); return; }
    setAppliedProposals(current => [...current, proposal.id]); setAiError('');
  }

  const visiblePlans = catalog?.plans ?? [];
  const selectedPlans = selected.map(id => detailedPlans[id] ?? catalogPlans[id]).filter((plan): plan is Plan => Boolean(plan));
  const visibleResults = results.filter(result => (!onlyNetwork || result.providerMatches.every(match => match.status === 'in_network')) && (!onlyDrugs || result.medicationMatches.every(match => match.status === 'covered')));
  const detailResult = detailPlan ? results.find(result => result.plan.id === detailPlan.id) : undefined;

  return <div className="app-shell" data-text-size={textSize}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Main navigation">
      <a className="brand" href="#main-content" onClick={() => navigate(0)} aria-label="Plan Shepherd home"><span className="brand-mark"><Leaf size={23} strokeWidth={1.7} /></span><span>plan<span className="brand-second">shepherd</span></span></a>
      <div className="nav-label">YOUR PLAN, YOUR WAY</div>
      <nav className="step-nav" aria-label="Coverage steps">{steps.map((item, index) => <button key={item.title} className={`step-link ${step === index ? 'active' : ''}`} onClick={() => navigate(index)} aria-current={step === index ? 'step' : undefined}><item.icon size={20} strokeWidth={1.6} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><span className="step-number">{completedSteps[index] ? <><Check size={18} aria-hidden="true" /><span className="sr-only">Complete</span></> : `0${index + 1}`}</span></button>)}</nav>
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-assistant" onClick={() => setAssistantOpen(true)} aria-haspopup="dialog">
          <MessageCircle size={28} strokeWidth={1.6} aria-hidden="true" />
          <span>Ask the assistant</span>
        </button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb">Your next chapter <span>/</span> <strong>{steps[step].title}</strong></div>
        <div className="topbar-actions">
          <label className="reader-controls">Text size<select aria-label="Text size" value={textSize} onChange={event => setTextSize(event.target.value)}><option value="standard">Standard</option><option value="large">Large</option><option value="largest">Extra large</option></select></label>
          <span className="year-pill">{YEAR} COVERAGE</span>
          <div className="session-control">
            <button className="session-button" aria-describedby="session-note" onClick={() => setClearOpen(true)}><span className="live-dot" /><span>Clear session</span><X size={14} /></button>
            <span id="session-note" className="session-note">Clears on reload or close.</span>
          </div>
        </div>
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="main-content">
        <div className="page-heading"><div><div className="eyebrow"><span className="tiny-line" /> A CLEARER PATH TO COVERAGE</div><h1>{step === 0 ? <>Good coverage starts with <em>your story.</em></> : step === 1 ? <>Keep your care <em>in the picture.</em></> : step === 2 ? <>A little planning. <em>A clearer year ahead.</em></> : <>Your care. Your costs. <em>Your choice.</em></>}</h1><p className="page-description">{step === 0 ? 'Tell us a little about yourself. We’ll help you understand your options, one detail at a time.' : step === 1 ? 'Bring the people and prescriptions you rely on into the comparison.' : step === 2 ? 'Review your recent care, then tell us what you expect to need in 2026.' : 'Explore available coverage and compare the details that matter to you.'}</p></div></div>
        <div className="mobile-steps" aria-label="Steps">{steps.map((item, index) => <button key={item.title} onClick={() => navigate(index)} aria-current={step === index ? 'step' : undefined} className={step === index ? 'active' : ''}><span>{completedSteps[index] ? <><Check size={18} aria-hidden="true" /><span className="sr-only">Complete</span></> : index + 1}</span>{item.title}</button>)}</div>
        {undo && <div className="notice undo-notice" role="status"><span>{undo.label} You can undo this until your next edit.</span><button className="button button-secondary" onClick={() => { undo.restore(); setUndo(null); }}>Undo removal</button></div>}
        {message && <div className="page-notice" role="status"><Notice kind={message.kind}>{message.text}{step === 3 && (!profileReady || pendingEvents > 0) && <button className="text-button" onClick={() => !profileReady ? navigate(0) : reviewCare()}>{!profileReady ? 'Go to missing coverage details' : 'Go to care needing review'}</button>}</Notice></div>}
        {statusError && <div className="page-notice"><Notice kind="warning">Connections and catalog availability could not be checked. You can continue entering your information.</Notice></div>}

        {step === 0 && <CoverageForm profile={profile} onChange={updateProfile} counties={counties} countyBusy={countyBusy} countyError={countyError} onRetryCounties={() => setCountyRetry(current => current + 1)} onContinue={() => completeStep(0)} />}

        {step === 1 && <>
          <ConnectionDirectory connectors={status?.connectors ?? []} imports={imports} busy={statusBusy} error={statusError}
            connecting={connecting} onConnect={connect} onRetry={() => setStatusRetry(current => current + 1)} onManualEntry={() => { document.getElementById('manual-care')?.scrollIntoView({ block: 'start' }); document.getElementById('manual-care')?.focus(); }} />
          <div className="care-grid" id="manual-care" tabIndex={-1}><section className="card"><div className="card-heading"><span className="section-icon"><Stethoscope size={20} /></span><div><h2>Your providers</h2><p>Keep the providers you want to see in view.</p></div><span className="count-pill">{providers.length}</span></div>{providers.length ? <div className="record-list">{providers.map(provider => <ProviderEditor key={provider.id} provider={provider} onChange={updateProvider} onRemove={() => removeProvider(provider)} />)}</div> : <div className="small-empty"><Stethoscope size={28} strokeWidth={1.3} /><p>Your care team starts here.</p><span>Add your doctor, specialist, or care facility.</span></div>}{providerFormOpen ? <form autoComplete="off" className="inline-form" onSubmit={addProvider}><div className="form-grid"><Field label="Provider or facility name" wide><input name="name" required autoFocus placeholder="Name of your provider" maxLength={200} /></Field><Field label="Specialty"><input name="specialty" placeholder="If known" maxLength={100} /></Field><Field label="Location"><input name="location" placeholder="City or office address" maxLength={250} /></Field><details className="advanced-details field-wide"><summary>Optional provider identifier</summary><Field label="NPI (if known)" hint="A 10-digit provider identifier helps confirm network matches." wide><input name="npi" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} placeholder="10-digit NPI" /></Field></details></div><div className="inline-actions"><button className="button button-quiet" type="button" onClick={() => setProviderFormOpen(false)}>Cancel</button><button className="button button-primary" type="submit"><Check size={15} /> Add provider</button></div></form> : <button className="add-button" onClick={() => setProviderFormOpen(true)}><Plus size={17} /> Add a provider</button>}</section>
          <section className="card"><div className="card-heading"><span className="section-icon"><FileHeart size={20} /></span><div><h2>Your prescriptions</h2><p>Include the medications you expect to take.</p></div><span className="count-pill">{medications.length}</span></div>{medications.length ? <div className="record-list">{medications.map(medication => <MedicationEditor key={medication.id} medication={medication} onChange={updateMedication} onRemove={() => removeMedication(medication)} />)}</div> : <div className="small-empty"><FileHeart size={28} strokeWidth={1.3} /><p>The details make a difference.</p><span>A medication’s name, strength, and form all matter.</span></div>}{medicationFormOpen ? <form autoComplete="off" className="inline-form" onSubmit={addMedication}><div className="form-grid"><Field label="Medication name" wide><input name="name" required autoFocus placeholder="Name on your prescription" maxLength={200} /></Field><Field label="Strength"><input name="strength" placeholder="For example, 10 mg" maxLength={80} /></Field><Field label="Form"><input name="form" placeholder="For example, tablet" maxLength={80} /></Field><details className="advanced-details field-wide"><summary>Optional medication codes</summary><p>Use these only if you have them. The name, strength, and form are a good starting point.</p><Field label="RxNorm code (if known)" hint="Exact medication codes help confirm formulary matches." wide><input name="rxnorm" inputMode="numeric" pattern="[0-9]+" placeholder="Optional medication identifier" maxLength={20} /></Field><Field label="NDC code (if known)"><input name="ndc" inputMode="numeric" pattern="[0-9-]+" maxLength={30} /></Field></details><Field label="Quantity per fill"><input name="quantity" type="number" min="0" max="100000" step="any" onChange={event => event.target.setCustomValidity(!event.target.value || Number(event.target.value) > 0 ? '' : 'Enter a quantity greater than zero.')} /></Field><Field label="Days supplied per fill"><input name="daysSupply" type="number" min="1" max="366" step="1" /></Field></div><div className="inline-actions"><button type="button" className="button button-quiet" onClick={() => setMedicationFormOpen(false)}>Cancel</button><button type="submit" className="button button-primary"><Check size={15} /> Add prescription</button></div></form> : <button className="add-button" onClick={() => setMedicationFormOpen(true)}><Plus size={17} /> Add a prescription</button>}</section></div>
          {(providers.length > 0 || medications.length > 0) && <Notice>Checked items are included in your comparison. A record’s presence alone does not confirm current treatment, network status, or future coverage.</Notice>}
          {history.length > 0 && <section className="card history-card"><details><summary><span><BookOpen size={19} /> Your imported care history <span className="count-pill">{history.length}</span></span><ChevronDown size={18} /></summary><p className="muted">Review the source and status of each record. Completed prior-year care can become an editable draft for 2026.</p><div className="table-scroll"><table><thead><tr><th>Date</th><th>Care</th><th>Source</th><th>Record</th><th>Status</th><th>Historical allowed cost</th></tr></thead><tbody>{history.map(item => <tr key={item.id}><td>{niceDate(item.date)}</td><td><strong>{item.label}</strong><small>{categoryNames[item.category]}</small></td><td>{sourceName(item.source)}</td><td>{titleCase(item.kind)}</td><td>{titleCase(item.status)}</td><td>{money(item.allowedCents, 'Unknown')}</td></tr>)}</tbody></table></div></details></section>}
          <div className="step-footer"><button className="button button-quiet" onClick={() => navigate(0)}><ArrowLeft size={16} /> Back to coverage</button><button className="button button-primary" onClick={() => completeStep(1)}>Complete and continue <ArrowRight size={17} /></button></div>
        </>}

        {step === 2 && <>
          <div className="forecast-banner"><div className="forecast-banner-icon"><ClipboardList size={26} strokeWidth={1.5} /></div><div><h2>Start with what you know.</h2><p>Carry forward completed care from 2025, then adjust it for your plans in 2026. Every item is yours to review.</p></div><button className="button button-secondary" onClick={draftForecast} disabled={!history.length}><ArrowDownToLine size={16} /> Use recent history</button></div>
          <section className="card"><div className="card-heading"><span className="section-icon"><ClipboardList size={20} /></span><div><h2>Your expected care</h2><p>{niceDate(profile.coverageStart)} – {niceDate(profile.coverageEnd)}</p></div><span className="count-pill">{events.length} {events.length === 1 ? 'item' : 'items'}</span></div>
            {!events.length ? <EmptyState icon={ClipboardList} title="What might your year include?" action={<button className="button button-primary" onClick={addCare}><Plus size={16} /> Add expected care</button>}>Regular checkups, an ongoing prescription, or a planned procedure. Add what you know; you can change it as you go.</EmptyState> : <div className="care-events">{events.map((item, index) => <ExpectedCareEditor key={item.id} item={item} index={index} profile={profile} providers={providers} medications={medications} sourceReview={sourceReviews[item.id]} onChange={patch => updateEvent(item.id, patch)} onRemove={() => removeCare(item.id)} onResolveSource={useLatest => resolveSourceReview(item.id, useLatest)} onRepeat={additions => {
              if (events.length + additions.length > 2000) { setMessage({ text: 'This would exceed 2,000 care items. Use a shorter repeat period.', kind: 'warning' }); return false; }
              setUndo(null); setEvents(current => [...current, ...additions]); setMessage({ text: `${additions.length} repeated care items added. Review and confirm each date before comparing.`, kind: 'success' }); return true;
            }} />)}</div>}

            {events.length > 0 && <button className="add-button" onClick={addCare}><Plus size={17} /> Add another care item</button>}
          </section>
          <div className="forecast-summary"><div><span className="summary-value">{confirmedEvents.length}</span><span>confirmed care {confirmedEvents.length === 1 ? 'item' : 'items'}</span></div><div><span className="summary-value">{pendingEvents}</span><span>still to review</span></div><p>Plans apply their own benefits and cost-sharing rules to your expected care. Missing prices stay visible in the estimate.</p></div>
          <div className="step-footer"><button className="button button-quiet" onClick={() => navigate(1)}><ArrowLeft size={16} /> Back to your care</button><button className="button button-primary" onClick={() => completeStep(2)}>Complete and continue <ArrowRight size={17} /></button></div>
        </>}

        {step === 3 && <>
          <section className="card progress-checklist" aria-label="Before you compare"><h2>Before you compare</h2><p>Check the information used for your costs.</p><div><span>{profileReady ? '✓ Location and birth date entered' : 'Location or birth date still needed'}</span><button className="text-button" onClick={() => navigate(0)}>Review coverage</button></div><div><span>{providers.filter(item => item.preferred).length} doctors and {medications.filter(item => item.ongoing).length} prescriptions included</span><button className="text-button" onClick={() => navigate(1)}>Review doctors and medicines</button></div><div><span>{pendingEvents ? `${pendingEvents} care items need confirmation` : `${confirmedEvents.length} care items confirmed`}</span><button className="text-button" onClick={reviewCare}>Review expected care</button></div></section>
          <section className="card catalog-search-card"><div className="card-heading"><span className="section-icon"><SlidersHorizontal size={20} /></span><div><h2>Make the comparison yours</h2><p>{profile.state ? `${stateNames.find(([code]) => code === profile.state)?.[1] ?? profile.state} · ${counties.find(county => county.fips === profile.countyFips)?.name || 'County not selected'} · ${YEAR}` : 'Start with your location in Your coverage.'}</p></div><button className="text-button" onClick={() => navigate(0)}>Edit coverage <ArrowRight size={15} /></button></div><fieldset className="family-selector"><legend>Coverage categories</legend>{PLAN_FAMILIES.map(family => <label key={family} className={`family-option ${families.includes(family) ? 'selected' : ''}`}><input type="checkbox" checked={families.includes(family)} onChange={event => { catalogRequestId.current += 1; setCatalogBusy(false); setCatalogPlans({}); setCatalogOffset(0); setCatalogQuery(''); setQuery(''); setFamilies(current => event.target.checked ? [...current, family] : current.filter(item => item !== family)); setCatalog(null); setDetailedPlans({}); setSelected([]); setResults([]); setConditions([]); setAdditionalMonthlyPremiums({}); }} /><span><strong>{familyNames[family]}</strong><small>{family === 'aca' ? 'ACA marketplace plans' : family === 'short_term' ? 'Availability and conditions vary' : 'For eligible Medicare members'}</small></span></label>)}</fieldset><div className="search-footer"><span><MapPin size={15} /> Availability depends on your service area.</span><button className="button button-primary" disabled={catalogBusy || !families.length} onClick={() => searchCatalog()}>{catalogBusy ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}{catalogBusy ? 'Looking for plans…' : 'Find available plans'}</button></div></section>
          {catalog?.warnings.map((warning, index) => <div className="page-notice" key={index}><Notice kind="warning">{warning}</Notice></div>)}
          {catalog && catalog.coverage.some(item => item.status !== 'available') && <div className="coverage-notes">{catalog.coverage.filter(item => item.status !== 'available').map((item, index) => <div key={`${item.family}-${index}`}><CircleHelp size={17} /><p><strong>{familyNames[item.family]}: {item.status === 'not_offered' ? 'Not offered in this area' : 'Source data not yet available'}</strong><span>{item.note}</span></p></div>)}</div>}
          {!catalog ? <section className="card"><EmptyState icon={Layers3} title="Clarity starts with the right options.">Search the published catalog for your area. You’ll be able to choose up to three plans and compare them side by side.</EmptyState></section> : <section className="catalog-results">
            <div className="section-toolbar"><div><span className="eyebrow">YOUR OPTIONS</span><h2>{catalog.total} {catalog.total === 1 ? 'plan' : 'plans'} in the catalog</h2>{catalogQuery && <p>Matching “{catalogQuery}”</p>}</div><form autoComplete="off" className="catalog-query" onSubmit={event => { event.preventDefault(); void searchCatalog({ query, keepRelease: true }); }}><label className="search-input"><Search size={17} /><input value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="Search plans or insurers" aria-label="Search plans or insurers" /></label><button className="button button-secondary" disabled={catalogBusy} type="submit">Search catalog</button></form></div>
            <div className="plan-grid">{visiblePlans.map(plan => <PlanCard key={plan.id} plan={plan} selected={selected.includes(plan.id)} disabled={catalogBusy || (selected.length >= 3 && !selected.includes(plan.id))} onSelect={() => setSelected(current => current.includes(plan.id) ? current.filter(id => id !== plan.id) : [...current, plan.id])} onDetails={() => setDetailPlan(detailedPlans[plan.id] ?? plan)} />)}</div>
            {!visiblePlans.length && <section className="card"><EmptyState icon={BookOpen} title={catalogQuery ? 'No plans match that search.' : 'No published plans to compare yet.'}>{catalogQuery ? 'Try another plan or insurer name, or clear the search to see every matching plan for your area.' : 'Review the coverage notes above or update your location and categories. Your care information stays ready in this session.'}</EmptyState></section>}
            {catalog.total > 0 && <nav className="catalog-pagination" aria-label="Catalog pages"><button className="button button-secondary" disabled={catalogBusy || catalogOffset === 0} onClick={() => searchCatalog({ query: catalogQuery, offset: Math.max(0, catalogOffset - 20), keepRelease: true })}><ArrowLeft size={16} /> Previous page</button><span aria-live="polite">Plans {catalogOffset + 1}–{Math.min(catalogOffset + visiblePlans.length, catalog.total)} of {catalog.total}</span><button className="button button-secondary" disabled={catalogBusy || catalogOffset + visiblePlans.length >= catalog.total} onClick={() => searchCatalog({ query: catalogQuery, offset: catalogOffset + 20, keepRelease: true })}>Next page <ArrowRight size={16} /></button></nav>}
            {selectedPlans.length > 0 && <div className="selected-plan-list" aria-label="Selected plans">{selectedPlans.map(plan => <button key={plan.id} className="button button-quiet" onClick={() => setSelected(current => current.filter(id => id !== plan.id))} aria-label={`Deselect ${plan.name}`}><Check size={14} />{plan.name}<X size={14} /></button>)}</div>}
            {selectedPlans.filter(plan => plan.family === 'medicare_advantage').map(plan => <MedicarePremiums key={plan.id} planId={plan.id} planName={plan.name} value={additionalMonthlyPremiums[plan.id] ?? null} onChange={value => setAdditionalMonthlyPremiums(current => ({ ...current, [plan.id]: value }))} />)}
            <div className="comparison-tray"><div><Layers3 size={21} /><span><strong>{selected.length} of 3 plans selected</strong><small>Side by side. No recommendation or ranking.</small></span></div><button className="button button-primary" disabled={!selected.length || compareBusy || catalogBusy} onClick={compareSelected}>{compareBusy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{compareBusy ? 'Building comparison…' : 'Compare selected plans'}</button></div>
          </section>}

          <ConditionReview plans={selectedPlans} events={confirmedEvents} providers={providers} medications={medications} conditions={conditions} onPlanChange={(conditionId, value) => setConditions(current => [...current.filter(item => item.conditionId !== conditionId), { conditionId, status: value, evidence: [{ id: newId(), source: 'Your confirmation', method: 'user_entered', confirmed: true }] }])} onEventChange={(eventId, conditionId, value) => setEvents(current => current.map(event => event.id === eventId ? { ...event, conditions: [...(event.conditions ?? []).filter(item => item.conditionId !== conditionId), { conditionId, status: value, evidence: [{ id: newId(), source: 'Your confirmation', method: 'user_entered', confirmed: true }] }] } : event))} />
          {results.length > 0 && <section id="comparison-results" className="comparison-section"><div className="section-toolbar"><div><span className="eyebrow">THE COMPLETE PICTURE</span><h2>How your plans compare</h2><p className="print-only">Plan Shepherd · Coverage {niceDate(profile.coverageStart)} – {niceDate(profile.coverageEnd)} · Prepared {new Date().toLocaleDateString('en-US')}</p></div><button className="text-button" onClick={() => navigate(2)}>Edit expected care <ArrowRight size={15} /></button></div><button className="button button-secondary" onClick={() => window.print()}>Print comparison</button><p className="print-only">Estimates are for the dates shown. A known subtotal excludes missing costs. Confirm coverage with the insurer before choosing a plan.</p><div className="comparison-filters"><label><input type="checkbox" checked={onlyNetwork} onChange={event => setOnlyNetwork(event.target.checked)} /> All selected providers in network</label><label><input type="checkbox" checked={onlyDrugs} onChange={event => setOnlyDrugs(event.target.checked)} /> All selected medications covered</label></div><ComparisonOverview results={visibleResults} providers={providers} medications={medications} /><div className="comparison-grid">{visibleResults.map(result => <ComparisonCard key={result.plan.id} result={result} providers={providers} medications={medications} onDetails={() => setDetailPlan(result.plan)} />)}</div>{!visibleResults.length && <Notice>No compared plans meet both filters. Uncheck a filter to see the coverage details and unknowns.</Notice>}<div className="comparison-footnote"><CircleHelp size={16} /><p>Estimates use your confirmed care and the published plan rules. They are not a guarantee of eligibility, enrollment, coverage, or final payment. Unknown costs are never treated as zero.</p></div></section>}
          <EligibilityPanel eligibility={eligibility} />
          <div className="step-footer">
            <button className="button button-quiet" onClick={() => navigate(2)}><ArrowLeft size={16} /> Back to expected care</button>
            <button className={`button ${completedSteps[3] ? 'button-confirmed' : 'button-primary'}`} disabled={completedSteps[3] || !results.length || compareBusy || catalogBusy} onClick={() => completeStep(3)}><Check size={17} aria-hidden="true" />{completedSteps[3] ? 'Completed' : 'Complete'}</button>
          </div>
        </>}
        <footer className="page-footer"><span><Leaf size={14} /> A clearer path. A choice that’s yours.</span><a className="text-button" href="/terms" target="_blank" rel="noopener noreferrer">Terms and Conditions<span className="sr-only"> (opens a new tab)</span></a><button onClick={() => setAssistantOpen(true)}><MessageCircle size={15} /> Help with a question</button></footer>
      </main>
    </div>
    {pendingImport && <Dialog title="CONFIRM YOUR RECORDS" onClose={() => { setPendingImport(null); setIdentityConfirmed(false); }}><h2 className="dialog-title">Do these records belong to you?</h2><p className="muted">Review the identity supplied by {pendingImport.name} before adding these records to your session.</p><div className="identity-card"><span className="eyebrow">IDENTITY FROM THE CONNECTION</span><h3>{pendingImport.data.patient?.name || 'Name not supplied'}</h3><p>Date of birth: {pendingImport.data.patient?.dateOfBirth ? niceDate(pendingImport.data.patient.dateOfBirth) : 'Not supplied'}</p><p>{pendingImport.data.providers.length} providers · {pendingImport.data.medications.length} prescriptions · {pendingImport.data.events.length} history items</p></div><Field label="Your date of birth" hint="This is the date entered in Your coverage. Correct it only if your entry was mistaken."><input type="date" min="1900-01-01" max={profile.coverageStart} value={profile.dateOfBirth} onChange={event => { updateProfile('dateOfBirth', event.target.value); setIdentityConfirmed(false); }} /></Field>{pendingImport.data.patient?.dateOfBirth && pendingImport.data.patient.dateOfBirth !== profile.dateOfBirth && <Notice kind="warning">The dates of birth do not match. These records cannot be added until your information matches. If these belong to someone else, cancel this import.</Notice>}{importedBirthDate && importedBirthDate !== profile.dateOfBirth && <Notice kind="warning">Your earlier import belongs to a different birth date. Cancel this import and clear the session before working with another person’s records.</Notice>}{!pendingImport.data.patient?.dateOfBirth && <Notice>The connection did not supply a birth date. Check the account identity carefully before continuing.</Notice>}<label className="identity-confirm"><input type="checkbox" checked={identityConfirmed} onChange={event => setIdentityConfirmed(event.target.checked)} /><span>These are my records, for the person choosing coverage in this session.</span></label><div className="identity-actions"><button className="button button-quiet" onClick={() => { setPendingImport(null); setIdentityConfirmed(false); }}>Cancel import</button><button className="button button-primary" disabled={!identityConfirmed || !profile.dateOfBirth || Boolean(importedBirthDate && importedBirthDate !== profile.dateOfBirth) || Boolean(pendingImport.data.patient?.dateOfBirth && pendingImport.data.patient.dateOfBirth !== profile.dateOfBirth)} onClick={confirmImport}><Check size={16} /> Add my records</button></div></Dialog>}
    {detailPlan && <Dialog title="PLAN DETAILS & SOURCES" onClose={() => setDetailPlan(null)}><span className="plan-family">{familyNames[detailPlan.family]} · {detailPlan.year}</span><h2 className="dialog-title">{detailPlan.name}</h2><p className="muted">{detailPlan.issuer} · {detailPlan.id}</p>{detailPlan.underwritingRequired && <Notice kind="warning">This plan requires underwriting. Listing it does not confirm acceptance or coverage.</Notice>}{detailPlan.conditions?.map(condition => <Notice key={condition.id}>{condition.label}</Notice>)}{detailResult && <><h3 className="detail-section-title">Your estimated care, item by item</h3><div className="table-scroll"><table><thead><tr><th>Expected care</th><th>Coverage / network</th><th>Allowed cost</th><th>Your cost</th><th>How it was calculated</th></tr></thead><tbody>{detailResult.cost.lines.map((line, index) => <tr key={`${line.eventId}-${index}`}><td><strong>{line.label}</strong>{line.estimated && <small>Estimated price</small>}</td><td><StatusBadge value={line.coverage} /><StatusBadge value={line.network} /></td><td>{money(line.allowedCents, 'Unknown')}</td><td>{money(line.patientCents, 'Unpriced')}</td><td><ul>{line.explanation.map((text, itemIndex) => <li key={itemIndex}>{text}</li>)}</ul>{line.sourceIds.length > 0 && <small>Sources: {line.sourceIds.join(', ')}</small>}</td></tr>)}</tbody></table></div>{detailResult.cost.warnings.map((warning, index) => <Notice kind="warning" key={index}>{warning}</Notice>)}</>}<h3 className="detail-section-title">Published benefits</h3>{detailPlan.benefits.length ? detailPlan.benefits.map(benefit => <BenefitItem key={benefit.id} benefit={benefit} />) : <Notice>Detailed benefits are not present in this source record.</Notice>}<h3 className="detail-section-title">Coverage limits</h3><dl className="cost-summary"><div><dt>Medical deductible</dt><dd>{money(detailPlan.deductibleCents, 'Unknown')}</dd></div><div><dt>Medical out-of-pocket limit</dt><dd>{money(detailPlan.oopMaxCents, detailPlan.medicalOopUnbounded ? 'No annual limit' : 'Unknown')}</dd></div><div><dt>Drug deductible</dt><dd>{money(detailPlan.drugDeductibleCents, 'Unknown')}</dd></div><div><dt>Drug out-of-pocket limit</dt><dd>{money(detailPlan.drugOopMaxCents, detailPlan.drugOopUnbounded ? 'No annual limit' : 'Unknown')}</dd></div>{detailPlan.insurerPaymentCapCents !== undefined && <div><dt>Total insurer payment cap</dt><dd>{money(detailPlan.insurerPaymentCapCents, 'Unknown')}</dd></div>}</dl>{detailPlan.drugBenefitPhases && <><h3 className="detail-section-title">Drug benefit stages</h3>{detailPlan.drugBenefitPhases.phases.map(phase => <div className="benefit-item" key={phase.id}><strong>{phase.label}</strong><p>{phase.until ? `Until ${money(phase.until.cents)} in ${phase.until.ledger === 'drug_allowed' ? 'total allowed prescription costs' : 'credited out-of-pocket drug spending'}.` : 'No further spending threshold in this stage.'}</p><p>Your share: {phase.coinsuranceBps / 100}% coinsurance{phase.copayCents != null ? ` and ${money(phase.copayCents)} copay` : ''}. Applicable benefit rules determine how these combine.</p></div>)}<SourceLink source={detailPlan.drugBenefitPhases.source} /></>}<h3 className="detail-section-title">Documents & source</h3><div className="document-links">{detailPlan.documentUrls.filter(document => safeUrl(document.url)).map((document, index) => <a key={index} href={safeUrl(document.url)} target="_blank" rel="noopener noreferrer"><BookOpen size={17} />{document.label}<ExternalLink size={14} /></a>)}</div><SourceLink source={detailPlan.source} />{detailPlan.premiumSource && <div className="benefit-item"><strong>Premium rate source</strong><SourceLink source={detailPlan.premiumSource} /></div>}{detailPlan.serviceAreas?.filter(area => area.countyFips === profile.countyFips && area.source).map((area, index) => <div className="benefit-item" key={index}><strong>Service area source</strong><SourceLink source={area.source!} /></div>)}<div className="detail-data-notes"><p>Provider directory: {detailPlan.networkComplete ? 'Marked complete by the source' : 'Incomplete; missing providers remain unconfirmed'}.</p><p>Formulary: {detailPlan.formularyComplete ? 'Marked complete by the source' : 'Incomplete; missing medications remain unconfirmed'}.</p><p>Cost-sharing rules: {detailPlan.rulesVerified ? 'Verified for this catalog record' : 'Not fully verified'}.</p></div></Dialog>}
    {clearOpen && <Dialog title="Clear your session?" onClose={() => setClearOpen(false)}><h2 className="dialog-title">Remove your entered information?</h2><p>This clears your coverage details, records, expected care, and comparison from this session. This cannot be undone.</p><div className="identity-actions"><button className="button button-secondary" autoFocus onClick={() => setClearOpen(false)}>Keep working</button><button className="button button-primary" onClick={resetPatientSession}>Yes, clear my session</button></div></Dialog>}
    {assistantOpen && <Dialog title="A LITTLE HELP ALONG THE WAY" onClose={() => setAssistantOpen(false)} className="assistant-dialog"><div className="assistant-heading"><span className="assistant-icon"><Sparkles size={24} strokeWidth={1.5} /></span><h2>Your questions,<br /><em>a little clearer.</em></h2><p>I can explain questions and suggest information to add. You review and confirm every change.</p></div>{!status?.ai.enabled && <Notice>{status?.ai.reason || 'The assistant is not connected yet. You can complete every step using the forms.'}</Notice>}<details className="help-guide" open={!status?.ai.enabled}><summary>Help with forms and insurance terms</summary><HelpGuide /></details><div className="chat-log" aria-live="polite">{chat.map((item, index) => <div className={`chat-message chat-${item.role}`} key={index}><span>{item.role === 'user' ? 'YOU' : 'PLAN SHEPHERD'}</span><p>{item.content}</p></div>)}{aiBusy && <div className="chat-thinking"><LoaderCircle size={16} className="spin" /> Working through your question…</div>}{proposals.map(proposal => <div className="proposal-card" key={proposal.id}><span className="eyebrow">SUGGESTED {titleCase(proposal.kind).toUpperCase()}</span><h3>{String(proposal.value.name ?? proposal.value.label ?? 'Review suggested information')}</h3><p>{proposal.explanation}</p><dl>{Object.entries(proposal.value).filter(([key, value]) => !['id', 'name', 'label'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => <div key={key}><dt>{titleCase(key.replace(/([A-Z])/g, ' $1'))}</dt><dd>{key.endsWith('Cents') && typeof value === 'number' ? money(value) : String(value)}</dd></div>)}</dl>{proposal.evidenceIds.length > 0 && <small>Evidence: {proposal.evidenceIds.map(id => sourceName(evidence.find(item => item.id === id)?.source ?? id)).join(', ')}</small>}<button className={`button ${appliedProposals.includes(proposal.id) ? 'button-confirmed' : 'button-secondary'}`} disabled={appliedProposals.includes(proposal.id)} onClick={() => applyProposal(proposal)}><Check size={15} />{appliedProposals.includes(proposal.id) ? 'Confirmed & added' : 'Confirm & add to my information'}</button></div>)}{aiError && <Notice kind="warning">{aiError}</Notice>}<div ref={chatBottomRef} /></div><details className="evidence-picker"><summary>Choose information to share <span className="evidence-count">{selectedEvidence.length} selected</span></summary><p>Only the source items you check below accompany your conversation. Leave them unchecked for a general question.</p>{evidence.length ? <><input type="search" aria-label="Find source information" placeholder="Find a source or detail" value={evidenceQuery} onChange={event => setEvidenceQuery(event.target.value)} /><div className="evidence-list">{evidence.filter(item => `${sourceName(item.source)} ${item.text ?? ''}`.toLowerCase().includes(evidenceQuery.toLowerCase())).slice(0, 100).map(item => <label key={item.id}><input type="checkbox" checked={selectedEvidence.includes(item.id)} disabled={selectedEvidence.length >= 200 && !selectedEvidence.includes(item.id)} onChange={event => setSelectedEvidence(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /><span><strong>{sourceName(item.source)}{item.date ? ` · ${niceDate(item.date)}` : ''}</strong><small>{item.text || (item.resourceId ? `Record ${item.resourceId}` : 'User-entered information')}</small></span></label>)}</div><small>Showing up to 100 matches. Choose up to 200 source items.</small></> : <p>No imported source items yet. You can describe information in your message.</p>}</details>{chat.length > 0 && <button className="text-button conversation-reset" disabled={aiBusy} onClick={() => { setChat([]); setProposals([]); setAppliedProposals([]); setAiError(''); }}>Start a new conversation</button>}{chat.length >= 30 && <Notice>Start a new conversation to ask more questions. Your confirmed information stays in this session.</Notice>}<form autoComplete="off" className="chat-form" onSubmit={askAssistant}><label className="sr-only" htmlFor="assistant-message">Your question</label><textarea id="assistant-message" value={chatInput} onChange={event => setChatInput(event.target.value)} placeholder="What would you like to understand?" rows={3} maxLength={4000} disabled={!status?.ai.enabled || aiBusy || chat.length >= 30} /><div><span><LockKeyhole size={12} /> No saved conversation in this app</span><button className="button button-primary" type="submit" disabled={!status?.ai.enabled || aiBusy || chat.length >= 30 || !chatInput.trim()} aria-label="Send question"><ArrowRight size={18} /> Send question</button></div></form></Dialog>}
  </div>;
}

function EligibilityPanel({ eligibility }: { eligibility: EligibilityResult[] }) {
  return <details className="eligibility-panel eligibility-expanded">
    <summary>Preliminary eligibility <ChevronDown size={20} aria-hidden="true" /></summary>
    <h3>A starting point, not a final decision.</h3>
    <p>Your answers help identify what needs to be checked.</p>
    <div className="eligibility-items">{eligibility.map(result => <details key={result.family}><summary><span>{familyNames[result.family]}</span><StatusBadge value={result.status} /></summary><div className="eligibility-detail">{result.reasons.length > 0 && <ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}{result.missing.length > 0 && <><strong>Still to clarify</strong><ul>{result.missing.map((missing, index) => <li key={index}>{titleCase(missing)}</li>)}</ul></>}{result.sources.filter(safeUrl).map((source, index) => <a key={index} href={safeUrl(source)} target="_blank" rel="noopener noreferrer">Eligibility source {index + 1}<ExternalLink size={11} /></a>)}</div></details>)}</div>
  </details>;
}
function PlanCard({ plan, selected, disabled, onSelect, onDetails }: { plan: Plan; selected: boolean; disabled: boolean; onSelect: () => void; onDetails: () => void }) {
  return <article className={`plan-card ${selected ? 'plan-selected' : ''}`}><div className="plan-topline"><span className="plan-family">{familyNames[plan.family]}</span><label className="plan-check"><input type="checkbox" checked={selected} disabled={disabled} onChange={onSelect} aria-label={`Select ${plan.name} for comparison`} /><span>Compare this plan</span></label></div><div className="plan-issuer">{plan.issuer}</div><h3>{plan.name}</h3><div className="plan-tags">{plan.metalLevel && <span>{plan.metalLevel}</span>}{plan.planType && <span>{plan.planType}</span>}{plan.underwritingRequired && <span>Underwriting required</span>}</div><div className="premium-amount">{money(plan.monthlyPremiumCents, 'Unknown')}<span>/ month</span></div><p className="premium-caption">{plan.premiumEstimated ? 'Estimated premium' : 'Published premium'} · before any assistance</p><dl className="plan-summary"><div><dt>Medical deductible</dt><dd>{money(plan.deductibleCents, 'Unknown')}</dd></div><div><dt>Medical out-of-pocket limit</dt><dd>{money(plan.oopMaxCents, plan.medicalOopUnbounded ? 'No annual limit' : 'Unknown')}</dd></div></dl><button className="text-button plan-details-link" onClick={onDetails}>Benefits & source documents <ArrowRight size={15} /></button></article>;
}
function ComparisonCard({ result, providers, medications, onDetails }: { result: ComparisonResult; providers: ProviderPreference[]; medications: Medication[]; onDetails: () => void }) {
  const { plan, cost } = result;
  return <article className="comparison-card"><div className="comparison-card-heading"><span className="plan-family">{familyNames[plan.family]}</span><span className="plan-issuer">{plan.issuer}</span><h3>{plan.name}</h3></div><div className="estimated-total"><span>{cost.totalCents == null ? 'Partial cost picture' : `Estimated cost for ${cost.coverageMonths} months`}</span><strong>{money(cost.totalCents, 'Still incomplete')}</strong>{cost.totalCents == null && <small>{money(cost.knownSubtotalCents)} known subtotal · {cost.unpricedCount} care {cost.unpricedCount === 1 ? 'item needs' : 'items need'} a cost</small>}</div><dl className="cost-summary"><div><dt>Premiums ({cost.coverageMonths} months)</dt><dd>{money(cost.premiumCents, 'Unknown')}</dd></div>{plan.family === 'medicare_advantage' && <><div><dt>Plan premiums ({cost.coverageMonths} months)</dt><dd>{money(cost.planPremiumCents, 'Unknown')}</dd></div><div><dt>Other Medicare premiums ({cost.coverageMonths} months)</dt><dd>{money(cost.additionalPremiumCents, 'Unknown')}</dd></div></>}<div><dt>Known care costs</dt><dd>{money(cost.careCents)}</dd></div><div><dt>Medical deductible</dt><dd>{money(plan.deductibleCents, 'Unknown')}</dd></div><div><dt>Medical out-of-pocket limit</dt><dd>{money(plan.oopMaxCents, plan.medicalOopUnbounded ? 'No annual limit' : 'Unknown')}</dd></div><div><dt>Drug deductible</dt><dd>{money(plan.drugDeductibleCents, 'Unknown')}</dd></div><div><dt>Drug out-of-pocket limit</dt><dd>{money(plan.drugOopMaxCents, plan.drugOopUnbounded ? 'No annual limit' : 'Unknown')}</dd></div></dl><div className="match-section"><h4><Stethoscope size={15} /> Your providers</h4>{result.providerMatches.length ? result.providerMatches.map(match => <div className="match-row" key={match.providerId}><div><strong>{providers.find(provider => provider.id === match.providerId)?.name ?? 'Selected provider'}</strong><small>{match.details}</small></div><StatusBadge value={match.status} /></div>) : <p className="muted">No preferred providers added.</p>}</div><div className="match-section"><h4><FileHeart size={15} /> Your prescriptions</h4>{result.medicationMatches.length ? result.medicationMatches.map(match => <div className="match-row" key={match.medicationId}><div><strong>{medications.find(medication => medication.id === match.medicationId)?.name ?? 'Selected prescription'}</strong><small>{match.details}</small></div><StatusBadge value={match.status} /></div>) : <p className="muted">No ongoing prescriptions added.</p>}</div>{cost.warnings.length > 0 && <details className="comparison-warnings"><summary><CircleHelp size={15} />{cost.warnings.length} estimate {cost.warnings.length === 1 ? 'note' : 'notes'}<ChevronDown size={14} /></summary><ul>{cost.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}<div className="print-only"><SourceLink source={plan.source} /></div><button className="button button-secondary" onClick={onDetails}>Explore benefits & cost details <ArrowRight size={16} /></button></article>;
}
