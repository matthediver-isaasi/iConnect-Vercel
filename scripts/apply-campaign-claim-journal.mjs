import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectDestination } from './annual-meeting-destination.mjs';
const sql=await fs.readFile('supabase/migrations/20261028_campaign_batch_claim_journal.sql','utf8');
const version='20261028';
const db=await connectDestination();
try{
 await db.query('BEGIN');
 await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
 const existing=(await db.query('SELECT statements FROM supabase_migrations.schema_migrations WHERE version=$1',[version])).rows;
 if(existing.length){assert.equal(existing.length,1);assert.equal(existing[0].statements.join(''),sql);}
 else{
  assert.equal((await db.query("SELECT to_regclass('public.campaign_batch_claim') r")).rows[0].r,null);
  await db.query(sql);
  await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',
   [version,'campaign_batch_claim_journal',[sql]]);
 }
 for(const fn of ['campaign_claim_batch_recipient(uuid,uuid)','campaign_transition_batch_claims(uuid[],text)',
  'campaign_recover_unsubmitted_claims(uuid)','campaign_finalize_delivery(uuid,uuid)','campaign_acceptance_candidates(uuid,uuid)']){
  for(const role of ['anon','authenticated'])assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,`public.${fn}`])).rows[0].allowed,false);
  assert.equal((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') allowed",[`public.${fn}`])).rows[0].allowed,true);
 }
 for(const table of ['campaign_batch_claim','campaign_acceptance_check']){
  const r=(await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[`public.${table}`])).rows[0];
  assert.equal(r.relrowsecurity,true);
  for(const role of ['anon','authenticated'])assert.equal((await db.query("SELECT has_table_privilege($1,$2,'INSERT') allowed",[role,`public.${table}`])).rows[0].allowed,false);
 }
 await db.query('COMMIT');
 console.log(JSON.stringify({applied:!existing.length,verified:true,campaignsChanged:0,emailsSent:0}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
