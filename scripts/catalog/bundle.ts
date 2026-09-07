import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {z} from 'zod';
import {catalogSchema,validateCatalog,type CanonicalCatalog} from '../../src/catalog/schema';
import {catalogStatements,sqlInsert,publicationStatements} from './sql';

export const bundleSchema=z.strictObject({schemaVersion:z.literal(1),release:catalogSchema.shape.release,
  parts:z.array(z.strictObject({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(1000)});
export async function readCanonicalFile(path:string,expectedDigest?:string):Promise<CanonicalCatalog>{
 const info=await stat(path);if(!info.isFile()||info.size>512*1024*1024)throw new Error('Each canonical JSON file must be a regular file no larger than 512 MiB');
 const bytes=await readFile(path);if(expectedDigest&&createHash('sha256').update(bytes).digest('hex')!==expectedDigest)throw new Error('Canonical partition checksum mismatch');
 return validateCatalog(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}
export async function inspectBundle(path:string){
 const m=bundleSchema.parse(JSON.parse(await readFile(path,'utf8')));
 const sources=new Map<string,CanonicalCatalog['sources'][number]>(),coverage=new Map<string,CanonicalCatalog['coverage'][number]>(),planIds=new Set<string>();
 const counts={plans:0,rates:0,components:0,counties:0};
 for(const part of m.parts){
  part.path=resolve(dirname(path),part.path);const c=await readCanonicalFile(part.path,part.sha256);
  if(c.release.year!==m.release.year)throw new Error('All partitions must use the bundle plan year');
  for(const source of c.sources){const existing=sources.get(source.id);if(existing&&JSON.stringify(existing)!==JSON.stringify(source))throw new Error(`Source identity conflict across partitions: ${source.id}`);sources.set(source.id,source);}
  for(const p of c.plans){if(planIds.has(p.id))throw new Error(`Duplicate plan across partitions: ${p.id}`);planIds.add(p.id);counts.components+=p.providers.length+p.drugs.length+p.prices.length;counts.counties+=p.countyFips.length;}
  counts.plans+=c.plans.length;counts.rates+=c.premiumRates.length;
  for(const row of c.coverage){
   const key=`${row.state}:${row.family}`,previous=coverage.get(key);
   if(previous){
    if((previous.status==='not_offered'&&row.planCount>0)||(row.status==='not_offered'&&previous.planCount>0))throw new Error(`Contradictory no-offer declaration: ${key}`);
    const lastUpdated=previous.lastUpdated&&row.lastUpdated?(previous.lastUpdated<row.lastUpdated?previous.lastUpdated:row.lastUpdated):null;
    coverage.set(key,{...previous,planCount:previous.planCount+row.planCount,status:previous.status==='source_gap'||row.status==='source_gap'?'source_gap':previous.status,lastUpdated,note:`${previous.note}\n${row.note}`.slice(0,12000)});
   }else coverage.set(key,{...row});
  }
 }
 return {manifest:m,sources:[...sources.values()],coverage:[...coverage.values()],counts};
}
export async function* bundleStatements(bundle:Awaited<ReturnType<typeof inspectBundle>>):AsyncGenerator<string>{
 const {release}=bundle.manifest,{counts}=bundle;
 yield sqlInsert('catalog_releases',[release.id,release.year,release.createdAt,JSON.stringify(release),counts.plans,counts.rates,bundle.sources.length,bundle.coverage.length,counts.components,counts.counties,'staging']);
 for(const s of bundle.sources)yield sqlInsert('catalog_sources',[release.id,s.id,JSON.stringify(s)]);
 for(const part of bundle.manifest.parts){
  // Recheck hashes at write time to prevent files changing between validation and publication.
  const c=await readCanonicalFile(part.path,part.sha256);c.release=release;
  yield*catalogStatements(c,{rowsOnly:true});
 }
 for(const c of bundle.coverage)yield sqlInsert('catalog_coverage',[release.id,c.state,c.family,c.year,JSON.stringify(c)]);
 yield*publicationStatements(release.id);
}
