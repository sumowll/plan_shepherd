import { describe,expect,it,beforeEach,afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { validateCatalog, type CanonicalCatalog } from '../../src/catalog/schema';
import { catalogStatements,sqlValue,sqlInsert } from '../../scripts/catalog/sql';
import { catalogStatus,searchCatalog,getPlans,applyPremiumRates,selectPremium,CatalogReadLimitError,catalogReadBudget } from '../../src/catalog/repository';
import type { Plan } from '../../src/shared/contracts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectBundle,bundleStatements} from '../../scripts/catalog/bundle';
import {matchMedication} from '../../src/domain/matching';
import {normalizeNdc} from '../../src/shared/identifiers';
import {countiesForState} from '../../src/catalog/geography';

// Synthetic fixtures are confined to tests. No example plans are shipped in the serving database.
const source={id:'fixture-source',publisher:'Test publisher',url:'https://example.org/public-plans',retrievedAt:'2026-09-01T00:00:00Z',effectiveDate:'2026-01-01',version:'test-v1'};
const migrate=(sql:DatabaseSync)=>{for(const file of ['0001_public_catalog.sql','0002_publication_guards.sql','0003_catalog_projection.sql'])sql.exec(readFileSync(`migrations/${file}`,'utf8'));};
function fixture(release='test-v1'):CanonicalCatalog {
 const p={id:'aca:2026:test-01',name:"O'Brien Test Plan",issuer:'Test issuer',family:'aca',year:2026,state:'MA',countyFips:['25017'],status:'available',effectiveStart:'2026-01-01',effectiveEnd:'2026-12-31',monthlyPremiumCents:null,premiumEstimated:true,deductibleCents:100000,oopMaxCents:700000,drugDeductibleCents:null,drugOopMaxCents:null,benefits:[],providers:[{npi:'1234567890',name:'Test provider',location:'Test location',network:'in_network',source}],drugs:[],prices:[],source,documentUrls:[],rulesVerified:true,underwritingRequired:false,networkComplete:false,formularyComplete:false};
 return validateCatalog({schemaVersion:1,dataClass:'public_reference',release:{id:release,year:2026,createdAt:'2026-09-01T00:00:00Z',publisher:'Testing only',productionData:true,rightsConfirmed:true,provenanceReviewedBy:'Test suite'},sources:[source],plans:[p],premiumRates:[{id:'rate-40',planId:p.id,countyFips:'25017',minAge:40,maxAge:40,tobacco:'no',effectiveStart:'2026-01-01',effectiveEnd:'2026-12-31',monthlyPremiumCents:50000,estimated:false,source},{id:'rate-41',planId:p.id,countyFips:'25017',minAge:41,maxAge:41,tobacco:'no',effectiveStart:'2026-01-01',effectiveEnd:'2026-12-31',monthlyPremiumCents:52000,estimated:false,source}],coverage:[{state:'MA',family:'aca',year:2026,status:'available',planCount:1,lastUpdated:source.retrievedAt,note:'Test coverage only'}]});
}
function d1(sqlite:DatabaseSync):D1Database {
 return {prepare(sql:string){return {bind(...args:unknown[]){const statement=sqlite.prepare(sql);return {async first(){return statement.get(...args as never[])??null;},async all(){return {results:statement.all(...args as never[]),success:true};},async run(){return statement.run(...args as never[]);}};},async first(){return sqlite.prepare(sql).get()??null;},async all(){return {results:sqlite.prepare(sql).all(),success:true};}};}} as unknown as D1Database;
}
describe('public catalog validation',()=>{
 it('rejects unsupported fields that could conceal patient records',()=>{const c=fixture();expect(()=>validateCatalog({...c,patient:{name:'Private'}})).toThrow();expect(()=>validateCatalog({...c,dataClass:'patient_data'})).toThrow();});
 it('rejects orphan rates, missing provenance and age-independent base premiums',()=>{
  const c=fixture();expect(()=>validateCatalog({...c,premiumRates:[{...c.premiumRates[0],planId:'missing'}]})).toThrow();
  expect(()=>validateCatalog({...c,plans:[{...c.plans[0],source:{...source,url:'https://example.org/different'}}]})).toThrow();
  expect(()=>validateCatalog({...c,plans:[{...c.plans[0],monthlyPremiumCents:40000}]})).toThrow();
  expect(()=>validateCatalog({...c,plans:[{...c.plans[0],countyFips:['36061']}]})).toThrow();
 });
 it('rejects misleading absence and duplicate plan declarations',()=>{
  const c=fixture();expect(()=>validateCatalog({...c,coverage:[{...c.coverage[0],status:'not_offered'}]})).toThrow();
  expect(()=>validateCatalog({...c,plans:[...c.plans,...c.plans]})).toThrow();
 });
 it('preserves advanced deterministic cost fields and rejects invalid phase source',()=>{
  const c=fixture();const extended={...c.plans[0],accumulators:[{id:'combined',deductibleCents:100000,oopMaxCents:700000}],drugBenefitPhases:{source,phases:[{id:'phase-1',label:'Initial',until:null,coinsuranceBps:2500,patientOopCreditBps:10000,additionalOopCreditBps:0}]}};
  expect(validateCatalog({...c,plans:[extended]}).plans[0].drugBenefitPhases).toEqual(extended.drugBenefitPhases);
  expect(()=>validateCatalog({...c,plans:[{...extended,drugBenefitPhases:{...extended.drugBenefitPhases,source:{...source,id:'unregistered'}}}]})).toThrow();
 });
 it('accepts sourced drug-deductible phases and bounds separate deductible credits',()=>{
  const c=fixture();c.plans[0].drugBenefitPhases={source,phases:[{id:'deductible',label:'Deductible phase',until:{ledger:'drug_deductible',cents:50000},coinsuranceBps:10000,patientOopCreditBps:10000,additionalOopCreditBps:0}]};
  c.plans[0].benefits=[{id:'rx',label:'Covered drug',category:'prescription',coverage:'covered',network:'any',copayCents:1000,coinsuranceBps:0,appliesDeductible:false,accumulator:'drug',explanation:'Test credit fixture',source,drugPhaseOverrides:{deductible:{coinsuranceBps:0,deductibleCreditBps:0}}}];
  expect(validateCatalog(c).plans[0].benefits[0].drugPhaseOverrides?.deductible.deductibleCreditBps).toBe(0);
  c.plans[0].benefits[0].drugPhaseOverrides!.deductible.deductibleCreditBps=10001;expect(()=>validateCatalog(c)).toThrow();
 });
});

describe('partitioned national release assembly',()=>{
 it('combines disjoint partitions into one release and verifies files again before publication',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-bundle-test-'));
  const sql=new DatabaseSync(':memory:');migrate(sql);
  try{
   const ma=fixture(),ny=fixture('test-ny');ny.plans[0].id='aca:2026:test-ny';ny.plans[0].state='NY';ny.plans[0].countyFips=['36061'];
   ny.premiumRates=ny.premiumRates.map(r=>({...r,id:`${r.id}-ny`,planId:ny.plans[0].id,countyFips:'36061'}));ny.coverage[0].state='NY';
   const parts=[];for(const [name,c]of [['ma',ma],['ny',ny]]as const){const json=JSON.stringify(c);await writeFile(join(dir,`${name}.json`),json);parts.push({path:`${name}.json`,sha256:createHash('sha256').update(json).digest('hex')});}
   const manifestPath=join(dir,'bundle.json');await writeFile(manifestPath,JSON.stringify({schemaVersion:1,release:{...ma.release,id:'national'},parts}));
   const inspected=await inspectBundle(manifestPath);expect(inspected.counts.plans).toBe(2);expect(inspected.sources).toHaveLength(1);
   for await(const statement of bundleStatements(inspected))sql.exec(statement);
   expect(await catalogStatus(d1(sql))).toEqual({available:true,releaseId:'national',planCount:2});
   await writeFile(join(dir,'ma.json'),'changed');
   await expect(async()=>{for await(const statement of bundleStatements(inspected))void statement;}).rejects.toThrow(/checksum/);
  }finally{sql.close();await rm(dir,{recursive:true,force:true});}
 });
});
describe('D1 catalog publication and queries using real SQLite',()=>{
 let sql:DatabaseSync,db:D1Database;
 beforeEach(()=>{sql=new DatabaseSync(':memory:');migrate(sql);db=d1(sql);});
 afterEach(()=>sql.close());
 const publish=(sql:DatabaseSync,c:CanonicalCatalog)=>{for(const statement of catalogStatements(c))sql.exec(statement);};
 it('distinguishes missing source from a verified no-offer declaration',async()=>{
  expect((await searchCatalog(db,{state:'MA',countyFips:'25017',year:2026})).coverage.every(c=>c.status==='source_gap')).toBe(true);
  const c=fixture();c.coverage.push({state:'MA',family:'short_term',year:2026,status:'not_offered',planCount:0,lastUpdated:source.retrievedAt,note:'Fixture authoritative absence'});publish(sql,c);
  const result=await searchCatalog(db,{state:'MA',countyFips:'25017',year:2026,age:40,tobacco:false});
  expect(result.coverage.find(c=>c.family==='short_term')?.status).toBe('not_offered');expect(result.coverage.find(c=>c.family==='medicare_advantage')?.status).toBe('source_gap');
 });
 it('never exposes a partial load and atomically changes pinned releases',async()=>{
  publish(sql,fixture());const next=fixture('test-v2');next.plans[0].name='New release';const statements=[...catalogStatements(next)];
  sql.exec(statements[0]);expect(()=>sql.exec("UPDATE catalog_releases SET status='published' WHERE id='test-v2'")).toThrow(/incomplete/);
  expect((await catalogStatus(db)).releaseId).toBe('test-v1');
  for(const statement of statements.slice(1,-1))sql.exec(statement);
  expect((await catalogStatus(db)).releaseId).toBe('test-v1');sql.exec(statements.at(-1)!);
  expect((await catalogStatus(db)).releaseId).toBe('test-v2');
  expect((await getPlans(db,[next.plans[0].id],'test-v1'))[0].name).toBe("O'Brien Test Plan");
  expect((await getPlans(db,[next.plans[0].id],'test-v2'))[0].name).toBe('New release');
 });
 it('published rows cannot mutate and SQL literals do not execute embedded statements',()=>{
  const c=fixture();c.plans[0].name="Test'); DROP TABLE catalog_plans; --";publish(sql,c);
  expect(sql.prepare('SELECT name FROM catalog_plans').get()?.name).toBe(c.plans[0].name);
  expect(()=>sql.exec("DELETE FROM catalog_plans WHERE release_id='test-v1'")).toThrow(/immutable/);
  expect(sqlValue("O'Brien")).toBe("'O''Brien'");
 });
 it('cannot bypass publication checks by inserting a published release or moving staging rows',()=>{
  publish(sql,fixture());const next=fixture('staging-v2'),header=[...catalogStatements(next)][0];sql.exec(header);
  sql.exec("INSERT INTO catalog_sources(release_id,id,data_json) VALUES('staging-v2','new-source','{}')");
  expect(()=>sql.exec("UPDATE catalog_sources SET release_id='test-v1' WHERE release_id='staging-v2'")).toThrow(/immutable/);
  expect(()=>sql.exec("INSERT INTO catalog_releases SELECT 'bypass',year,created_at,metadata_json,expected_plans,expected_rates,expected_sources,expected_coverage,expected_components,expected_counties,'published' FROM catalog_releases WHERE id='staging-v2'")).toThrow(/staged/);
 });
 it('selects exact age/tobacco/geography/year rates and no guessed premium',async()=>{
  publish(sql,fixture());const q={state:'MA',countyFips:'25017',year:2026} as const;
  expect((await searchCatalog(db,{...q,age:40,tobacco:false})).plans[0].monthlyPremiumCents).toBe(50000);
  expect((await searchCatalog(db,{...q,age:41,tobacco:false})).plans[0].monthlyPremiumCents).toBe(52000);
  expect((await searchCatalog(db,{...q,age:39,tobacco:false})).plans[0].monthlyPremiumCents).toBeNull();
  expect((await searchCatalog(db,{...q,age:40,tobacco:true})).plans[0].monthlyPremiumCents).toBeNull();
  expect((await searchCatalog(db,q)).plans[0].monthlyPremiumCents).toBeNull();
  expect((await searchCatalog(db,{...q,countyFips:'25025'})).plans).toHaveLength(0);
  expect((await searchCatalog(db,{...q,year:2027})).plans).toHaveLength(0);
  const plans=await getPlans(db,[fixture().plans[0].id],'test-v1',{providerNpis:['1234567890']});
  expect(plans[0].providers).toHaveLength(1);expect(plans[0].monthlyPremiumCents).toBeNull();
  expect((await applyPremiumRates(db,plans,{countyFips:'25017',age:40,tobacco:false},'test-v1'))[0].monthlyPremiumCents).toBe(50000);
 });
 it('requires ZIP for partial counties and applies ZIP-prefix rating',async()=>{
  const c=fixture();c.plans[0].serviceAreas=[{countyFips:'25017',wholeCounty:false,zipCodes:['02451']}];c.premiumRates[0].zipPrefixes=['024'];publish(sql,c);
  const q={state:'MA',countyFips:'25017',year:2026,age:40,tobacco:false} as const;
  expect((await searchCatalog(db,q)).plans).toHaveLength(0);expect((await searchCatalog(db,{...q,zip:'02452'})).plans).toHaveLength(0);
  expect((await searchCatalog(db,{...q,zip:'02451'})).plans[0].monthlyPremiumCents).toBe(50000);
 });
 it('stores statewide geographic provenance outside summaries and reconstructs exact county facts',async()=>{
  const c=fixture(),geography={...source,id:'geo',publisher:'Synthetic public geography publisher with complete versioned source information',url:'https://example.org/public/2026/geographic-service-area-provenance-and-archive',sha256:'a'.repeat(64)};
  c.sources.push(geography);c.plans[0].state='TX';c.plans[0].countyFips=countiesForState('TX').map(county=>county.fips);
  c.plans[0].serviceAreas=c.plans[0].countyFips.map(countyFips=>({countyFips,wholeCounty:true,source:{...geography,location:`Service area TXS001; county ${countyFips}`}}));
  c.premiumRates=[];c.coverage[0].state='TX';expect(Buffer.byteLength(JSON.stringify(c.plans[0].serviceAreas))).toBeGreaterThan(80000);publish(sql,validateCatalog(c));
  const stored=JSON.parse(String(sql.prepare('SELECT data_json FROM catalog_plans').get()?.data_json));expect(stored.serviceAreas).toBeUndefined();
  expect(sql.prepare("SELECT COUNT(*) AS n FROM catalog_plan_counties WHERE source_id='geo'").get()?.n).toBe(254);
  const county=c.plans[0].countyFips.at(-1)!;
  const result=await searchCatalog(db,{state:'TX',countyFips:county,year:2026});expect(result.plans[0].serviceAreas).toEqual([c.plans[0].serviceAreas.at(-1)]);
  const all=(await getPlans(db,[c.plans[0].id],'test-v1'))[0];expect(all.serviceAreas).toEqual([...c.plans[0].serviceAreas].sort((a,b)=>a.countyFips.localeCompare(b.countyFips)));
 });
 it('reads an older published inline-geography release after migration without rewriting its records',async()=>{
  const old=new DatabaseSync(':memory:');for(const name of ['0001_public_catalog.sql','0002_publication_guards.sql'])old.exec(readFileSync(`migrations/${name}`,'utf8'));
  try{
   const c=fixture('legacy');c.plans[0].providers=[];c.plans[0].serviceAreas=[{countyFips:'25017',wholeCounty:false,zipCodes:['02451'],source:{...source,location:'Legacy source page 7'}}];
   c.plans[0].prices=[{id:'legacy-price',category:'lab',providerNpi:'1234567890',providerLocation:'Clinic  A',unitPriceCents:1000,basis:'contracted',source}];
   for(const statement of catalogStatements(c)){
    if(statement.startsWith('INSERT INTO catalog_plans ')){const p=c.plans[0];old.exec(sqlInsert('catalog_plans',[c.release.id,p.id,p.state,p.family,p.year,p.status,p.name,p.effectiveStart,p.effectiveEnd,JSON.stringify({...p,providers:[],drugs:[],prices:[]})]));}
    else if(statement.startsWith('INSERT INTO catalog_plan_counties '))old.exec(sqlInsert('catalog_plan_counties',[c.release.id,c.plans[0].id,'25017',0,'["02451"]']));
    else if(statement.startsWith('INSERT INTO catalog_components '))old.exec(sqlInsert('catalog_components',[c.release.id,c.plans[0].id,'price',0,'lab',null,JSON.stringify(c.plans[0].prices[0])]));
    else old.exec(statement);
   }
   const before=old.prepare('SELECT data_json FROM catalog_plans').get()?.data_json;
   old.exec(readFileSync('migrations/0003_catalog_projection.sql','utf8'));const binding=d1(old);
   const loaded=(await getPlans(binding,[c.plans[0].id],'legacy',{countyFips:'25017',priceContexts:[{category:'lab',providerNpi:'1234567890',providerLocation:'CLINIC A'}]}))[0];
   expect(loaded.serviceAreas).toEqual(c.plans[0].serviceAreas);expect(loaded.prices).toEqual(c.plans[0].prices);
   expect((await applyPremiumRates(binding,[loaded],{countyFips:'25017',zip:'02451',age:40,tobacco:false},'legacy'))[0].monthlyPremiumCents).toBe(50000);
   expect((await searchCatalog(binding,{state:'MA',countyFips:'25017',zip:'02452',year:2026})).plans).toHaveLength(0);
   expect(old.prepare('SELECT data_json FROM catalog_plans').get()?.data_json).toBe(before);
  }finally{old.close();}
 });
 it('retains an exact drug price in a catalog with more than 10000 unrelated prescription prices',async()=>{
  const c=fixture();c.plans[0].drugs=[{ndc:'01234567890',name:'Requested drug',coverage:'covered',source}];
  c.plans[0].prices=Array.from({length:10001},(_,i)=>({id:`drug-price-${i}`,category:'prescription',medicationCode:i===10000?'01234567890':String(10000000000+i),quantityUnit:'fill',unitPriceCents:1234,basis:'contracted',source}));publish(sql,validateCatalog(c));
  const loaded=(await getPlans(db,[c.plans[0].id],'test-v1',{ndcs:['01234-5678-90'],priceContexts:[{category:'prescription',ndc:'01234-5678-90',date:'2026-06-01',daysSupply:30}]}))[0];
  expect(loaded.drugs).toHaveLength(1);expect(loaded.prices.map(price=>price.id)).toEqual(['drug-price-10000']);
 });
 it('filters prices by paired event/provider/drug context including location, source date and fill quantity',async()=>{
  const c=fixture(),base={unitPriceCents:1000,basis:'contracted' as const,source};const future={...source,id:'future',effectiveDate:'2026-10-01'};c.sources.push(future);
  c.plans[0].prices=[
   {...base,id:'generic-lab',category:'lab'},
   {...base,id:'exact-lab',category:'lab',serviceCode:'S1',providerNpi:'1111111111',providerLocation:'Clínica \t A'},
   {...base,id:'crossed-provider',category:'lab',serviceCode:'S1',providerNpi:'2222222222'},
   {...base,id:'wrong-location',category:'lab',serviceCode:'S1',providerNpi:'1111111111',providerLocation:'Clinic B'},
   {...base,id:'future-price',category:'lab',serviceCode:'S1',source:future},
   {...base,id:'exact-drug',category:'prescription',medicationCode:'01234567890',quantityUnit:'fill',daysSupply:30,dispensedQuantity:30},
   {...base,id:'wrong-fill-size',category:'prescription',medicationCode:'01234567890',quantityUnit:'fill',daysSupply:90,dispensedQuantity:90},
   {...base,id:'ambiguous-drug-unit',category:'prescription',medicationCode:'01234567890'},
  ];publish(sql,validateCatalog(c));
  const loaded=(await getPlans(db,[c.plans[0].id],'test-v1',{priceContexts:[{category:'lab',serviceCode:'S1',providerNpi:'1111111111',providerLocation:'CLÍNICA A',date:'2026-06-01'},{category:'imaging',serviceCode:'S2',providerNpi:'2222222222',providerLocation:'Clinic B',date:'2026-06-01'},{category:'prescription',ndc:'01234567890',daysSupply:30,dispensedQuantity:30,date:'2026-06-01'}]}))[0];
  expect(loaded.prices.map(price=>price.id)).toEqual(['generic-lab','exact-lab','exact-drug']);
  expect((await getPlans(db,[c.plans[0].id],'test-v1',{priceContexts:[]}))[0].prices).toHaveLength(0);
 });
 it('enforces one aggregate byte budget before materializing an oversized second plan',async()=>{
  const c=fixture();c.premiumRates=[];
  c.plans[0].providers=Array.from({length:200},(_,i)=>({npi:'1234567890',name:`Provider ${i}`,location:'x'.repeat(11500)+i,network:'in_network',source:{...source,location:'y'.repeat(12000)}}));
  c.plans.push({...c.plans[0],id:'second-plan'});c.coverage[0].planCount=2;publish(sql,validateCatalog(c));
  let materializedComponents=0;const tracked={...db,prepare(query:string){if(query.startsWith('SELECT c.data_json FROM catalog_components'))materializedComponents++;return db.prepare(query);}} as D1Database;
  const budget=catalogReadBudget();await expect(getPlans(tracked,c.plans.map(plan=>plan.id),'test-v1',{providerNpis:['1234567890'],priceContexts:[]},budget)).rejects.toBeInstanceOf(CatalogReadLimitError);
  expect(materializedComponents).toBe(1);expect(budget.bytes).toBeGreaterThan(0);expect(budget.bytes).toBeLessThan(4*1024*1024);
 });
 it('searches names and issuers across pages with literal text and pins the release',async()=>{
  const c=fixture();c.premiumRates=[];c.plans=Array.from({length:40},(_,i)=>({...c.plans[0],id:`plan-${i}`,name:i===39?'Needle plan':'Clinical option '+String(i).padStart(2,'0'),issuer:i===39?'Independent 100% issuer':'Shared issuer',providers:[]}));c.coverage[0].planCount=40;publish(sql,validateCatalog(c));
  const q={state:'MA',countyFips:'25017',year:2026,limit:20} as const;const first=await searchCatalog(db,q);expect(first.total).toBe(40);expect(first.plans).toHaveLength(20);
  expect((await searchCatalog(db,{...q,query:'needle'})).plans.map(plan=>plan.id)).toEqual(['plan-39']);
  expect((await searchCatalog(db,{...q,query:'100%'})).total).toBe(1);expect((await searchCatalog(db,{...q,query:'%'})).total).toBe(1);
  const replacement=structuredClone(c);replacement.release.id='replacement';replacement.plans.forEach(plan=>plan.name='Replacement');publish(sql,validateCatalog(replacement));
  const next=await searchCatalog(db,{...q,releaseId:first.releaseId!,query:'clinical',offset:20});expect(next.total).toBe(39);expect(next.plans).toHaveLength(19);expect(next.releaseId).toBe('test-v1');
  expect((await searchCatalog(db,{...q,query:'clinical'})).total).toBe(0);
  const unavailable=await searchCatalog(db,{...q,releaseId:'missing'});expect(unavailable.releaseId).toBeNull();expect(unavailable.total).toBe(0);expect(unavailable.warnings[0]).toContain('Search again');
 });
 it('does not advertise withdrawn-only coverage as available',async()=>{
  const c=fixture();c.plans[0].status='withdrawn';expect(()=>validateCatalog(c)).toThrow(/non-withdrawn/);c.coverage[0].status='source_gap';publish(sql,validateCatalog(c));
  expect(await catalogStatus(db)).toEqual({available:false,releaseId:'test-v1',planCount:0});
 });
 it('matches hyphenated NDC selectors and canonical components without guessing padding',async()=>{
  const c=fixture();c.plans[0].formularyComplete=true;
  c.plans[0].drugs=[{ndc:'01234-5678-90',name:'Test drug',coverage:'covered',source}];
  c.plans[0].prices=[{id:'drug-price',category:'prescription',medicationCode:'01234-5678-90',quantityUnit:'fill',unitPriceCents:3000,basis:'contracted',source}];
  const canonical=validateCatalog(c);expect(canonical.plans[0].drugs[0].ndc).toBe('01234567890');
  expect(canonical.plans[0].prices[0].medicationCode).toBe('01234567890');publish(sql,canonical);
  const loaded=(await getPlans(db,[c.plans[0].id],'test-v1',{ndcs:['01234-5678-90','01234567890']}))[0];
  expect(loaded.drugs).toHaveLength(1);expect(loaded.prices[0].medicationCode).toBe('01234567890');
  expect(matchMedication({id:'m',name:'Test drug',ndc:'01234-5678-90',ongoing:true},loaded).status).toBe('covered');
  expect(sql.prepare("SELECT lookup_key_2 FROM catalog_components WHERE kind='drug'").get()?.lookup_key_2).toBe('01234567890');
  expect(normalizeNdc('1234-5678-90')).toBe('1234567890');
  expect((await getPlans(db,[c.plans[0].id],'test-v1',{ndcs:['1234-5678-90']}))[0].drugs).toHaveLength(0);
 });
 it('deduplicates repeated service selectors and accepts 2000 distinct 250-character codes through JSON binding',async()=>{
  const c=fixture(),codes=Array.from({length:2000},(_,i)=>i===0?'x'.repeat(250):`service-${i}`);
  c.plans[0].prices=codes.map((serviceCode,i)=>({id:`price-${i}`,category:'other',serviceCode,unitPriceCents:1000,basis:'contracted',source}));
  publish(sql,validateCatalog(c));const queries:string[]=[];
  const tracked={...db,prepare(query:string){queries.push(query);return db.prepare(query);}} as D1Database;
  const result=await getPlans(tracked,[c.plans[0].id],'test-v1',{serviceCodes:[...codes,...codes]});
  expect(result[0].prices).toHaveLength(2000);expect(result[0].prices.some(p=>p.serviceCode===codes[0])).toBe(true);
  const priceQuery=queries.find(query=>query.includes('catalog_components'))!;
  expect(priceQuery).toContain('json_each(?)');expect(priceQuery.match(/\?/g)!.length).toBeLessThan(20);
  await expect(getPlans(db,[c.plans[0].id],'test-v1',{serviceCodes:[...codes,'exceeds-distinct-bound']})).rejects.toThrow();
  await expect(getPlans(db,[c.plans[0].id],'test-v1',{serviceCodes:['x'.repeat(251)]})).rejects.toThrow();
 });
 it('leaves overlapping and partial-date rates unknown',()=>{
  const c=fixture(),p=c.plans[0] as Plan,r=c.premiumRates[0];const profile={countyFips:'25017',age:40,tobacco:false};
  expect(selectPremium(p,[r,{...r,id:'overlap',monthlyPremiumCents:12345}],profile).monthlyPremiumCents).toBeNull();
  expect(selectPremium(p,[{...r,effectiveStart:'2026-07-01'}],profile).monthlyPremiumCents).toBeNull();
  expect(selectPremium(p,[{...r,effectiveStart:'2026-07-01'}],{...profile,coverageStart:'2026-07-01',coverageEnd:'2026-12-31'}).monthlyPremiumCents).toBe(50000);
 });
 it('rates only the intersecting short-term policy and preserves uncertainty across a later birthday',async()=>{
  const c=fixture();c.plans[0]={...c.plans[0],family:'short_term',effectiveStart:'2026-07-01',effectiveEnd:'2026-09-30',underwritingRequired:true};
  c.coverage[0].family='short_term';c.premiumRates=c.premiumRates.map(r=>({...r,effectiveStart:'2026-07-01',effectiveEnd:'2026-09-30'}));publish(sql,validateCatalog(c));
  const profile={countyFips:'25017',age:40,tobacco:false,coverageStart:'2026-01-01',coverageEnd:'2026-12-31'};
  const plans=await getPlans(db,[c.plans[0].id],'test-v1');
  expect((await applyPremiumRates(db,plans,profile,'test-v1'))[0].monthlyPremiumCents).toBeNull();
  const rated=(await applyPremiumRates(db,plans,{...profile,dateOfBirth:'1985-06-01'},'test-v1'))[0];
  expect(rated.monthlyPremiumCents).toBe(52000);expect(rated.rating?.age).toBe(41);expect(rated.premiumEstimated).toBe(true);
  expect(rated.effectiveEnd).toBe('2026-09-30');expect(rated.premiumSource).toEqual(source);
  expect((await searchCatalog(db,{...profile,state:'MA',year:2026,dateOfBirth:'1985-06-01'})).plans[0].monthlyPremiumCents).toBe(52000);
  expect((await applyPremiumRates(db,plans,{...profile,dateOfBirth:'1985-06-01',coverageStart:'2026-10-01'},'test-v1'))[0].monthlyPremiumCents).toBeNull();
  expect((await applyPremiumRates(db,plans,{...profile,coverageStart:'2026-07-01'},'test-v1'))[0].monthlyPremiumCents).toBe(50000);
 });
});
