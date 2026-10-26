import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('monthly operation SQL serializes claims, holds collectors and protects evidence', {timeout:120000}, async()=>{
  const h=await createLocalPostgresHarness('member-provider-operations-');
  const clients=[];let started=false;
  const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  try {
    cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
    const [admin,a,b]=clients;
    await admin.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,status text);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        organization_id uuid,auto_retry_claim_token text,collection_stopped_at timestamptz,status text);
      CREATE TABLE gocardless_collection_reservations(plan_id uuid,status text);
      CREATE TABLE gocardless_payments(plan_id uuid,status text);
      CREATE TABLE gocardless_payment_retry_attempts(plan_id uuid);
      GRANT SELECT,INSERT,UPDATE,DELETE ON membership_payment_plans,gocardless_collection_reservations,
        gocardless_payments,gocardless_payment_retry_attempts TO service_role;
    `);
    await admin.query(readFileSync('supabase/migrations/202612310022_member_amendment_provider_operations.sql','utf8'));
    await admin.query('INSERT INTO tenant VALUES($1)',[id(1)]);
    await admin.query('INSERT INTO member VALUES($1,$2)',[id(2),id(1)]);
    await admin.query('INSERT INTO membership_billing_agreements VALUES($1,$2,$3,NULL)',[id(4),id(1),id(2)]);
    await admin.query("INSERT INTO member_membership_history VALUES($1,$2,$3,$4,'active')",[id(3),id(1),id(2),id(4)]);
    await admin.query("INSERT INTO membership_payment_plans VALUES($1,$2,$3,$4,NULL,NULL,NULL,'active')",[id(5),id(1),id(2),id(4)]);
    const json=async table=>(await admin.query(`SELECT to_jsonb(t) AS value FROM ${table} t`)).rows[0].value;
    const input={tenantId:id(1),memberId:id(2),amendmentId:'monthly-test-key',
      purchase:await json('member_membership_history'),plan:await json('membership_payment_plans'),
      agreement:await json('membership_billing_agreements')};
    const prepared={version:1,input,mutation:{kind:'gc_amount'},fingerprint:'a'.repeat(64)};
    for(const c of [a,b])await c.query('SET ROLE service_role');
    const reserve=(c,p=prepared,key='monthly-test-key')=>c.query(
      'SELECT reserve_member_amendment_provider_operation($1,$2,$3,$4,$5) AS value',[id(1),id(2),id(6),key,p]
    ).then(r=>r.rows[0].value);
    const pending=structuredClone(prepared);
    await admin.query("INSERT INTO gocardless_collection_reservations VALUES($1,'reserved')",[id(5)]);
    await assert.rejects(reserve(a,pending),{code:'40001'});
    await admin.query('DELETE FROM gocardless_collection_reservations');
    const original=await reserve(a);
    assert.equal((await reserve(b)).replayed,true);
    const op=original.operation;
    const changed=structuredClone(prepared);changed.input.amendmentId='monthly-other-key';
    await assert.rejects(reserve(b,changed,'monthly-other-key'),{code:'23505'});
    const claim=c=>c.query('SELECT claim_member_amendment_provider_operation($1,$2,$3) AS value',
      [id(1),op.id,id(6)]).then(r=>r.rows[0].value);
    await admin.query("UPDATE member_membership_history SET status='expired' WHERE id=$1",[id(3)]);
    await assert.rejects(claim(a),{code:'40001'});
    await admin.query("UPDATE member_membership_history SET status='active' WHERE id=$1",[id(3)]);
    const claims=await Promise.all([claim(a),claim(b)]);
    assert.equal(claims.filter(c=>c.claimed).length,1);
    const token=claims.find(c=>c.claimed).operation.claim_token;
    for(const sql of [
      "UPDATE membership_payment_plans SET status='cancelled' WHERE id=$1",
      "DELETE FROM membership_payment_plans WHERE id=$1",
      "INSERT INTO gocardless_collection_reservations VALUES($1,'reserved')",
      "INSERT INTO gocardless_payments VALUES($1,'pending_submission')",
      "INSERT INTO gocardless_payment_retry_attempts VALUES($1)",
    ])await assert.rejects(a.query(sql,[id(5)]),{code:'40001'});
    const record=(tokenValue,status)=>a.query('SELECT record_member_amendment_provider_result($1,$2,$3,$4,$5) AS value',
      [id(1),op.id,id(6),tokenValue,{status}]).then(r=>r.rows[0].value);
    await assert.rejects(record(id(7),'provider_applied'),{code:'40001'});
    assert.equal((await record(token,'not_applied')).state,'uncertain');
    await assert.rejects(a.query('SELECT abandon_member_amendment_provider_operation($1,$2,$3,$4)',
      [id(1),op.id,id(6),'Cannot abandon an unknown provider result']),{code:'40001'});
    assert.equal((await claim(a)).claimed,false);
    assert.equal((await record(token,'provider_applied')).state,'provider_applied');
    await assert.rejects(a.query("UPDATE membership_payment_plans SET status='active' WHERE id=$1",[id(5)]),{code:'40001'});
    await assert.rejects(a.query("UPDATE member_amendment_provider_operation SET state='aborted'"),{code:'42501'});
    await assert.rejects(a.query('DELETE FROM member_amendment_provider_event'),{code:'42501'});
    await assert.rejects(a.query('SELECT claim_member_amendment_provider_operation($1,$2,$3)',[id(99),op.id,id(6)]),{code:'40001'});
    for(const role of ['anon','authenticated']){
      await b.query(`SET ROLE ${role}`);
      await assert.rejects(b.query('SELECT * FROM member_amendment_provider_operation'),{code:'42501'});
      await assert.rejects(b.query('SELECT claim_member_amendment_provider_operation($1,$2,$3)',[id(1),op.id,id(6)]),{code:'42501'});
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM member_amendment_provider_event')).rows[0].n,4);
    // An unclaimed reservation has no external side effects and can release its
    // hold with an audit record. This is never allowed for a claimed operation.
    await admin.query("INSERT INTO member_membership_history VALUES($1,$2,$3,$4,'active')",[id(9),id(1),id(2),id(4)]);
    await admin.query("INSERT INTO membership_payment_plans VALUES($1,$2,$3,$4,NULL,NULL,NULL,'active')",[id(8),id(1),id(2),id(4)]);
    const second=structuredClone(prepared);
    second.input.amendmentId='unclaimed-operation';
    second.input.purchase.id=id(9);second.input.plan.id=id(8);
    const reserved=await reserve(a,second,'unclaimed-operation');
    const abandoned=await a.query('SELECT abandon_member_amendment_provider_operation($1,$2,$3,$4) AS value',
      [id(1),reserved.operation.id,id(6),'Selection withdrawn before provider work']);
    assert.equal(abandoned.rows[0].value.state,'aborted');
    await a.query("UPDATE membership_payment_plans SET status='active' WHERE id=$1",[id(8)]);
  } finally {
    for(const c of clients)await c.end();
    if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
