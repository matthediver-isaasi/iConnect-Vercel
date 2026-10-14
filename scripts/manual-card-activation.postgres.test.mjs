import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
test('card approval is tenant-scoped, payment-gated, atomic, idempotent and service-only', async () => {
  const h=await createLocalPostgresHarness('card-approval-');
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  let db, started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`create role anon; create role authenticated; create role service_role;
      create table membership_payment_plans(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,billing_agreement_id uuid,status text,instalments_paid int,last_payment_status text);
      create table membership_billing_agreements(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,status text,provider text,environment text,metadata jsonb);
      create table member_membership_history(id uuid primary key,tenant_id uuid,member_id uuid,billing_agreement_id uuid,status text,payment_status text,term_start_date date,term_end_date date,scheduled_activation_date date);
      create table membership_dd_admin_actions(tenant_id uuid,plan_id uuid,billing_agreement_id uuid,action text,actor_email text,details jsonb);`);
    await db.query(readFileSync('supabase/migrations/20261014_manual_card_membership_activation.sql','utf8'));
    const id='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
    const reset=()=>db.query(`truncate membership_payment_plans,membership_billing_agreements,member_membership_history,membership_dd_admin_actions;
      insert into membership_payment_plans values('${id}','${id}','${id}',null,'${id}','active',1,'paid');
      insert into membership_billing_agreements values('${id}','${id}','${id}',null,'active','stripe','live','{"card":{"kind":"monthly_card","activation_rule":"manual"}}');
      insert into member_membership_history values('${id}','${id}','${id}','${id}','pending_activation','partial',current_date-5,current_date+359,null);`);
    const approve=async(tenant=id,member=id)=>(await db.query('select approve_manual_card_membership_activation($1,$2,$3,$4) result',[tenant,member,id,'fixture@example.invalid'])).rows[0].result;
    const state=async()=> (await db.query('select status from member_membership_history')).rows[0].status;
    await reset();assert.equal((await approve(other)).ok,false);assert.equal((await approve(id,other)).ok,false);
    assert.equal((await approve()).updated,true);assert.equal(await state(),'active');
    assert.equal((await approve()).updated,false);
    assert.equal((await db.query('select count(*) from membership_dd_admin_actions')).rows[0].count,'1');
    for(const sql of [
      "update membership_payment_plans set status='cancelled'",
      "update membership_billing_agreements set status='cancelled'",
      "update membership_billing_agreements set environment='test'",
      "update membership_billing_agreements set metadata='{}'",
      "update membership_payment_plans set instalments_paid=0",
      "update member_membership_history set payment_status='unpaid'",
      "update member_membership_history set term_end_date=current_date-1",
      `update membership_billing_agreements set member_id='${other}'`,
      `update member_membership_history set billing_agreement_id='${other}'`,
    ]) {await reset();await db.query(sql);assert.equal((await approve()).ok,false,sql);assert.equal(await state(),'pending_activation');}
    await reset();await db.query('update member_membership_history set term_start_date=current_date+5');
    assert.equal((await approve()).activated,false);assert.equal(await state(),'scheduled');
    assert.equal((await approve()).updated,false);
    await reset();
    await db.query("alter table membership_dd_admin_actions add constraint reject_fixture check(false) not valid");
    await assert.rejects(approve());assert.equal(await state(),'pending_activation');
    await db.query('alter table membership_dd_admin_actions drop constraint reject_fixture');
    for(const role of ['anon','authenticated','service_role']) {
      const {rows}=await db.query("select has_function_privilege($1,'approve_manual_card_membership_activation(uuid,uuid,uuid,text)','EXECUTE') allowed",[role]);
      assert.equal(rows[0].allowed,role==='service_role');
    }
    // Cancellation wins while the approver waits on the plan lock.
    const cancel=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await cancel.connect();
    try {await cancel.query("begin;update membership_payment_plans set status='cancelled'");
      const waiting=approve();await new Promise(r=>setTimeout(r,100));await cancel.query('commit');
      assert.equal((await waiting).ok,false);assert.equal(await state(),'pending_activation');
    } finally {await cancel.end();}
  } finally {
    await db?.end();if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
