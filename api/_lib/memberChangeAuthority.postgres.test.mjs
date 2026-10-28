import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('change authority is immutable, scoped, stale-checked and serialized', {timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('change-authority-');const clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try {
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
  const [admin,a,b]=clients;
  await admin.query(`
   CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE tenant(id uuid PRIMARY KEY);
   CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
   CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,status text,term_start_date date,membership_renewal_date date);
   CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text,is_active boolean);
   CREATE TABLE membership_change_policy(tenant_id uuid,revision bigint,policy jsonb);
   CREATE TABLE member_membership_amendment(tenant_id uuid,source_record_id uuid);
   CREATE TABLE membership_tier_discount(tenant_id uuid,config_id uuid);
   CREATE TABLE membership_tier_vat_override(tenant_id uuid,config_id uuid);
   CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text);
  `);
  await admin.query(readFileSync('supabase/migrations/202612310023_member_change_authority.sql','utf8'));
  await admin.query('INSERT INTO tenant VALUES($1);',[id(1)]);
  await admin.query('INSERT INTO member VALUES($1,$2)',[id(2),id(1)]);
  await admin.query("INSERT INTO member_membership_history VALUES($1,$2,$3,'active',CURRENT_DATE-10,CURRENT_DATE+300)",[id(3),id(1),id(2)]);
  await admin.query("INSERT INTO membership_tier_config VALUES($1,$2,'member',true)",[id(4),id(1)]);
  const snapshot=async table=>(await admin.query(`SELECT to_jsonb(t) v FROM ${table} t`)).rows[0].v;
  const authority={version:1,tenantId:id(1),memberId:id(2),action:'change',
   sourceSnapshot:await snapshot('member_membership_history'),targetSnapshot:await snapshot('membership_tier_config'),
   policySnapshot:null,calculation:{sourceRecordId:id(3),action:'change',
    effectiveDate:new Date().toISOString().slice(0,10),entitlementApplied:false,settlementStatus:'not_started'},
   fundingEvidence:{sourceRecordId:id(3),complete:true},settlement:{approvalRequired:true}};
  for(const c of [a,b])await c.query('SET ROLE service_role');
  const confirm=(c,key='request-key',value=authority,actor=id(2))=>c.query(
   'SELECT confirm_member_change_authority($1,$2,$3,$4,$5,$6) v',[id(1),id(2),actor,'member',key,value]).then(r=>r.rows[0].v);
  await assert.rejects(confirm(a,'request-key',authority,id(99)),{code:'22023'});
  const stale=structuredClone(authority);stale.targetSnapshot.is_active=false;
  await assert.rejects(confirm(a,'request-key',stale),{code:'40001'});
  const [one,two]=await Promise.all([confirm(a),confirm(b)]);
  assert.equal(one.id,two.id);
  await assert.rejects(admin.query('INSERT INTO member_membership_amendment VALUES($1,$2)',[id(1),id(3)]),{code:'40001'});
  await assert.rejects(confirm(a,'another-key'),{code:'23505'});
  const changed=structuredClone(authority);changed.settlement.approvalRequired=false;
  await assert.rejects(confirm(a,'request-key',changed),{code:'40001'});
  await assert.rejects(a.query('DELETE FROM member_change_authority'),{code:'42501'});
  await assert.rejects(admin.query("UPDATE member_change_authority SET actor_kind='admin'"),/immutable/);
  for(const role of ['anon','authenticated']){
   await b.query(`SET ROLE ${role}`);
   await assert.rejects(b.query('SELECT * FROM member_change_authority'),{code:'42501'});
   await assert.rejects(confirm(b),{code:'42501'});
  }
   await admin.query('CREATE TABLE form(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,require_authentication boolean)');
   for(const migration of ['202612310053_membership_change_forms.sql','202612310055_member_change_requests.sql']){
    await admin.query(readFileSync(`supabase/migrations/${migration}`,'utf8'));
   }
   await b.query('SET ROLE service_role');
   await admin.query('INSERT INTO member VALUES($1,$2)',[id(20),id(1)]);
   await admin.query("INSERT INTO member_membership_history VALUES($1,$2,$3,'active',CURRENT_DATE-10,CURRENT_DATE+300)",[id(21),id(1),id(20)]);
   await admin.query('INSERT INTO form VALUES($1,$2,true,true)',[id(30),id(1)]);
   await a.query('SELECT save_membership_change_form($1,$2,$3,0,true,$4)',[id(1),id(30),id(99),[id(4)]]);
   const memberAuthority={...structuredClone(authority),memberId:id(20),
    request:{configId:id(4)},formBinding:{formId:id(30),revision:1},
    sourceSnapshot:{...authority.sourceSnapshot,id:id(21),member_id:id(20)},
    calculation:{...authority.calculation,sourceRecordId:id(21)},
    fundingEvidence:{...authority.fundingEvidence,sourceRecordId:id(21)}};
   const submit=(c,key='member-request',value=memberAuthority)=>c.query(
    'SELECT submit_member_change_request($1,$2,$3,$4,$5) v',[id(1),id(20),id(30),key,value]);
   const submissions=await Promise.all([submit(a),submit(b)]);
   let requestId=submissions[0].rows[0].v.id;
   assert.equal(requestId,submissions[1].rows[0].v.id);
   assert.equal((await admin.query('SELECT count(*) FROM member_change_authority WHERE member_id=$1',[id(20)])).rows[0].count,'0');
   const review=(c,action,actor=id(99),value=memberAuthority)=>c.query(
    'SELECT review_member_change_request($1,$2,$3,$4,$5,$6,$7) v',[id(1),id(20),actor,requestId,action,'Reviewed',value]);
   await assert.rejects(submit(a,'competing-request'),{code:'23505'});
   await assert.rejects(review(a,'withdraw'),/Audited review/);
   assert.equal((await review(a,'withdraw',id(20))).rows[0].v.state,'withdrawn');
   assert.equal((await submit(a)).rows[0].v.state,'withdrawn');
   requestId=(await submit(a,'replacement-request')).rows[0].v.id;
   assert.equal((await review(a,'reject')).rows[0].v.state,'rejected');
   requestId=(await submit(a,'final-request')).rows[0].v.id;
   await assert.rejects(review(a,'approve',id(99),{...memberAuthority,settlement:{changed:true}}),/evidence changed/);
   const approved=await Promise.all([review(a,'approve'),review(b,'approve')]);
   assert.equal(approved[0].rows[0].v.authority_id,approved[1].rows[0].v.authority_id);
   assert.equal((await admin.query('SELECT count(*) FROM member_change_request_event WHERE request_id=$1',[requestId])).rows[0].count,'2');
   await assert.rejects(submit(a,'another-request'),/confirmed change/);
   await assert.rejects(review(a,'withdraw',id(20)),/already reviewed/);
   await assert.rejects(a.query('DELETE FROM member_change_request'),{code:'42501'});
   for(const role of ['anon','authenticated']){
    await b.query(`SET ROLE ${role}`);
    await assert.rejects(submit(b),{code:'42501'});
    await assert.rejects(b.query('SELECT * FROM member_change_request'),{code:'42501'});
   }
 } finally {
  for(const c of clients)await c.end();
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
