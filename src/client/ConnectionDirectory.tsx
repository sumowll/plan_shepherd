import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCheck, Heart, Link2, LoaderCircle, LockKeyhole, Search, Stethoscope, X } from 'lucide-react';
import type { ConnectorStatus } from '../shared/contracts';
import './connection-directory.css';

export interface ConnectionImport { connector: ConnectorStatus; resources: number; complete: boolean; warnings: string[] }
type ConnectionFilter = 'all' | 'provider' | 'payer' | 'imported';
const PAGE_SIZE = 6;
const nameOrder = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const count = (value: number) => value.toLocaleString('en-US');
const searchName = (value: string) => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function ConnectionDirectory({ connectors, imports, busy, error, connecting, onConnect, onRetry, onManualEntry }: {
  connectors: ConnectorStatus[];
  imports: Record<string, ConnectionImport>;
  busy: boolean;
  error: boolean;
  connecting: string | null;
  onConnect: (connector: ConnectorStatus) => void;
  onRetry: () => void;
  onManualEntry?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConnectionFilter>('all');
  const [page, setPage] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const directory = useMemo(() => {
    const current = connectors.filter(connector => connector.apiType === 'patient_access');
    const currentIds = new Set(current.map(connector => connector.id));
    // Retain confirmed imports when an availability refresh removes their source.
    const removed = Object.values(imports).filter(({ connector }) => !currentIds.has(connector.id))
      .map(({ connector }) => ({ ...connector, configured: false, enabled: false,
        reason: 'This source is no longer in the connection directory. Your imported records are still available in this session.' }));
    return [...current, ...removed].map(connector => ({ connector, search: searchName(connector.name) }))
      .sort((a, b) => nameOrder.compare(a.connector.name, b.connector.name) || a.connector.id.localeCompare(b.connector.id));
  }, [connectors, imports]);
  const counts = useMemo(() => ({
    all: directory.length,
    provider: directory.filter(({ connector }) => connector.kind === 'provider').length,
    payer: directory.filter(({ connector }) => connector.kind === 'payer').length,
    imported: directory.filter(({ connector }) => imports[connector.id]).length,
  }), [directory, imports]);
  const matches = useMemo(() => {
    const words = searchName(query).split(' ').filter(Boolean);
    return directory.filter(({ connector, search }) =>
      (filter === 'all' || (filter === 'imported' ? Boolean(imports[connector.id]) : connector.kind === filter))
      && words.every(word => search.includes(word)));
  }, [directory, query, filter, imports]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * PAGE_SIZE;
  const visible = matches.slice(offset, offset + PAGE_SIZE);
  const filters: { value: ConnectionFilter; label: string }[] = [
    { value: 'all', label: 'All connections' }, { value: 'provider', label: 'Providers' },
    { value: 'payer', label: 'Insurers' }, { value: 'imported', label: 'Your imports' },
  ];
  const needsRetry = error || (!busy && !directory.length) || directory.some(({ connector }) => !connector.configured || !connector.enabled);

  function clearFilters() {
    setQuery(''); setFilter('all'); setPage(0); searchRef.current?.focus();
  }
  function changePage(next: number) {
    setPage(next);
    resultsRef.current?.focus({ preventScroll: true });
    resultsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  return <section className="card connection-directory" aria-labelledby="records-heading">
    <div className="card-heading"><span className="section-icon"><Link2 size={20} /></span><div>
      <h2 id="records-heading">Bring your records together</h2>
      <p>Find your provider or insurer, then sign in to import your records.</p>
    </div></div>

    <div className="directory-guide" aria-label="How to bring in your records">
      <p><strong>1. Choose your provider or insurer.</strong> Use the organization where you have a patient or member account.</p>
      <p><strong>2. Sign in with that organization.</strong> After signing in, return here to continue.</p>
      <p><strong>3. Review and confirm your records.</strong> Check that they belong to you before adding them.</p>
      {onManualEntry && <div className="directory-manual-entry"><span>You can also enter your doctors and medicines yourself.</span><button type="button" className="button button-secondary" onClick={onManualEntry}>Add details manually <ArrowRight size={17} aria-hidden="true" /></button></div>}
    </div>

    <div className="directory-search-area">
      <label htmlFor="connection-search" className="directory-search-label">Search providers and insurers</label>
      <div className="directory-search-box">
        <Search size={20} aria-hidden="true" />
        <input id="connection-search" ref={searchRef} type="search" autoComplete="off" spellCheck={false}
          aria-describedby="connection-search-hint" aria-controls="connection-results"
          placeholder="Search by provider or insurer name" value={query} maxLength={200}
          onChange={event => { setQuery(event.target.value); setPage(0); }} />
        {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); setPage(0); searchRef.current?.focus(); }}><X size={17} /></button>}
      </div>
      <p id="connection-search-hint">Search for the organization you have a patient or member account with.</p>
    </div>

    <div className="directory-filters" role="group" aria-label="Filter connections">
      {filters.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value}
        aria-controls="connection-results" className={value === 'imported' ? 'directory-import-filter' : undefined}
        onClick={() => { setFilter(value); setPage(0); if (value === 'imported') setQuery(''); }}>
        {value === 'imported' && <CheckCheck size={15} aria-hidden="true" />}{label}
        <span aria-hidden="true">{count(counts[value])}</span>
      </button>)}
    </div>

    <div id="connection-results" ref={resultsRef} tabIndex={-1} className="directory-results" aria-label="Connection results" aria-busy={busy}>
      {!directory.length ? <div className="directory-empty" role="status">
        {busy ? <LoaderCircle size={24} className="spin" aria-hidden="true" /> : <Search size={24} aria-hidden="true" />}
        <p>{busy ? 'Checking connection availability…' : error ? 'Connection status unavailable. Retry availability to check again.' : 'No provider or insurer connections are available yet. You can add your care details below.'}</p>
      </div> : <>
        <div className="directory-results-summary">
          <p role="status" aria-atomic="true">{matches.length
            ? `${count(offset + 1)}–${count(Math.min(offset + PAGE_SIZE, matches.length))} of ${count(matches.length)} ${matches.length === 1 ? 'connection' : 'connections'}`
            : filter === 'imported' && !counts.imported ? 'No records imported yet.' : 'No providers or insurers match your search.'}</p>
          {matches.length > 0 && <span>{filter === 'imported' ? 'Imported this session' : 'A–Z'}</span>}
        </div>
        {!matches.length ? <div className="directory-empty">
          {filter === 'imported' ? <CheckCheck size={25} aria-hidden="true" /> : <Search size={25} aria-hidden="true" />}
          <p>{filter === 'imported' && !counts.imported ? 'After you connect and confirm your records, you can find that source here.' : 'Try another name or choose a different connection type. You can also add your care details below.'}</p>
          <button className="button button-secondary" onClick={clearFilters}>{filter === 'imported' && !counts.imported ? 'Find a connection' : 'Clear filters'}</button>
        </div> : <ul className="directory-list" aria-label={filter === 'imported' ? 'Imported connections' : 'Providers and insurers'}>
          {visible.map(({ connector }) => {
            const { id } = connector;
            const available = Boolean(connector.configured && connector.enabled && !error);
            const imported = imports[id];
            const note = busy ? 'Checking connection availability…' : error ? 'Connection status unavailable. Retry availability to check again.'
              : connector.reason || (!available ? 'This connection is unavailable. Retry availability to check again.' : connector.testEnvironment ? 'Sign in with a test member account.' : '');
            return <li className={`connector-row${imported ? ' connector-row-imported' : ''}`} key={id} aria-labelledby={`connection-${id}`}>
              <span className="directory-connection-icon" aria-hidden="true">{connector.kind === 'provider' ? <Stethoscope size={21} /> : <Heart size={21} />}</span>
              <div className="directory-connection-info">
                <h3 id={`connection-${id}`}>{connector.name}</h3>
                <p className="directory-connection-type">{connector.testEnvironment ? 'Test records only' : connector.kind === 'provider' ? 'Your provider records' : 'Your claims & care history'}</p>
                {imported && <p className="directory-import-status"><CheckCheck size={15} aria-hidden="true" />{imported.resources} resources imported{!imported.complete && ' · Partial import'}</p>}
                {note && <p className="directory-connection-note">{note}</p>}
                {imported?.warnings.length ? <details className="directory-import-notes"><summary>{imported.warnings.length} import {imported.warnings.length === 1 ? 'note' : 'notes'}</summary><ul>{imported.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
              </div>
              <button className="button button-secondary" aria-describedby={`connection-${id}`} disabled={!available || busy || connecting !== null} onClick={() => onConnect(connector)}>
                {connecting === id ? <><LoaderCircle className="spin" size={16} /> Connecting…</> : <>{available && !busy && <Link2 size={15} />}{busy ? 'Checking availability…' : !available ? 'Connection unavailable' : imported ? 'Import again' : 'Connect account'}</>}
              </button>
            </li>;
          })}
        </ul>}
        {matches.length > PAGE_SIZE && <nav className="directory-pagination" aria-label="Connection pages">
          <button className="button button-secondary" aria-label="Previous connections" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ArrowLeft size={16} /> Previous</button>
          <span>Page {count(currentPage + 1)} of {count(lastPage + 1)}</span>
          <button className="button button-secondary" aria-label="Next connections" disabled={currentPage === lastPage} onClick={() => changePage(currentPage + 1)}>Next <ArrowRight size={16} /></button>
        </nav>}
      </>}
    </div>
    {needsRetry && <button className="text-button directory-retry" disabled={busy} onClick={onRetry}>{busy ? <><LoaderCircle className="spin" size={15} /> Checking availability…</> : 'Retry availability'}</button>}
    <div className="section-note directory-privacy"><LockKeyhole size={14} /> You sign in with your provider or insurer. Your records are used only for this session.</div>
  </section>;
}
