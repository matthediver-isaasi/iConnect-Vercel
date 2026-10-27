import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('credit backing claim is single-writer, immutable and service-only',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('credit-backing-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
  const [admin,a,b]=clients;
  await admin.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE tenant(id uuid PRIMARY KEY);
   CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
   CREATE TABLE member_membership_amendment(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,quote jsonb);
   CREATE TABLE member_membership_amendment_settlement(amendment_id uuid PRIMARY KEY,tenant_id uuid,
    member_id uuid,choice text,state text,context jsonb,evidence jsonb);
   CREATE FUNCTION reject_member_change_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Immutable'; END $$;`);
  await admin.query(readFileSync('supabase/migrations/202612310027_member_credit_backing_claim.sql','utf8'));
  const binding={provider:'xero',kind:'iconnect_member_credit_liability',providerTenantId:'books',
    currency:'GBP',accountId:'liability'};
  const context={memberCreditLiabilityBinding:binding,xeroTenantId:'books',currency:'GBP',amounts:{grossMinor:1000}};
  await admin.query('INSERT INTO tenant VALUES($1);',[id(1)]);
  await admin.query('INSERT INTO member VALUES($1,$2)',[id(2),id(1)]);
  await admin.query('INSERT INTO member_membership_amendment VALUES($1,$2,$3,$4)',
   [id(3),id(1),id(2),{memberCreditLiabilityBinding:binding,delta:{grossMinor:-1000}}]);
  await admin.query("INSERT INTO member_membership_amendment_settlement VALUES($1,$2,$3,'credit','awaiting_payment',$4,$5)",
   [id(3),id(1),id(2),context,{kind:'awaiting_member_credit_backing',verified:true,documentId:'note'}]);
  await a.query('SET ROLE service_role');await b.query('SET ROLE service_role');
  const claim=(c,tenant=id(1),document='note')=>c.query('SELECT claim_member_credit_backing($1,$2,$3,$4) AS v',
   [tenant,id(3),id(4),document]).then(r=>r.rows[0].v);
  await assert.rejects(claim(a,id(9)),/not found/);
  await assert.rejects(claim(a,id(1),'other-note'),/not verified/);
  const results=await Promise.all([claim(a),claim(b)]);
  assert.deepEqual(results.map(r=>r.claimed).sort(),[false,true]);
  assert.deepEqual(results.find(r=>r.claimed).context,context);
  assert.equal((await claim(a)).claimed,false);
  await assert.rejects(a.query('DELETE FROM member_credit_backing_claim'),{code:'42501'});
  await assert.rejects(admin.query('DELETE FROM member_credit_backing_claim'),/Immutable/);
  for(const role of ['anon','authenticated']){
   await a.query(`RESET ROLE;SET ROLE ${role}`);
   await assert.rejects(claim(a),{code:'42501'});
   await assert.rejects(a.query('SELECT * FROM member_credit_backing_claim'),{code:'42501'});
  }
 }finally{
  await Promise.all(clients.map(c=>c.end()));
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
