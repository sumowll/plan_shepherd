import reference from './data/counties-2025.json';
import legacyReference from './data/connecticut-counties-2020.json';
import {stateSchema} from './schema';

export interface CountyOption { fips:string;name:string;legacy?:boolean;sourceGap?:boolean }
export const countyReferenceSource=Object.freeze(reference.source);
export const legacyConnecticutSource=Object.freeze(legacyReference.source);
export const legacyConnecticutCounties:ReadonlyArray<CountyOption>=Object.freeze(legacyReference.counties.map(c=>Object.freeze({fips:c.fips,name:c.name,legacy:true})));
const currentByFips=new Map(reference.counties.map(c=>[c.fips,c]));
const legacyByFips=new Map(legacyConnecticutCounties.map(c=>[c.fips,c]));

/** Current Census county equivalents; this is a name directory, not a ZIP/county spatial crosswalk. */
export function countiesForState(state:string):CountyOption[]{
 const valid=stateSchema.parse(state);
 return reference.counties.filter(c=>c.state===valid).map(c=>({fips:c.fips,name:c.name}));
}
/** Looks up names only. Legacy Connecticut codes never get silently converted to planning-region codes. */
export function nameForCountyFips(fips:string):string|undefined{return currentByFips.get(fips)?.name??legacyByFips.get(fips)?.name;}

export async function getCountyOptions(db:D1Database|undefined,state:string,year=2026):Promise<{state:string;counties:CountyOption[];source:typeof reference.source;legacySource?:typeof legacyReference.source;warnings:string[]}>{
 const valid=stateSchema.parse(state),counties=countiesForState(valid),warnings:string[]=[];
 let usesLegacy=false;
 if(db){
  try{
   const rows=await db.prepare(`SELECT DISTINCT c.county_fips FROM catalog_active a JOIN catalog_plans p ON p.release_id=a.release_id JOIN catalog_plan_counties c ON c.release_id=p.release_id AND c.plan_id=p.id WHERE a.singleton=1 AND p.state=? AND p.year=? AND p.status<>'withdrawn'`).bind(valid,year).all<{county_fips:string}>();
   const existing=new Set(counties.map(c=>c.fips));
   for(const {county_fips:fips}of rows.results){
    if(existing.has(fips))continue;
    const legacy=valid==='CT'?legacyByFips.get(fips):undefined;
    if(legacy){counties.push({fips,name:`${legacy.name} (legacy county used by plan catalog)`,legacy:true});usesLegacy=true;}
    else counties.push({fips,name:`Plan catalog county ${fips} (name needs verification)`,sourceGap:true});
    existing.add(fips);
   }
  }catch{warnings.push('The public Census county list is available; additional catalog-specific geographic codes could not be checked.');}
 }
 if(usesLegacy)warnings.push('Some plans use legacy Connecticut county codes. They are listed separately from current planning regions; no geographic equivalence is assumed.');
 if(counties.some(c=>c.sourceGap))warnings.push('Some plan catalog county names need source verification.');
 return {state:valid,counties:counties.sort((a,b)=>a.name.localeCompare(b.name)),source:countyReferenceSource,...usesLegacy?{legacySource:legacyConnecticutSource}:{},warnings};
}
