import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Plan, BenefitRule, ServiceCategory } from '../../src/shared/contracts';
import { catalogSchema, sourceSchema, stateSchema, validateCatalog, type CanonicalCatalog, type PremiumRate } from '../../src/catalog/schema';
import { readCsv } from './csv';

const fileSchema=z.strictObject({path:z.string().min(1),entry:z.string().optional(),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),source:sourceSchema});
export const cmsManifestSchema=z.strictObject({ schemaVersion:z.literal(1),release:catalogSchema.shape.release,
  states:z.array(stateSchema).min(1).max(51),planAttributes:fileSchema,serviceAreas:fileSchema,benefits:fileSchema.optional(),rates:fileSchema.optional(),
  // Mapping must be obtained from authoritative state/CMS geographic rating data. County-only entries must cover the entire county.
  ratingGeography:z.array(z.strictObject({state:stateSchema,countyFips:z.string().regex(/^\d{5}$/),ratingAreaId:z.string().min(1),zipPrefixes:z.array(z.string().regex(/^\d{3}(?:\d{2})?$/)).min(1).max(1000).optional(),source:sourceSchema})).max(10000).default([]),
  stateCountyGeography:z.array(z.strictObject({state:stateSchema,countyFips:z.string().regex(/^\d{5}$/),source:sourceSchema})).max(10000).default([])
});
export type CmsManifest=z.infer<typeof cmsManifestSchema>;
export function cmsMoney(value:string|undefined):number|null{
  if(!value)return null; const normalized=value.replace(/[$,]/g,'').trim();
  if(!/^\d+(\.\d{1,2})?$/.test(normalized))return null;
  const [whole,cents='']=normalized.split('.');const result=Number(whole)*100+Number(cents.padEnd(2,'0'));
  return Number.isSafeInteger(result)?result:null;
}
export function cmsAge(value:string):[number,number]|null{
  if(/^\d{1,2}$/.test(value)){const age=Number(value);return [age,age];}
  if(value==='0-14')return [0,14];if(value==='64 and over')return [64,120];
  // Family Option has distinct rating semantics and is not silently converted to individual age-based pricing.
  return null;
}
function cmsDate(value:string):string{
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: 0:00:00)?$/.exec(value);
  if(!m)throw new Error('Unsupported CMS rate effective-date format');
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}
const categoryMap:Record<string,ServiceCategory>={
  'Primary Care Visit to Treat an Injury or Illness':'primary_care','Specialist Visit':'specialist','Urgent Care Centers or Facilities':'urgent_care',
  'Emergency Room Services':'emergency','Inpatient Hospital Services (e.g., Hospital Stay)':'hospital','Outpatient Facility Fee (e.g., Ambulatory Surgery Center)':'outpatient',
  'Laboratory Outpatient and Professional Services':'lab','Imaging (CT/PET Scans, MRIs)':'imaging','Rehabilitative Occupational and Rehabilitative Physical Therapy':'therapy',
  'Mental/Behavioral Health Outpatient Services':'mental_health','Preventive Care/Screening/Immunization':'preventive',
  'Generic Drugs':'prescription','Preferred Brand Drugs':'prescription','Non-Preferred Brand Drugs':'prescription','Specialty Drugs':'prescription'
};
export function cmsBenefit(row:Record<string,string>,source:z.infer<typeof sourceSchema>,ordinal:number):BenefitRule{
  const copay=row.CopayInnTier1??'',coinsurance=row.CoinsInnTier1??'';
  const simpleCopay=/^\$([\d,.]+) Copay(?: after deductible)?$/.exec(copay);
  const percent=/^(\d+(?:\.\d{1,2})?)%(?: Coinsurance)?(?: after deductible)?$/.exec(coinsurance);
  const noCharge=/^No Charge(?: after deductible)?$/;
  const coverage=row.IsCovered==='Covered'?'covered':row.IsCovered==='Not Covered'||row.IsCovered===''?'not_covered':'unknown';
  const category=categoryMap[row.BenefitName]??'other';
  const explanation=['Copay: '+(copay||'unspecified'),'Coinsurance: '+(coinsurance||'unspecified'),row.Exclusions,row.Explanation,
    row.QuantLimitOnSvc==='Yes'?`Limit: ${row.LimitQty} ${row.LimitUnit}`:''].filter(Boolean).join('; ');
  const rule:BenefitRule={id:`cms-benefit-${ordinal}`,label:row.BenefitName,category,coverage,network:'in_network',
    copayCents:simpleCopay?cmsMoney(simpleCopay[1]):noCharge.test(copay)?0:null,
    coinsuranceBps:percent?Math.round(Number(percent[1])*100):noCharge.test(coinsurance)?0:null,
    appliesDeductible:/after deductible/.test(`${copay} ${coinsurance}`),accumulator:category==='prescription'?'drug':'medical',explanation,source};
  // Preserve complex conditions rather than turning per-day/stay limits or exclusions into unconditional copays.
  if(row.Exclusions||row.Explanation||row.QuantLimitOnSvc==='Yes'||/per Day|per Stay|with deductible/.test(`${copay} ${coinsurance}`))
    rule.conditions=[{id:`cms-condition-${ordinal}`,label:explanation,source}];
  return rule;
}

export async function convertCmsAca(manifestValue:unknown):Promise<{catalog:CanonicalCatalog;report:Record<string,unknown>}>{
  const m=cmsManifestSchema.parse(manifestValue),year=m.release.year,states=new Set<string>(m.states);
  for(const file of [m.planAttributes,m.serviceAreas,m.benefits,m.rates])if(file){
    if(file.source.sha256&&file.source.sha256!==file.sha256.toLowerCase())throw new Error('Source provenance checksum conflicts with file checksum');
    file.source.sha256=file.sha256.toLowerCase();
  }
  const warnings=new Map<string,number>();const warn=(name:string)=>warnings.set(name,(warnings.get(name)??0)+1);
  const validRow=(r:Record<string,string>)=>r.BusinessYear===String(year)&&states.has(r.StateCode);
  const ratingByArea=new Map<string,CmsManifest['ratingGeography']>(),countiesByState=new Map<string,CmsManifest['stateCountyGeography']>();
  for(const geo of m.ratingGeography){const key=`${geo.state}:${geo.ratingAreaId}`;ratingByArea.set(key,[...ratingByArea.get(key)??[],geo]);}
  for(const geo of m.stateCountyGeography)countiesByState.set(geo.state,[...countiesByState.get(geo.state)??[],geo]);
  const areas=new Map<string,Map<string,{countyFips:string;wholeCounty:boolean;zipCodes?:string[]}>>();
  for await(const row of readCsv(m.serviceAreas,['BusinessYear','StateCode','IssuerId','ServiceAreaId','CoverEntireState','County','PartialCounty'])){
    if(!validRow(row))continue;
    const key=`${row.StateCode}:${row.IssuerId}:${row.ServiceAreaId}`;
    const counties=areas.get(key)??new Map<string,{countyFips:string;wholeCounty:boolean;zipCodes?:string[]}>();areas.set(key,counties);
    if(row.CoverEntireState==='Yes'){
      const mapped=countiesByState.get(row.StateCode)??[];
      if(!mapped.length)warn('Statewide service areas missing authoritative county expansion');
      for(const county of mapped)counties.set(county.countyFips,{countyFips:county.countyFips,wholeCounty:true});
    }else if(row.CoverEntireState==='No'&&/^\d{5}$/.test(row.County)){
      if(row.PartialCounty==='No')counties.set(row.County,{countyFips:row.County,wholeCounty:true});
      else if(row.PartialCounty==='Yes'){
        const zips=(row.ZipCodes??'').split(',').map(z=>z.trim());
        if(!zips.length||zips.some(zip=>!/^\d{5}$/.test(zip)))throw new Error('Partial county has missing or invalid CMS ZIP list');
        const existing=counties.get(row.County);
        if(!existing?.wholeCounty)counties.set(row.County,{countyFips:row.County,wholeCounty:false,zipCodes:[...new Set([...(existing?.zipCodes??[]),...zips])].sort()});
      }else warn('Unrecognized county service area omitted');
    }else warn('Unrecognized county service area omitted');
  }
  const plans:Plan[]=[],byVariant=new Map<string,Plan>(),byComponent=new Map<string,Plan[]>();
  for await(const row of readCsv(m.planAttributes,['BusinessYear','StateCode','IssuerId','StandardComponentId','PlanId','PlanMarketingName','ServiceAreaId','DentalOnlyPlan','MarketCoverage','CSRVariationType'])){
    if(!validRow(row)||row.DentalOnlyPlan!=='No'||row.MarketCoverage!=='Individual'||/Off Exchange/i.test(row.CSRVariationType))continue;
    if(!/^\d{5}[A-Z]{2}\d{7}-\d{2}$/.test(row.PlanId)||row.PlanId.slice(0,14)!==row.StandardComponentId)throw new Error('Invalid CMS HIOS plan/variant identity');
    const serviceAreas=[...areas.get(`${row.StateCode}:${row.IssuerId}:${row.ServiceAreaId}`)?.values()??[]].map(area=>({...area,source:{...m.serviceAreas.source,location:`IssuerId=${row.IssuerId}; ServiceAreaId=${row.ServiceAreaId}; County=${area.countyFips}`}}));
    const counties=serviceAreas.map(a=>a.countyFips).sort();
    if(!counties.length){warn('Plans omitted because service area could not be resolved safely');continue;}
    if(byVariant.has(row.PlanId))throw new Error('Duplicate CMS plan variants require source reconciliation');
    const source={...m.planAttributes.source,location:`PlanId=${row.PlanId}`};
    const plan:Plan={id:`aca:${year}:${row.PlanId}`,name:row.PlanVariantMarketingName||row.PlanMarketingName,
      issuer:row.IssuerMarketplaceMarketingName||`HIOS issuer ${row.IssuerId}`,family:'aca',year,state:row.StateCode,countyFips:counties,serviceAreas,status:'unknown',
      effectiveStart:`${year}-01-01`,effectiveEnd:`${year}-12-31`,monthlyPremiumCents:null,premiumEstimated:true,
      deductibleCents:cmsMoney(row.TEHBInnTier1IndividualDeductible)??cmsMoney(row.MEHBInnTier1IndividualDeductible),
      oopMaxCents:cmsMoney(row.TEHBInnTier1IndividualMOOP)??cmsMoney(row.MEHBInnTier1IndividualMOOP),
      drugDeductibleCents:cmsMoney(row.DEHBInnTier1IndividualDeductible),drugOopMaxCents:cmsMoney(row.DEHBInnTier1IndividualMOOP),
      metalLevel:row.MetalLevel,planType:row.PlanType,benefits:[],providers:[],drugs:[],prices:[],source,documentUrls:[],rulesVerified:false,underwritingRequired:false,networkComplete:false,formularyComplete:false};
    if(row.CSRVariationType && !/^Standard.*On Exchange Plan$/.test(row.CSRVariationType))plan.conditions=[{id:`csr:${row.PlanId}`,label:`Requires confirmed eligibility for ${row.CSRVariationType}`,source}];
    for(const [field,label]of [['URLForSummaryofBenefitsCoverage','Summary of benefits and coverage'],['FormularyURL','Issuer formulary'],['PlanBrochure','Plan brochure']]as const){const url=row[field];if(url&&/^https:\/\//.test(url))plan.documentUrls.push({label,url});}
    plans.push(plan);byVariant.set(row.PlanId,plan);byComponent.set(row.StandardComponentId,[...byComponent.get(row.StandardComponentId)??[],plan]);
  }
  if(m.benefits){let ordinal=0;for await(const row of readCsv(m.benefits,['BusinessYear','StateCode','PlanId','BenefitName','IsCovered','CopayInnTier1','CoinsInnTier1'])){
    if(!validRow(row))continue;const plan=byVariant.get(row.PlanId);if(!plan)continue;
    plan.benefits.push(cmsBenefit(row,{...m.benefits.source,location:`PlanId=${row.PlanId}; BenefitName=${row.BenefitName}`},ordinal++));
  }}
  const premiumRates:PremiumRate[]=[];
  if(m.rates)for await(const row of readCsv(m.rates,['BusinessYear','StateCode','PlanId','RatingAreaId','Age','Tobacco','IndividualRate','IndividualTobaccoRate','RateEffectiveDate','RateExpirationDate'])){
    if(!validRow(row))continue;const variants=byComponent.get(row.PlanId);if(!variants)continue;
    const ages=cmsAge(row.Age);if(!ages){warn('Unsupported family-tier or age-rate rows omitted');continue;}
    const mapped=ratingByArea.get(`${row.StateCode}:${row.RatingAreaId}`)??[];
    if(!mapped.length){warn('Premium rows omitted because county-to-rating-area mapping is unavailable');continue;}
    const quotes:{tobacco:'any'|'yes'|'no';value:number|null}[]=row.Tobacco==='No Preference'?[{tobacco:'any',value:cmsMoney(row.IndividualRate)}]:row.Tobacco==='Tobacco User/Non-Tobacco User'?[{tobacco:'no',value:cmsMoney(row.IndividualRate)},{tobacco:'yes',value:cmsMoney(row.IndividualTobaccoRate)}]:[];
    if(!quotes.length){warn('Unrecognized tobacco rate semantics');continue;}
    for(const plan of variants)for(const geo of mapped)if(plan.countyFips.includes(geo.countyFips))for(const quote of quotes){
      if(quote.value===null){warn('Missing or nonnumeric individual premium');continue;}
      const effectiveStart=cmsDate(row.RateEffectiveDate),effectiveEnd=cmsDate(row.RateExpirationDate);
      const identity=[plan.id,geo.countyFips,geo.zipPrefixes??[],ages[0],ages[1],quote.tobacco,effectiveStart,effectiveEnd];
      premiumRates.push({id:`cms-rate:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,planId:plan.id,countyFips:geo.countyFips,minAge:ages[0],maxAge:ages[1],tobacco:quote.tobacco,effectiveStart,effectiveEnd,
        zipPrefixes:geo.zipPrefixes,monthlyPremiumCents:quote.value,estimated:false,source:{...m.rates.source,location:`PlanId=${row.PlanId}; RatingAreaId=${row.RatingAreaId}; Age=${row.Age}; Tobacco=${quote.tobacco}; geography-source=${geo.source.id}`}});
    }
  }
  const sources=new Map<string,z.infer<typeof sourceSchema>>();
  for(const file of [m.planAttributes,m.serviceAreas,m.benefits,m.rates])if(file)sources.set(file.source.id,file.source);
  for(const geo of [...m.ratingGeography,...m.stateCountyGeography])sources.set(geo.source.id,geo.source);
  const coverage=m.states.map(state=>({state,family:'aca' as const,year,status:'source_gap' as const,planCount:plans.filter(p=>p.state===state).length,lastUpdated:m.release.createdAt,
    note:'CMS PUF baseline. Enrollment status, rating geography, partial counties, benefit conditions, provider networks, formularies and national/state completeness require source reconciliation.'}));
  const catalog=validateCatalog({schemaVersion:1,dataClass:'public_reference',release:m.release,sources:[...sources.values()],plans,premiumRates,coverage});
  return {catalog,report:{releaseId:m.release.id,plans:plans.length,premiumRates:premiumRates.length,warnings:Object.fromEntries(warnings),rulesVerified:false}};
}

export async function cmsMain(argv:string[]):Promise<void>{
  const {values}=parseArgs({args:argv,options:{manifest:{type:'string'},output:{type:'string'}},strict:true});
  if(!values.manifest||!values.output)throw new Error('Usage: tsx scripts/catalog/cms-aca.ts --manifest cms-files.json --output canonical.json');
  const path=resolve(values.manifest),m=cmsManifestSchema.parse(JSON.parse(await readFile(path,'utf8')));
  for(const file of [m.planAttributes,m.serviceAreas,m.benefits,m.rates])if(file)file.path=resolve(dirname(path),file.path);
  const {catalog,report}=await convertCmsAca(m);
  await writeFile(resolve(values.output),JSON.stringify(catalog),{flag:'wx',mode:0o600});
  await writeFile(`${resolve(values.output)}.report.json`,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))cmsMain(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'CMS conversion failed'}\n`);process.exitCode=1;});
