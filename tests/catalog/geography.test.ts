import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {STATES} from '../../src/catalog/schema';
import {countiesForState,getCountyOptions,nameForCountyFips,countyReferenceSource} from '../../src/catalog/geography';

describe('official Census county reference',()=>{
 it('contains current county identities for every launch state and DC',()=>{
  const all=STATES.flatMap(state=>countiesForState(state));expect(all).toHaveLength(3144);expect(new Set(all.map(c=>c.fips)).size).toBe(all.length);
  for(const state of STATES)expect(countiesForState(state).length).toBeGreaterThan(0);
  expect(countiesForState('MA')).toContainEqual({fips:'25017',name:'Middlesex County'});
  expect(countiesForState('DC')).toEqual([{fips:'11001',name:'District of Columbia'}]);
  expect(countyReferenceSource.publisher).toBe('U.S. Census Bureau');expect(countyReferenceSource.sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('distinguishes current Connecticut planning regions from legacy counties',()=>{
  expect(countiesForState('CT')).toHaveLength(9);expect(countiesForState('CT').some(c=>c.fips==='09003')).toBe(false);
  expect(nameForCountyFips('09003')).toBe('Hartford County');expect(nameForCountyFips('09110')).toBe('Capitol Planning Region');expect(nameForCountyFips('00000')).toBeUndefined();
 });
 it('returns county names even before D1 is provisioned',async()=>{
  expect((await getCountyOptions(undefined,'MA')).counties).toHaveLength(14);await expect(getCountyOptions(undefined,'XX')).rejects.toThrow();
 });
 it('adds legacy CT names only when the published catalog requires those exact codes',async()=>{
  const sql=new DatabaseSync(':memory:');for(const file of ['0001_public_catalog.sql','0002_publication_guards.sql','0003_catalog_projection.sql'])sql.exec(readFileSync(`migrations/${file}`,'utf8'));
  // Only the pure query is exercised here; full publication invariants are covered by catalog tests.
  sql.exec('DROP TRIGGER catalog_active_insert');sql.exec("INSERT INTO catalog_releases VALUES ('g',2026,'2026-01-01','{}',0,0,0,0,0,0,'staging')");
  sql.exec("INSERT INTO catalog_plans VALUES('g','p','CT','aca',2026,'available','Public fixture','2026-01-01','2026-12-31','{}')");
  sql.exec("INSERT INTO catalog_plan_counties(release_id,plan_id,county_fips,whole_county,zip_codes) VALUES('g','p','09003',1,'[]')");sql.exec("INSERT INTO catalog_active VALUES(1,'g')");
  const db={prepare(query:string){return {bind(...args:string[]){return {async all(){return {results:sql.prepare(query).all(...args)};}};}};}}as unknown as D1Database;
  try{const result=await getCountyOptions(db,'CT');expect(result.counties).toHaveLength(10);expect(result.counties.find(c=>c.fips==='09003')).toMatchObject({legacy:true,name:expect.stringContaining('Hartford County')});expect(result.legacySource?.version).toBe('2020 Gazetteer');}finally{sql.close();}
 });
});
