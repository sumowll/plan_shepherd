import type { BenefitCondition, ConditionConfirmation, ExpectedCareEvent, Medication, Plan, ProviderPreference } from '../shared/contracts';
import { getApplicableConditions, getPlanConditions } from '../domain/index';

function ConditionField({ condition, value, onChange }: { condition: BenefitCondition; value?: ConditionConfirmation; onChange: (status: ConditionConfirmation['status']) => void }) {
  return <label className="condition-control"><span>{condition.label}</span><select value={value?.status ?? 'unknown'} onChange={event => onChange(event.target.value as ConditionConfirmation['status'])}><option value="unknown">Not confirmed</option><option value="satisfied">Confirmed satisfied</option><option value="not_satisfied">Not satisfied</option></select></label>;
}
export function ConditionReview({ plans, events, providers, medications, conditions, onPlanChange, onEventChange }: { plans: Plan[]; events: ExpectedCareEvent[]; providers: ProviderPreference[]; medications: Medication[]; conditions: ConditionConfirmation[]; onPlanChange: (id: string, status: ConditionConfirmation['status']) => void; onEventChange: (eventId: string, id: string, status: ConditionConfirmation['status']) => void }) {
  const groups = plans.map(plan => {
    const general = getPlanConditions(plan);
    const generalIds = new Set(general.map(item => item.id));
    const care = events.map(event => ({ event, requirements: getApplicableConditions(plan, event, providers, medications).filter(item => !generalIds.has(item.id)) })).filter(item => item.requirements.length);
    return { plan, general, care };
  }).filter(group => group.general.length || group.care.length);
  if (!groups.length) return null;
  return <section className="card condition-section"><div className="eyebrow">COVERAGE REQUIREMENTS</div><h3>Confirm what the plan requires.</h3><p className="muted">Use confirmation from the insurer or the relevant source. Past treatment does not establish future authorization. Anything unconfirmed stays unresolved in your estimate.</p>{groups.map(({ plan, general, care }) => <details key={plan.id} open><summary>{plan.name}</summary>{general.map(condition => <ConditionField key={condition.id} condition={condition} value={conditions.find(item => item.conditionId === condition.id)} onChange={status => onPlanChange(condition.id, status)} />)}{care.map(({ event, requirements }) => <div key={event.id}><h4 className="event-condition-title">{event.label} · {event.date}</h4>{requirements.map(condition => <ConditionField key={condition.id} condition={condition} value={event.conditions?.find(item => item.conditionId === condition.id)} onChange={status => onEventChange(event.id, condition.id, status)} />)}</div>)}</details>)}</section>;
}
