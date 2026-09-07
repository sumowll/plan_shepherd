import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync,crc32} from 'node:zlib';
import {CsvParser,readCsv} from '../../scripts/catalog/csv';
import {cmsAge,cmsMoney,cmsBenefit,convertCmsAca} from '../../scripts/catalog/cms-aca';
import {countiesForState} from '../../src/catalog/geography';

const directories:string[]=[];
afterEach(async()=>{for(const p of directories.splice(0))await rm(p,{recursive:true,force:true});});
const source={id:'fixture-source',publisher:'Fixture publisher',url:'https://example.org/cms-fixture.csv',retrievedAt:'2026-09-01T00:00:00Z',effectiveDate:'2026-01-01',version:'test-v1'};
async function csvFile(dir:string,name:string,headers:string[],rows:string[][]){
 const csv=[headers,...rows].map(row=>row.map(field=>`"${field.replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n';
 const path=join(dir,name);await writeFile(path,csv);return {path,sha256:createHash('sha256').update(csv).digest('hex'),source:{...source,id:name}};
}
function zip(name:string,content:Buffer):Buffer{
 const compressed=deflateRawSync(content),filename=Buffer.from(name),crc=crc32(content);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(filename.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(filename.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+compressed.length,16);
 return Buffer.concat([local,filename,compressed,central,filename,end]);
}
describe('CMS source parsing',()=>{
 it('handles CSV quote, multiline and CRLF boundaries one character at a time',()=>{
  const parser=new CsvParser();const rows:string[][]=[];for(const char of 'a,b\r\n"one, two","a""b\nc"\r\n')rows.push(...parser.push(char));rows.push(...parser.push('',true));
  expect(rows).toEqual([['a','b'],['one, two','a"b\nc']]);expect(()=>new CsvParser().push('a,"b',true)).toThrow(/Unclosed/);
 });
 it('streams verified ZIP content without extracting paths and rejects tampering',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-test-'));directories.push(dir);const archive=zip('../a.csv',Buffer.from('a,b\n1,2\n'));const path=join(dir,'source.zip');await writeFile(path,archive);
  const input={path,sha256:createHash('sha256').update(archive).digest('hex')};const rows=[];for await(const row of readCsv(input,['a']))rows.push(row);
  expect(rows).toEqual([{a:'1',b:'2'}]);await expect(async()=>{for await(const _ of readCsv({...input,sha256:'0'.repeat(64)}))void _;}).rejects.toThrow(/mismatch/);
  const corrupt=Buffer.from(archive),centralOffset=corrupt.readUInt32LE(corrupt.length-22+16);corrupt.writeUInt32LE(0,centralOffset+16);await writeFile(path,corrupt);
  await expect(async()=>{for await(const _ of readCsv({path,sha256:createHash('sha256').update(corrupt).digest('hex')}))void _;}).rejects.toThrow(/checksum/);
 });
 it('preserves monetary precision and rejects ambiguous values and unsupported age bands',()=>{
  expect(cmsMoney('$1,234.56')).toBe(123456);expect(cmsMoney('Not Applicable')).toBeNull();expect(cmsMoney('$5 per day')).toBeNull();expect(cmsMoney('1.234')).toBeNull();expect(cmsAge('64 and over')).toEqual([64,120]);expect(cmsAge('Family Option')).toBeNull();
 });
 it('keeps per-day and conditional benefits from becoming unconditional visit copays',()=>{
  const b=cmsBenefit({BenefitName:'Inpatient Hospital Services (e.g., Hospital Stay)',IsCovered:'Covered',CopayInnTier1:'$500 Copay per Day after deductible',CoinsInnTier1:'Not Applicable',Explanation:'First five days'},source,1);
  expect(b.copayCents).toBeNull();expect(b.conditions).toHaveLength(1);expect(b.explanation).toContain('First five days');expect(b.appliesDeductible).toBe(true);
 });
 it('parses documented bare percentages and preserves deductible qualification',()=>{
  for(const value of ['20%','20% Coinsurance','20% Coinsurance after deductible']){
   const benefit=cmsBenefit({BenefitName:'Specialist Visit',IsCovered:'Covered',CopayInnTier1:'Not Applicable',CoinsInnTier1:value},source,0);
   expect(benefit.coinsuranceBps).toBe(2000);expect(benefit.appliesDeductible).toBe(value.endsWith('after deductible'));
  }
  expect(cmsBenefit({BenefitName:'Specialist Visit',IsCovered:'Covered',CoinsInnTier1:'12.25%'},source,0).coinsuranceBps).toBe(1225);
  expect(cmsBenefit({BenefitName:'Specialist Visit',IsCovered:'Covered',CoinsInnTier1:'20% per day'},source,0).coinsuranceBps).toBeNull();
 });
 it('converts a statewide Texas plan with all 254 counties and complete geographic provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-tx-test-'));directories.push(dir);
  const planAttributes=await csvFile(dir,'plans.csv',['BusinessYear','StateCode','IssuerId','StandardComponentId','PlanId','PlanMarketingName','ServiceAreaId','DentalOnlyPlan','MarketCoverage','CSRVariationType'],[['2026','TX','12345','12345TX0010001','12345TX0010001-01','Texas statewide fixture','TXS001','No','Individual','Standard On Exchange Plan']]);
  const serviceAreas=await csvFile(dir,'areas.csv',['BusinessYear','StateCode','IssuerId','ServiceAreaId','CoverEntireState','County','PartialCounty'],[['2026','TX','12345','TXS001','Yes','','No']]);
  serviceAreas.source.publisher='Synthetic long publisher provenance representing a complete public plan service-area release';
  serviceAreas.source.url='https://example.org/cms/2026/public-source/service-area-dictionary-and-archive-provenance';
  const {catalog}=await convertCmsAca({schemaVersion:1,release:{id:'texas-source-test',year:2026,createdAt:source.retrievedAt,publisher:'Test only',productionData:true,rightsConfirmed:true,provenanceReviewedBy:'Test suite'},states:['TX'],planAttributes,serviceAreas,stateCountyGeography:countiesForState('TX').map(c=>({state:'TX',countyFips:c.fips,source}))});
  expect(catalog.plans[0].serviceAreas).toHaveLength(254);expect(Buffer.byteLength(JSON.stringify(catalog.plans[0].serviceAreas))).toBeGreaterThan(80000);
  expect(catalog.plans[0].serviceAreas?.every(area=>area.source?.id==='areas.csv')).toBe(true);
 });
 it('joins real CMS column contracts, preserves variants and partial ZIPs, and maps tobacco rates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-cms-test-'));directories.push(dir);
  const base='12345MA0010001';
  const planAttributes=await csvFile(dir,'plans.csv',['BusinessYear','StateCode','IssuerId','StandardComponentId','PlanId','PlanMarketingName','ServiceAreaId','DentalOnlyPlan','MarketCoverage','CSRVariationType'],[
   ['2026','MA','12345',base,`${base}-01`,'Fixture Standard','MAS001','No','Individual','Standard On Exchange Plan'],
   ['2026','MA','12345',base,`${base}-04`,'Fixture CSR','MAS001','No','Individual','73% AV Level Silver Plan'],
   ['2026','MA','12345',base,`${base}-00`,'Fixture Off Exchange','MAS001','No','Individual','Standard Off Exchange Plan']]);
  const serviceAreas=await csvFile(dir,'areas.csv',['BusinessYear','StateCode','IssuerId','ServiceAreaId','CoverEntireState','County','PartialCounty','ZipCodes'],[['2026','MA','12345','MAS001','No','25017','Yes','02451,02452']]);
  const rates=await csvFile(dir,'rates.csv',['BusinessYear','StateCode','PlanId','RatingAreaId','Age','Tobacco','IndividualRate','IndividualTobaccoRate','RateEffectiveDate','RateExpirationDate'],[['2026','MA',base,'Rating Area 1','40','Tobacco User/Non-Tobacco User','500.01','650.02','1/1/2026','12/31/2026']]);
  const benefits=await csvFile(dir,'benefits.csv',['BusinessYear','StateCode','PlanId','BenefitName','IsCovered','CopayInnTier1','CoinsInnTier1'],[['2026','MA',`${base}-01`,'Specialist Visit','Covered','$50 Copay','No Charge']]);
  const {catalog}=await convertCmsAca({schemaVersion:1,release:{id:'cms-test',year:2026,createdAt:source.retrievedAt,publisher:'Fixture publisher',productionData:true,rightsConfirmed:true,provenanceReviewedBy:'Test suite'},states:['MA'],planAttributes,serviceAreas,rates,benefits,ratingGeography:[{state:'MA',countyFips:'25017',ratingAreaId:'Rating Area 1',zipPrefixes:['024'],source}]});
  expect(catalog.plans).toHaveLength(2);expect(catalog.plans[0].serviceAreas?.[0]).toMatchObject({countyFips:'25017',wholeCounty:false,zipCodes:['02451','02452'],source:{id:'areas.csv'}});
  expect(catalog.plans[0].monthlyPremiumCents).toBeNull();expect(catalog.plans[1].conditions?.[0].label).toContain('73%');expect(catalog.plans[0].benefits[0].copayCents).toBe(5000);
  expect(catalog.premiumRates).toHaveLength(4);expect(catalog.premiumRates.find(r=>r.tobacco==='yes')?.monthlyPremiumCents).toBe(65002);expect(catalog.premiumRates[0].zipPrefixes).toEqual(['024']);
  expect(catalog.sources.find(s=>s.id==='plans.csv')?.sha256).toBe(createHash('sha256').update(await readFile(planAttributes.path)).digest('hex'));
  expect(catalog.coverage[0].status).toBe('source_gap');expect(catalog.plans.every(p=>!p.rulesVerified&&!p.networkComplete&&!p.formularyComplete)).toBe(true);
 });
});
