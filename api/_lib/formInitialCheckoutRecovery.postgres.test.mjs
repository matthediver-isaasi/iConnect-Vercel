import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('initial checkout cancellation fences writes and requires exact provider evidence', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('initial-recovery-');
  const run = (cmd,args) => { const r=spawnSync(cmd,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  let db, started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid primary key);
      CREATE TABLE member(id uuid primary key,tenant_id uuid,membership_paused boolean);
      CREATE TABLE form_joining_voucher_checkout(tenant_id uuid,member_id uuid,released_at timestamptz,breakdown jsonb);
      CREATE TABLE membership_payment_quote(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,
       quote jsonb,stripe_payment_intent_id text,cancelled_for_switch_at timestamptz);
      CREATE TABLE membership_billing_agreements(id uuid primary key,tenant_id uuid,member_id uuid,organization_id uuid,status text,
       membership_successor_election_id uuid,previous_term_id uuid,provider text,environment text,
       gocardless_mandate_id text,gocardless_subscription_id text,stripe_subscription_id text,
       stripe_checkout_session_id text,gocardless_billing_request_id text,idempotency_key text,membership_year text,
       metadata jsonb,cancelled_for_switch_at timestamptz);
      CREATE TABLE member_membership_history(id uuid primary key,tenant_id uuid,member_id uuid,status text,payment_status text,
       paid_at timestamptz,previous_term_id uuid,membership_successor_election_id uuid,billing_agreement_id uuid,
       membership_payment_quote_id uuid,stripe_payment_intent_id text,xero_invoice_id text,accounting_invoice_id text,cancelled_for_switch_at timestamptz);
      CREATE TABLE membership_payment_plans(billing_agreement_id uuid);
      CREATE TABLE membership_payment_term_claim(tenant_id uuid,owner_type text,owner_id uuid,source_key text,membership_year text);
      CREATE TABLE membership_voucher_settlement(id uuid,tenant_id uuid,fee_token_id uuid);
      CREATE TABLE membership_fee_token(id uuid,member_id uuid,cost_breakdown jsonb);`);
    await db.query(readFileSync(new URL('../../supabase/migrations/202701210001_initial_checkout_recovery.sql',import.meta.url),'utf8'));
    const t='10000000-0000-0000-0000-000000000001',m='20000000-0000-0000-0000-000000000001',a='30000000-0000-0000-0000-000000000001';
    await db.query('insert into tenant values($1)',[t]);await db.query('insert into member values($1,$2,false)',[m,t]);
    await db.query(`insert into membership_billing_agreements(id,tenant_id,member_id,status,provider,environment,gocardless_billing_request_id,metadata)
      values($1,$2,$3,'payment_setup_required','gocardless','sandbox','BR-test','{}')`,[a,t,m]);
    const begin=()=>db.query('select begin_form_initial_checkout_recovery($1,$2) as s',[t,m]);
    const snapshot=(await begin()).rows[0].s;
    assert.equal((await begin()).rows[0].s.recoveryId,snapshot.recoveryId);
    await assert.rejects(db.query("update membership_billing_agreements set gocardless_mandate_id='late' where id=$1",[a]),/reconciled/);
    const finish=receipts=>db.query('select finish_form_initial_checkout_recovery($1,$2,$3,$4,false)',[t,m,snapshot.recoveryId,JSON.stringify(receipts)]);
    await assert.rejects(finish([]),/Incomplete/);
    await assert.rejects(finish([{id:'BR-test',status:'canceled',environment:'live'}]),/environment/);
    await finish([{id:'BR-test',status:'canceled',environment:'sandbox'}]);
    await finish([{id:'BR-test',status:'canceled',environment:'sandbox'}]);
    assert.equal((await db.query('select status from membership_billing_agreements where id=$1',[a])).rows[0].status,'cancelled');
    await assert.rejects(db.query("update membership_billing_agreements set status='active' where id=$1",[a]),/released/);
    await assert.rejects(db.query("insert into member_membership_history(id,tenant_id,member_id,billing_agreement_id) values(gen_random_uuid(),$1,$2,$3)",[t,m,a]),/released/);
    const insert=metadata=>db.query(`insert into membership_billing_agreements(id,tenant_id,member_id,status,provider,environment,gocardless_billing_request_id,metadata)
      values(gen_random_uuid(),$1,$2,'payment_setup_required','gocardless','sandbox','BR-next',$3)`,[t,m,metadata]);
    await assert.rejects(insert({}),/Refresh/);
    await insert({initialRecoveryGeneration:snapshot.recoveryId});
    await assert.rejects(db.query('select finish_form_initial_checkout_recovery($1,$2,$3,$4,false)',
      [t,'20000000-0000-0000-0000-000000000002',snapshot.recoveryId,'[]']), /owner mismatch/);
    await assert.rejects(db.query("insert into form_joining_voucher_checkout(tenant_id,member_id,breakdown) values($1,$2,'{}')",[t,m]),/Refresh/);
    await db.query("insert into member_membership_history(id,tenant_id,member_id,status,payment_status) values(gen_random_uuid(),$1,$2,'active','paid')",[t,m]);
    await assert.rejects(begin(),/authorized or unresolved/);
    await db.query('set role authenticated');
    await assert.rejects(begin(),/permission denied/);
    await db.query('reset role');
    const perms=(await db.query(`select has_table_privilege('anon','form_initial_checkout_recovery','SELECT') as anon,
      has_function_privilege('authenticated','begin_form_initial_checkout_recovery(uuid,uuid)','EXECUTE') as auth,
      has_function_privilege('service_role','begin_form_initial_checkout_recovery(uuid,uuid)','EXECUTE') as service`)).rows[0];
    assert.deepEqual(perms,{anon:false,auth:false,service:true});
  } finally {if(db)await db.end();if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop']);}
});
