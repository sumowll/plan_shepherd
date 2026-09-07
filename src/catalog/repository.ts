import { z } from 'zod';
import type { AppStatus, CatalogCoverage, CatalogSearch, Plan, PlanFamily, ServiceCategory, SourceRef } from '../shared/contracts';
import { PLAN_FAMILIES, SERVICE_CATEGORIES } from '../shared/contracts';
import { dateSchema, stateSchema, type PremiumRate } from './schema';
import {normalizeNdc} from '../shared/identifiers';
import {boundedJsonRows,readBudget,type ReadBudget} from './limits';
export {CatalogReadLimitError} from './limits';
export {readBudget as catalogReadBudget} from './limits';

const searchSchema = z.object({ state: stateSchema, countyFips: z.string().regex(/^\d{5}$/), year: z.number().int().min(2026).max(2100), families: z.array(z.enum(PLAN_FAMILIES)).min(1).max(3).optional(),
  query:z.string().trim().max(100).optional(),releaseId:z.string().min(1).max(180).optional(),
  zip: z.string().regex(/^\d{5}$/).optional(),
  age: z.number().int().min(0).max(120).optional(), dateOfBirth:dateSchema.optional(), tobacco: z.boolean().optional(), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(200000).default(0),
  coverageStart: dateSchema.optional(), coverageEnd: dateSchema.optional() });
export type CatalogQuery = z.input<typeof searchSchema>;
export interface PremiumProfile { countyFips: string; zip?: string; age?: number; dateOfBirth?:string; tobacco?: boolean; coverageStart?: string; coverageEnd?: string }
export interface PriceContext { category:ServiceCategory;serviceCode?:string;providerNpi?:string;providerLocation?:string;rxnorm?:string;ndc?:string;date?:string;daysSupply?:number;dispensedQuantity?:number }
export interface ComponentSelection { providerNpis?: string[]; rxnorms?: string[]; ndcs?: string[]; serviceCodes?: string[];countyFips?:string;priceContexts?:PriceContext[] }
interface JsonRow { data_json: string }
const decode = <T>(row: JsonRow): T => JSON.parse(row.data_json) as T;

async function currentRelease(db: D1Database, requested?: string): Promise<string | null> {
  if (requested) {
    const row = await db.prepare("SELECT id FROM catalog_releases WHERE id=? AND status='published'").bind(requested).first<{id: string}>();
    return row?.id ?? null;
  }
  return (await db.prepare('SELECT release_id FROM catalog_active WHERE singleton=1').first<{release_id: string}>())?.release_id ?? null;
}
export async function catalogStatus(db: D1Database | undefined): Promise<AppStatus['catalog']> {
  if (!db) return { available: false, releaseId: null, planCount: 0 };
  const releaseId = await currentRelease(db);
  if (!releaseId) return { available: false, releaseId: null, planCount: 0 };
  const row = await db.prepare("SELECT COUNT(*) AS count FROM catalog_plans WHERE release_id=? AND status<>'withdrawn'").bind(releaseId).first<{count: number}>();
  return { available: (row?.count ?? 0) > 0, releaseId, planCount: row?.count ?? 0 };
}

function ratingContext(plan:Plan,profile:PremiumProfile){
  const requestedStart=profile.coverageStart??`${plan.year}-01-01`,requestedEnd=profile.coverageEnd??`${plan.year}-12-31`;
  const start=plan.family==='short_term'&&requestedStart<plan.effectiveStart?plan.effectiveStart:requestedStart;
  const end=plan.family==='short_term'&&requestedEnd>plan.effectiveEnd?plan.effectiveEnd:requestedEnd;
  let age=start===requestedStart?profile.age:undefined;
  if(profile.dateOfBirth){const birth=new Date(profile.dateOfBirth),date=new Date(start);age=date.getUTCFullYear()-birth.getUTCFullYear()-(date.getUTCMonth()<birth.getUTCMonth()||date.getUTCMonth()===birth.getUTCMonth()&&date.getUTCDate()<birth.getUTCDate()?1:0);}
  return {start,end,age};
}
export function selectPremium(plan: Plan, rates: PremiumRate[], profile: PremiumProfile): Plan {
  const {start,end,age}=ratingContext(plan,profile);
  const valid = rates.filter(r => r.planId === plan.id && r.countyFips === profile.countyFips && r.effectiveStart <= start && r.effectiveEnd >= end
    && (!r.zipPrefixes || (!!profile.zip && r.zipPrefixes.some(prefix=>profile.zip!.startsWith(prefix))))
    && (age === undefined ? r.minAge === 0 && r.maxAge === 120 : r.minAge <= age && r.maxAge >= age)
    && (r.tobacco === 'any' || (profile.tobacco !== undefined && r.tobacco === (profile.tobacco ? 'yes' : 'no'))));
  // Conflicting/overlapping quotes never silently pick the cheapest, first, or a different age's rate.
  const area=plan.serviceAreas?.find(a=>a.countyFips===profile.countyFips);
  const available=plan.countyFips.includes(profile.countyFips)&&(!plan.serviceAreas||!!area&&(area.wholeCounty||!!profile.zip&&area.zipCodes?.includes(profile.zip)));
  if (!available || valid.length !== 1 || start < plan.effectiveStart || end > plan.effectiveEnd || start > end) return { ...plan, monthlyPremiumCents: null, premiumEstimated: true, rating: undefined,premiumSource:undefined };
  const r = valid[0];
  return { ...plan, monthlyPremiumCents: r.monthlyPremiumCents, premiumEstimated: r.estimated || plan.underwritingRequired,premiumSource:r.source,
    rating: { minAge: r.minAge, maxAge: r.maxAge, age, tobacco: profile.tobacco, countyFips: r.countyFips } };
}

export async function applyPremiumRates(db: D1Database, plans: Plan[], profile: PremiumProfile, releaseId?: string, budget:ReadBudget=readBudget()): Promise<Plan[]> {
  if (!plans.length) return [];
  if (plans.length > 50) throw new Error('At most 50 plans can be rated at once');
  z.object({ countyFips: z.string().regex(/^\d{5}$/), zip:z.string().regex(/^\d{5}$/).optional(), age: z.number().int().min(0).max(120).optional(),dateOfBirth:dateSchema.optional(), tobacco: z.boolean().optional(), coverageStart: dateSchema.optional(), coverageEnd: dateSchema.optional() }).parse(profile);
  const release = await currentRelease(db, releaseId);
  if (!release) return plans.map(p => ({ ...p, monthlyPremiumCents: null, premiumEstimated: true, rating:undefined, premiumSource:undefined }));
  const contexts=plans.map(p=>({planId:p.id,...ratingContext(p,profile)}));
  const select=`SELECT r.data_json FROM catalog_premium_rates r WHERE r.release_id=? AND r.county_fips=?
    AND (r.tobacco='any' OR r.tobacco=?)
    AND (json_extract(r.data_json,'$.zipPrefixes') IS NULL OR EXISTS (SELECT 1 FROM json_each(json_extract(r.data_json,'$.zipPrefixes')) WHERE instr(?,value)=1))
    AND EXISTS (SELECT 1 FROM json_each(?) ctx WHERE r.plan_id=json_extract(ctx.value,'$.planId')
      AND r.effective_start<=json_extract(ctx.value,'$.start') AND r.effective_end>=json_extract(ctx.value,'$.end')
      AND ((json_extract(ctx.value,'$.age') IS NULL AND r.min_age=0 AND r.max_age=120)
        OR (r.min_age<=json_extract(ctx.value,'$.age') AND r.max_age>=json_extract(ctx.value,'$.age'))))`;
  const rates=(await boundedJsonRows<JsonRow>(db,select,[release,profile.countyFips,profile.tobacco===undefined?'unknown':profile.tobacco?'yes':'no',profile.zip??'',JSON.stringify(contexts)],budget)).map(decode<PremiumRate>);
  return plans.map(p => selectPremium(p, rates, profile));
}

function gap(state: string, family: PlanFamily, year: number): CatalogCoverage {
  return { state, family, year, status: 'source_gap', planCount: 0, lastUpdated: null, note: 'No verified source release is published for this state and plan family. This does not mean no plans exist.' };
}
async function hydrateAreas(db:D1Database,plans:Plan[],release:string,budget:ReadBudget,countyFips?:string):Promise<void>{
  if(!plans.length)return;
  const select=`SELECT json_object('planId',c.plan_id,'countyFips',c.county_fips,'wholeCounty',json(CASE WHEN c.whole_county=1 THEN 'true' ELSE 'false' END),'zipCodes',json(c.zip_codes),
    'source',json(CASE WHEN s.data_json IS NULL THEN NULL WHEN c.source_location IS NULL THEN json_remove(s.data_json,'$.location') ELSE json_set(s.data_json,'$.location',c.source_location) END)) AS data_json
    FROM catalog_plan_counties c LEFT JOIN catalog_sources s ON s.release_id=c.release_id AND s.id=c.source_id
    WHERE c.release_id=? AND c.plan_id IN (SELECT value FROM json_each(?))${countyFips?' AND c.county_fips=?':''}`;
  const args=[release,JSON.stringify(plans.map(p=>p.id)),...countyFips?[countyFips]:[]];
  const rows=(await boundedJsonRows<JsonRow>(db,select,args,budget,' ORDER BY c.plan_id,c.county_fips')).map(decode<{planId:string;countyFips:string;wholeCounty:boolean;zipCodes:string[];source:SourceRef|null}>);
  const byPlan=new Map<string,typeof rows>();for(const row of rows){const group=byPlan.get(row.planId)??[];group.push(row);byPlan.set(row.planId,group);}
  for(const plan of plans){
    const legacy=new Map(plan.serviceAreas?.map(area=>[area.countyFips,area.source])??[]);
    plan.serviceAreas=(byPlan.get(plan.id)??[]).map(row=>({countyFips:row.countyFips,wholeCounty:row.wholeCounty,...row.zipCodes.length?{zipCodes:row.zipCodes}:{},...row.source||legacy.get(row.countyFips)?{source:row.source??legacy.get(row.countyFips)}:{}}));
  }
}
export async function searchCatalog(db: D1Database | undefined, query: CatalogQuery): Promise<CatalogSearch> {
  const q = searchSchema.parse(query);
  const families = [...new Set(q.families ?? PLAN_FAMILIES)];
  const empty = { plans: [], coverage: families.map(f => gap(q.state, f, q.year)), releaseId: null, total: 0, warnings: ['Plan data has not been published for this search.'] } satisfies CatalogSearch;
  if (!db) return empty;
  const releaseId = await currentRelease(db,q.releaseId);
  if (!releaseId) return q.releaseId?{...empty,warnings:['The requested catalog release is unavailable. Search again to use the current release.']}:empty;
  const budget=readBudget();
  const where = `p.release_id=? AND p.state=? AND p.year=? AND p.family IN (${families.map(() => '?').join(',')}) AND p.status<>'withdrawn' AND EXISTS (SELECT 1 FROM catalog_plan_counties c WHERE c.release_id=p.release_id AND c.plan_id=p.id AND c.county_fips=? AND (c.whole_county=1 OR EXISTS(SELECT 1 FROM json_each(c.zip_codes) WHERE value=?)))${q.query?" AND (instr(lower(p.name),lower(?))>0 OR instr(lower(json_extract(p.data_json,'$.issuer')),lower(?))>0)":''}`;
  const args = [releaseId,q.state,q.year,...families,q.countyFips,q.zip??'',...q.query?[q.query,q.query]:[]];
  const [rows, count, declarations] = await Promise.all([
    boundedJsonRows<JsonRow>(db,`SELECT p.data_json FROM catalog_plans p WHERE ${where} ORDER BY p.name COLLATE NOCASE,p.id LIMIT ? OFFSET ?`,[...args,q.limit,q.offset],budget),
    db.prepare(`SELECT COUNT(*) AS count FROM catalog_plans p WHERE ${where}`).bind(...args).first<{count: number}>(),
    db.prepare('SELECT data_json FROM catalog_coverage WHERE release_id=? AND state=? AND year=?').bind(releaseId,q.state,q.year).all<JsonRow>()
  ]);
  const declared = declarations.results.map(decode<CatalogCoverage>);
  const coverage = families.map(f => declared.find(c => c.family === f) ?? gap(q.state,f,q.year));
  const summaries=rows.map(decode<Plan>);await hydrateAreas(db,summaries,releaseId,budget,q.countyFips);
  const plans = await applyPremiumRates(db, summaries, q, releaseId,budget);
  const warnings: string[] = [];
  if (coverage.some(c => c.status === 'source_gap')) warnings.push('Some requested plan categories have incomplete sources. Available results are not a complete national catalog.');
  if (plans.some(p => p.monthlyPremiumCents === null)) warnings.push('Some premiums are unknown: an unambiguous rate matching age, tobacco, county and the requested coverage period is required.');
  if (plans.some(p => !p.rulesVerified)) warnings.push('Some benefit rules require verification; their cost estimates may be incomplete.');
  return { plans,coverage,releaseId,total: count?.count ?? 0,warnings };
}

export async function getPlans(db: D1Database, ids: string[], releaseId?: string, selection?: ComponentSelection,budget:ReadBudget=readBudget()): Promise<Plan[]> {
  z.array(z.string().min(1).max(180)).max(50).parse(ids);
  if (!ids.length) return [];
  const release = await currentRelease(db, releaseId);
  if (!release) return [];
  const uniqueIds = [...new Set(ids)];
  const plans = (await boundedJsonRows<JsonRow>(db,`SELECT data_json FROM catalog_plans WHERE release_id=? AND id IN (${uniqueIds.map(() => '?').join(',')})`,[release,...uniqueIds],budget)).map(decode<Plan>);
  const countyFips=z.string().regex(/^\d{5}$/).optional().parse(selection?.countyFips);
  await hydrateAreas(db,plans,release,budget,countyFips);
  const boundedKeys = (values: string[]|undefined,maxLength:number,normalize=(value:string)=>value) => {
    const checked=z.array(z.string().trim().max(maxLength)).max(10000).parse(values??[]);
    return z.array(z.string()).max(2000).parse([...new Set(checked.map(normalize).filter(Boolean))]);
  };
  const normalizedLocation=(value:string|undefined)=>(value??'').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ');
  const contextSchema=z.object({category:z.enum(SERVICE_CATEGORIES),serviceCode:z.string().trim().max(250).optional(),providerNpi:z.string().regex(/^\d{10}$/).optional(),providerLocation:z.string().max(250).transform(normalizedLocation).optional(),rxnorm:z.string().max(30).optional(),ndc:z.string().max(30).transform(normalizeNdc).optional(),date:dateSchema.optional(),daysSupply:z.number().positive().max(366).optional(),dispensedQuantity:z.number().positive().max(100000).optional()});
  const parsedContexts=selection?.priceContexts===undefined?undefined:z.array(contextSchema).max(2000).parse(selection.priceContexts);
  const contexts=parsedContexts?[...new Map(parsedContexts.map(context=>[JSON.stringify(context),context])).values()]:undefined;
  const providerKeys = boundedKeys([...selection?.providerNpis??[],...contexts?.flatMap(c=>c.providerNpi?[c.providerNpi]:[])??[]],10),
    rxKeys = boundedKeys([...selection?.rxnorms??[],...contexts?.flatMap(c=>c.rxnorm?[c.rxnorm]:[])??[]],30),
    ndcKeys = boundedKeys([...selection?.ndcs??[],...contexts?.flatMap(c=>c.ndc?[c.ndc]:[])??[]],30,normalizeNdc),
    serviceKeys=boundedKeys([...selection?.serviceCodes??[],...contexts?.flatMap(c=>c.serviceCode?[c.serviceCode]:[])??[]],250);
  const categoryKeys=contexts?[...new Set(contexts.map(c=>c.category))]:SERVICE_CATEGORIES;
  const medications=[...new Set([...rxKeys,...ndcKeys])];
  const contextMatch=(price:Plan['prices'][number],context:PriceContext)=>price.category===context.category
    &&(!price.serviceCode||price.serviceCode===context.serviceCode)&&(!price.providerNpi||price.providerNpi===context.providerNpi)
    &&(!price.providerLocation||normalizedLocation(price.providerLocation)===context.providerLocation)
    &&(!price.medicationCode||price.medicationCode===context.rxnorm||price.medicationCode===context.ndc)
    &&(!context.date||!price.source.effectiveDate||price.source.effectiveDate<=context.date)
    &&(price.category!=='prescription'||((price.quantityUnit==='fill'||price.quantityUnit==='dispensed_unit')&&(!price.daysSupply||price.daysSupply===context.daysSupply)&&(!price.dispensedQuantity||price.dispensedQuantity===context.dispensedQuantity)));
  for (const plan of plans) {
    // The catalog stores directory/formulary rows separately. Compare routes can select exact patient identifiers without persisting them.
    for (const kind of ['provider','drug','price'] as const) {
      const values: (string|number)[] = [release,plan.id,kind];
      let filter = '';
      if (selection && kind !== 'price') {
        const keys = kind === 'provider' ? providerKeys : rxKeys;
        const clauses: string[] = [];
        if (keys.length) { clauses.push('lookup_key IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(keys)); }
        if (kind === 'drug' && ndcKeys.length) { clauses.push('lookup_key_2 IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(ndcKeys)); }
        if (!clauses.length) { if (kind === 'provider') plan.providers=[]; else plan.drugs=[]; continue; }
        filter = ` AND (${clauses.join(' OR ')})`;
      }
      if(selection&&kind==='price'){
        if(contexts?.length===0){plan.prices=[];continue;}
        filter=` AND ((json_extract(c.data_json,'$.serviceCode') IS NULL AND c.lookup_key IN (SELECT value FROM json_each(?))) OR c.lookup_key IN (SELECT value FROM json_each(?)))
          AND (c.lookup_key_2 IS NULL OR c.lookup_key_2 IN (SELECT value FROM json_each(?)))
          AND (json_extract(c.data_json,'$.providerNpi') IS NULL OR json_extract(c.data_json,'$.providerNpi') IN (SELECT value FROM json_each(?)))`;
        values.push(JSON.stringify(categoryKeys),JSON.stringify(serviceKeys),JSON.stringify(medications),JSON.stringify(providerKeys));
        if(contexts){
          filter+=` AND EXISTS (SELECT 1 FROM json_each(?) ctx WHERE json_extract(c.data_json,'$.category')=json_extract(ctx.value,'$.category')
            AND (json_extract(c.data_json,'$.serviceCode') IS NULL OR json_extract(c.data_json,'$.serviceCode')=json_extract(ctx.value,'$.serviceCode'))
            AND (json_extract(c.data_json,'$.providerNpi') IS NULL OR json_extract(c.data_json,'$.providerNpi')=json_extract(ctx.value,'$.providerNpi'))
            AND (NULLIF(c.location_key,'') IS NULL OR c.location_key=json_extract(ctx.value,'$.providerLocation'))
            AND (c.lookup_key_2 IS NULL OR c.lookup_key_2=json_extract(ctx.value,'$.rxnorm') OR c.lookup_key_2=json_extract(ctx.value,'$.ndc'))
            AND (json_extract(ctx.value,'$.date') IS NULL OR json_extract(c.data_json,'$.source.effectiveDate') IS NULL OR json_extract(c.data_json,'$.source.effectiveDate')<=json_extract(ctx.value,'$.date'))
            AND (json_extract(c.data_json,'$.category')<>'prescription' OR (json_extract(c.data_json,'$.quantityUnit') IN ('fill','dispensed_unit')
              AND (json_extract(c.data_json,'$.daysSupply') IS NULL OR json_extract(c.data_json,'$.daysSupply')=json_extract(ctx.value,'$.daysSupply'))
              AND (json_extract(c.data_json,'$.dispensedQuantity') IS NULL OR json_extract(c.data_json,'$.dispensedQuantity')=json_extract(ctx.value,'$.dispensedQuantity')))))`;
          values.push(JSON.stringify(contexts));
        }
      }
      const rows = await boundedJsonRows<JsonRow>(db,`SELECT c.data_json FROM catalog_components c WHERE release_id=? AND plan_id=? AND kind=?${filter}`,values,budget,' ORDER BY c.ordinal');
      if (kind === 'provider') plan.providers = rows.map(decode<Plan['providers'][number]>);
      if (kind === 'drug') plan.drugs = rows.map(decode<Plan['drugs'][number]>);
      if (kind === 'price') plan.prices = rows.map(decode<Plan['prices'][number]>).filter(price=>!contexts||contexts.some(context=>contextMatch(price,context)));
    }
  }
  const map = new Map(plans.map(p => [p.id,p]));
  return uniqueIds.flatMap(id => map.has(id) ? [map.get(id)!] : []);
}
