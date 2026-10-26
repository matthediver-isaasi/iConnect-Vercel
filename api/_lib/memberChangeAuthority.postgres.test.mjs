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
 } finally {
  for(const c of clients)await c.end();
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
