import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('cancellation stop journal fences ownership, concurrent claims and uncertain outcomes',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('cancellation-journal-'),clients=[];let started=false;
 const command=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  command('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  command('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){
   const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);
  }
  const [admin,a,b]=clients;
  await admin.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
   CREATE TABLE tenant(id uuid PRIMARY KEY);
   CREATE TABLE member(id uuid PRIMARY KEY);
   CREATE TABLE member_membership_history(id uuid PRIMARY KEY);
   CREATE FUNCTION reject_member_change_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'Immutable audit'; END $$;`);
  await admin.query(readFileSync('supabase/migrations/202612310047_member_cancellation_journal.sql','utf8'));
  await admin.query('INSERT INTO tenant VALUES($1);',[id(1)]);
  await admin.query('INSERT INTO member VALUES($1)',[id(2)]);
  await admin.query('INSERT INTO member_membership_history VALUES($1)',[id(3)]);
  await admin.query(`INSERT INTO member_cancellation_request
   (id,tenant_id,member_id,source_record_id,actor_id,request_key,reason,effective_date,timing,source_snapshot,calculation)
   VALUES($1,$2,$3,$4,$5,'cancel-test','Approved cancellation',current_date,'immediate','{}','{}')`,
   [id(4),id(1),id(2),id(3),id(5)]);
  const fingerprint='a'.repeat(64);
  await admin.query(`INSERT INTO member_cancellation_provider_stop(id,tenant_id,member_id,prepared,fingerprint)
   VALUES($1,$2,$3,$4,$5)`,[id(4),id(1),id(2),{
    authority:{provider:'stripe',subscriptionId:'sub',scheduleId:'schedule'},fingerprint},fingerprint]);
  for(const c of [a,b])await c.query('SET ROLE service_role');
  const claim=c=>c.query('SELECT claim_member_cancellation_provider_stop($1,$2,$3,$4) value',[id(1),id(2),id(4),id(5)]);
  await assert.rejects(claim(a),/Applied, owned/);
  await assert.rejects(a.query('UPDATE member_cancellation_request SET access_ended_at=now()'),/permission denied/);
  await admin.query('UPDATE member_cancellation_request SET access_ended_at=now()');
  const results=await Promise.all([claim(a),claim(b)]);
  assert.equal(results.filter(r=>r.rows[0].value.claimed).length,1);
  const operation=results.find(r=>r.rows[0].value.claimed).rows[0].value.operation;
  const record=(evidence,token=operation.claim_token,member=id(2))=>a.query(
   'SELECT record_member_cancellation_provider_stop($1,$2,$3,$4,$5,$6) value',
   [id(1),member,id(4),id(5),token,evidence]);
  await assert.rejects(record({state:'stopped',subscriptionId:'foreign',scheduleId:'schedule'}),/another subscription/);
  await assert.rejects(record({state:'uncertain',subscriptionId:'sub'},id(9)),/Stale/);
  await assert.rejects(record({state:'uncertain',subscriptionId:'sub'},operation.claim_token,id(8)),/not applied/);
  await record({state:'uncertain',subscriptionId:'sub'});
  assert.equal((await claim(b)).rows[0].value.claimed,false);
  await record({state:'active',subscriptionId:'sub'});
  assert.equal((await claim(b)).rows[0].value.operation.state,'uncertain');
  await record({state:'stopped',subscriptionId:'sub',scheduleId:'schedule'});
  assert.equal((await record({state:'uncertain',subscriptionId:'sub'})).rows[0].value.state,'stopped');
  assert.equal((await claim(a)).rows[0].value.claimed,false);
  await assert.rejects(admin.query("UPDATE member_cancellation_event SET kind='rewritten'"),/Immutable audit/);
  for(const role of ['anon','authenticated']){
   const grants=await admin.query(`SELECT has_table_privilege($1,'member_cancellation_request','SELECT') readable,
    has_function_privilege($1,'claim_member_cancellation_provider_stop(uuid,uuid,uuid,uuid)','EXECUTE') callable`,[role]);
   assert.deepEqual(grants.rows[0],{readable:false,callable:false});
  }
  const final=await admin.query('SELECT access_ended_at IS NOT NULL ended FROM member_cancellation_request');
  assert.equal(final.rows[0].ended,true);
 }finally{
  for(const c of clients)await c.end();
  if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
