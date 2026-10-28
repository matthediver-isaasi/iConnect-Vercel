// Production-targeted connection, but all verification DDL/data is isolated and
// rolled back. No real campaign, recipient or provider is changed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connectDestination } from './annual-meeting-destination.mjs';
const schema=`journal_test_${randomUUID().replaceAll('-','')}`;
const migration=await fs.readFile('supabase/migrations/20261028_campaign_batch_claim_journal.sql','utf8');
const db=await connectDestination();
try {
 await db.query('BEGIN');
 await db.query(`CREATE SCHEMA ${schema};
 CREATE TABLE ${schema}.email_campaign(id uuid PRIMARY KEY,status text,tenant_id uuid,total_recipients integer,sent_count integer,completed_at timestamptz,updated_at timestamptz,sent_at timestamptz);
 CREATE TABLE ${schema}.email_campaign_recipient(id uuid PRIMARY KEY,campaign_id uuid,status text,sent_at timestamptz,mailgun_message_id text);`);
 await db.query(migration.replaceAll('public.',`${schema}.`).replaceAll('search_path=public,pg_temp',`search_path=${schema},pg_temp`));
 const campaign=randomUUID(), recipient=randomUUID(), legacy=randomUUID();
 const tenant=randomUUID();
 await db.query(`INSERT INTO ${schema}.email_campaign(id,status,tenant_id,total_recipients) VALUES($1,'sending',$2,2)`,[campaign,tenant]);
 await db.query(`INSERT INTO ${schema}.email_campaign_recipient(id,campaign_id,status) VALUES($1,$2,'pending'),($3,$2,'processing')`,[recipient,campaign,legacy]);
 const claim=async()=> (await db.query(`SELECT ${schema}.campaign_claim_batch_recipient($1,$2) r`,[campaign,recipient])).rows[0].r;
 const recover=async()=> (await db.query(`SELECT ${schema}.campaign_recover_unsubmitted_claims($1) n`,[campaign])).rows[0].n;
 const transition=async(token,action)=>(await db.query(`SELECT ${schema}.campaign_transition_batch_claims($1,$2) n`,[[token],action])).rows[0].n;
 const first=await claim();assert.ok(first._claim_token);assert.equal(await claim(),null);
 await db.query(`UPDATE ${schema}.campaign_batch_claim SET claimed_at=now()-interval '16 minutes'`);
 assert.equal(await recover(),1);
 await db.query('SAVEPOINT stale');
 await assert.rejects(()=>transition(first._claim_token,'submit'),/no longer owned/);
 await db.query('ROLLBACK TO stale');
 const second=await claim();assert.notEqual(second._claim_token,first._claim_token);
 assert.equal(await transition(second._claim_token,'submit'),1);
 await db.query(`UPDATE ${schema}.campaign_batch_claim SET claimed_at=now()-interval '16 minutes'`);
 assert.equal(await recover(),0);
 assert.equal((await db.query(`SELECT status FROM ${schema}.email_campaign_recipient WHERE id=$1`,[legacy])).rows[0].status,'processing');
 assert.equal((await db.query(`SELECT status FROM ${schema}.email_campaign_recipient WHERE id=$1`,[recipient])).rows[0].status,'processing');
 const finalize=async()=>(await db.query(`SELECT ${schema}.campaign_finalize_delivery($1,$2) r`,[campaign,tenant])).rows[0].r;
 assert.equal((await finalize()).complete,false);
 await db.query(`UPDATE ${schema}.email_campaign_recipient SET status='sent' WHERE id=$1`,[recipient]);
 await db.query(`UPDATE ${schema}.email_campaign_recipient SET status='failed' WHERE id=$1`,[legacy]);
 assert.deepEqual(await finalize(),{complete:true,status:'sent',sent:1,failed:1});
 for(const role of ['anon','authenticated']){
  const fn=`${schema}.campaign_claim_batch_recipient(uuid,uuid)`;
  assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,fn])).rows[0].allowed,false);
  assert.equal((await db.query('SELECT has_table_privilege($1,$2,\'INSERT\') allowed',[role,`${schema}.campaign_batch_claim`])).rows[0].allowed,false);
 }
 console.log('PASS: claim CAS, safe pre-submission recovery, stale-token fence, uncertain and legacy preservation, private grants');
} finally {await db.query('ROLLBACK');await db.end();}
