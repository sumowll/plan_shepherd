import type { ComparisonResult, Medication, ProviderPreference } from '../shared/contracts';

const money = (value: number | null | undefined) => value == null ? 'Not known yet' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value % 100 ? 2 : 0 }).format(value / 100);
const network = { in_network: 'In network', out_of_network: 'Out of network', unknown: 'Not confirmed' };
const coverage = { covered: 'Covered', not_covered: 'Not covered', conditional: 'Conditions apply', unknown: 'Not confirmed' };

export function ComparisonOverview({ results, providers, medications }: { results: ComparisonResult[]; providers: ProviderPreference[]; medications: Medication[] }) {
  if (!results.length) return null;
  const providerIds = new Set(results.flatMap(result => result.providerMatches.map(item => item.providerId)));
  const medicationIds = new Set(results.flatMap(result => result.medicationMatches.map(item => item.medicationId)));
  return <div className="comparison-overview">
    <p id="comparison-scroll-help">Compare the same details across each plan. On a small screen, scroll the table sideways or read the plan summaries below.</p>
    <div className="table-scroll" role="region" aria-label="Plan comparison at a glance" aria-describedby="comparison-scroll-help" tabIndex={0}>
      <table><caption>Your costs, doctors, and prescriptions at a glance</caption>
        <thead><tr><th scope="col">What matters to you</th>{results.map(({ plan }) => <th scope="col" key={plan.id}>{plan.name}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Plan premium each month, before assistance</th>{results.map(({ plan }) => <td key={plan.id}>{money(plan.monthlyPremiumCents)}{plan.family === 'medicare_advantage' && <small>Other Medicare premiums are additional.</small>}</td>)}</tr>
          <tr><th scope="row">Estimated total for your coverage period</th>{results.map(({ plan, cost }) => <td key={plan.id}><strong>{cost.totalCents == null ? 'Still incomplete' : money(cost.totalCents)}</strong><small>{cost.coverageMonths} months{cost.totalCents == null ? ` · ${money(cost.knownSubtotalCents)} known so far` : ' · premiums and expected care'}</small></td>)}</tr>
          <tr><th scope="row">Medical deductible</th>{results.map(({ plan }) => <td key={plan.id}>{money(plan.deductibleCents)}</td>)}</tr>
          {providers.filter(item => providerIds.has(item.id)).map(provider => <tr key={provider.id}><th scope="row">Doctor: {provider.name}</th>{results.map(result => <td key={result.plan.id}>{network[result.providerMatches.find(item => item.providerId === provider.id)?.status ?? 'unknown']}</td>)}</tr>)}
          {medications.filter(item => medicationIds.has(item.id)).map(medication => <tr key={medication.id}><th scope="row">Prescription: {medication.name}</th>{results.map(result => <td key={result.plan.id}>{coverage[result.medicationMatches.find(item => item.medicationId === medication.id)?.status ?? 'unknown']}</td>)}</tr>)}
          <tr><th scope="row">Information still needed</th>{results.map(({ plan, cost }) => <td key={plan.id}>{cost.unpricedCount ? `${cost.unpricedCount} care ${cost.unpricedCount === 1 ? 'item needs' : 'items need'} a cost` : cost.totalCents == null ? 'Premium or coverage details' : 'Review coverage conditions below'}{cost.warnings.length > 0 && <small>{cost.warnings.length} estimate {cost.warnings.length === 1 ? 'note' : 'notes'} below</small>}</td>)}</tr>
        </tbody>
      </table>
    </div>
  </div>;
}
