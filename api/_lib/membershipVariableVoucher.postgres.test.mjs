import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { CONTRACTS } from '../../scripts/apply-membership-variable-voucher.mjs';

test('variable voucher SQL reserves a period, consumes actual prices and requires evidence', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('variable-voucher-');
  let db, started = false;
  const command = (name,args) => {
    const r = spawnSync(name,args,{ encoding:'utf8' });
    assert.equal(r.status,0,r.stderr);
  };
  const sql = name => readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
  try {
    command('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    command('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
    await db.connect();
    // Reuse the established voucher fixture schema, not any workspace database.
    const existing=readFileSync(new URL('./membershipVoucherSettlement.postgres.test.mjs',import.meta.url),'utf8');
    const fixture=existing.match(/await db\.query\(`([\s\S]*?)`\);/);
    assert.ok(fixture);
    await db.query(fixture[1]);
    for(const name of ['202610200001_individual_voucher_credit.sql','202610200002_membership_voucher_quotes.sql',
      '202610200003_membership_voucher_settlement.sql','202610200010_membership_voucher_monthly.sql',
      '202610200011_membership_checkout_provider_attempts.sql','202610200012_membership_voucher_accounting_binding.sql',
      '202610200013_membership_fee_requote.sql','202610200014_voucher_allocation_refunds.sql']) await db.query(sql(name));
    await db.query(`
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      ALTER TABLE member ADD membership_paused boolean DEFAULT false, ADD status text DEFAULT 'active';
      ALTER TABLE membership_billing_agreements ADD gocardless_mandate_id text;
      ALTER TABLE member_membership_history ADD term_key text;
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE membership_monthly_arrears_period(id uuid,tenant_id uuid,plan_id uuid,settled_at timestamptz);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,billing_agreement_id uuid,
        metadata jsonb,status text,collection_stopped_at timestamptz,gocardless_subscription_id text,gocardless_mandate_id text,
        dynamic_next_collection_date date,dynamic_next_check_at timestamptz,updated_at timestamptz,
        amount_minor integer,next_charge_date date,dynamic_collection_error text,completed_at timestamptz);
      CREATE TABLE gocardless_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,plan_id uuid,
        gocardless_payment_id text UNIQUE,gocardless_mandate_id text,amount_minor integer,currency text,
        charge_date date,status text,updated_at timestamptz);
      CREATE TABLE membership_payment_status_history(tenant_id uuid,entity_type text,entity_id uuid,
        from_status text,to_status text,reason text,source text);
      ALTER TABLE membership_billing_agreements ADD commitment_snapshot jsonb;
    `);
    const dynamic=sql('20261108_explicit_direct_debit_collection_policy.sql');
    await db.query(dynamic.slice(dynamic.indexOf('CREATE TABLE IF NOT EXISTS public.gocardless_collection_reservations')));
    await db.query(sql('20261109_gocardless_dynamic_term_completion.sql'));
    await db.query(`CREATE FUNCTION gocardless_manual_collection_due_date(uuid,uuid,integer) RETURNS date
      LANGUAGE sql AS $$ SELECT ((metadata->>'dynamic_first_date')::date+make_interval(months=>$3-1))::date
       FROM membership_payment_plans WHERE id=$2 AND tenant_id=$1 $$`);
    for (const name of ['complete_gocardless_dynamic_term','voucher_credit_transition','voucher_credit_refund_allocation']) {
      const installed=await db.query('SELECT md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE proname=$1',[name]);
      assert.equal(installed.rows[0].hash,CONTRACTS[name],`${name} fixture must equal the pinned live contract`);
    }
    await db.query(sql('202610230001_membership_variable_voucher.sql'));
    const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const tenant=id(1),member=id(2),voucher=id(3),token=id(4),quote=id(5),agreement=id(6),plan=id(7),config=id(8);
    await db.query(`INSERT INTO tenant VALUES($1);`,[tenant]);
    await db.query(`INSERT INTO member(id,tenant_id) VALUES($1,$2)`,[member,tenant]);
    await db.query(`INSERT INTO system_settings VALUES($1,'individual_vouchers_enabled','true')`,[tenant]);
    await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at)
      VALUES($1,$2,$3,NULL,'variable',30,'active','2099-01-01')`,[voucher,tenant,member]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year)
      VALUES($1,$2,$3,'pending','2099-01-01',NULL,'GBP','{}','2020')`,[token,tenant,member]);
    const snap={payment_mode:'direct_debit',currency:'GBP',membership_year:'2020',instalment_count:3,plan_total:null,
      invoicing_mode:'per_instalment',collection_policy:{version:1,pricing_policy:'dynamic',end_policy:'stop'},
      commitment:{term_key:'variable:2020',term_start_date:'2020-01-01',term_end_date:'2020-03-31'}};
    const q={variableCredit:true,currency:'GBP',grossMinor:null,cashMinor:null,creditMinor:3000,
      monthlySnapshot:snap,allocations:[{voucherId:voucher,amountMinor:3000}],
      creditSchedule:[1,2,3].map(ordinal=>({ordinal,allocatedCreditMinor:1000}))};
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,'basis',$5,'2099-01-01')`,[quote,tenant,token,member,q]);
    const history={tenant_id:tenant,member_id:member,membership_year:'2020',term_key:'variable:2020'};
    const reserve=()=>db.query('SELECT membership_variable_voucher_reserve($1,$2,$3,$4,$5) AS result',[tenant,token,quote,'basis',history]);
    const s=(await reserve()).rows[0].result;
    assert.equal((await reserve()).rows[0].result.id,s.id);
    assert.equal(s.funding.payableMinor,null);
    assert.equal(Number((await db.query('SELECT value FROM voucher')).rows[0].value),0);
    await assert.rejects(db.query('SELECT membership_voucher_complete($1,$2,NULL,NULL,$3)',[tenant,token,'GBP']),
      /Variable membership|Variable voucher|Voucher reservation not found/);
    const metadata={dd:{...snap,voucher_funding:{variable_credit:true,settlement_id:s.id}}};
    await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,metadata,gocardless_mandate_id)
      VALUES($1,$2,$3,'active',$4,'MD1')`,[agreement,tenant,member,metadata]);
    await db.query('SELECT membership_variable_voucher_commit($1,$2,$3)',[tenant,s.id,agreement]);
    await db.query(`INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,status,metadata,gocardless_mandate_id,dynamic_next_collection_date)
      VALUES($1,$2,$3,'active','{"collection_mode":"dynamic","dynamic_first_date":"2020-01-01"}','MD1','2020-01-01')`,[plan,tenant,agreement]);
    await db.query('INSERT INTO membership_tier_config VALUES($1,$2)',[config,tenant]);
    const collection=async (number,gross)=>{
      const date=`2020-0${number}-01`;
      return (await db.query('SELECT to_jsonb(reserve_gocardless_dynamic_collection($1,$2,$3,$4,$5,$6,$7)) AS r',
        [tenant,plan,number,date,{monthly_amount_minor:gross,currency:'GBP',config_id:config,intended_date:date,vat_rate:null},
          {status:'active',next_possible_charge_date:number===1?'2020-04-01':date},`collection-${number}`])).rows[0].r;
    };
    const first=await collection(1,800);
    assert.equal(first.amount_minor,0);
    assert.equal(first.requested_charge_date,'2020-01-01','internal settlement is not blocked by a provider date beyond term end');
    assert.equal(first.provider_evidence.next_possible_charge_date,'2020-04-01','real mandate observation is never forged');
    const settle=r=>db.query('SELECT membership_variable_voucher_settle_collection($1,$2) AS c',[tenant,r.id]);
    const receipt=(await settle(first)).rows[0].c;
    assert.equal((await settle(first)).rows[0].c.id,receipt.id);
    assert.equal(Number((await db.query('SELECT value FROM voucher')).rows[0].value),2);
    assert.equal((await db.query('SELECT count(*) FROM gocardless_payments')).rows[0].count,'0');
    await assert.rejects(db.query("UPDATE gocardless_collection_reservations SET gocardless_payment_id='PMFake' WHERE id=$1",[first.id]),/cannot have a provider/);
    const second=await collection(2,1500);
    assert.equal(second.amount_minor,500);
    await assert.rejects(settle(second),/Confirmed provider evidence/);
    await db.query('SELECT attach_gocardless_dynamic_payment($1,$2,$3)',[tenant,second.id,
      {id:'PM2',amount:500,currency:'GBP',charge_date:'2020-02-01',status:'confirmed',links:{mandate:'MD1'}}]);
    await settle(second);
    const third=await collection(3,1050);
    assert.equal(third.amount_minor,100,'minimum cash releases 50p unused credit');
    await db.query('SELECT attach_gocardless_dynamic_payment($1,$2,$3)',[tenant,third.id,
      {id:'PM3',amount:100,currency:'GBP',charge_date:'2020-03-01',status:'confirmed',links:{mandate:'MD1'}}]);
    await settle(third);
    const complete=await db.query('SELECT complete_gocardless_dynamic_term($1,$2) AS c',[tenant,plan]);
    assert.equal(complete.rows[0].c.completed,true);
    assert.equal(Number((await db.query('SELECT value FROM voucher')).rows[0].value),2.5);
    const allocation=(await db.query("SELECT allocations->0->>'id' AS id FROM membership_variable_voucher_slice WHERE ordinal=1")).rows[0].id;
    await assert.rejects(db.query('SELECT voucher_credit_refund_allocation($1,$2,$3,801,$4)',[tenant,allocation,'refund',{}]),/exceeds/);
    await db.query('SELECT voucher_credit_refund_allocation($1,$2,$3,800,$4)',[tenant,allocation,'refund',{}]);
    for(const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM membership_variable_voucher_slice'),/permission denied/);
      await assert.rejects(db.query('SELECT membership_variable_voucher_settle_collection($1,$2)',[tenant,first.id]),/permission denied/);
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query("UPDATE membership_variable_voucher_slice SET state='settled'"),/permission denied/);
    await assert.rejects(db.query('SELECT membership_variable_voucher_consume($1,$2)',[tenant,first.id]),/permission denied/);
    await db.query('RESET ROLE');
    // A separate renewal never inherits this period's consumed credit.
    const freshVoucher=id(30),freshToken=id(31),freshQuote=id(32),freshAgreement=id(33),freshPlan=id(34);
    await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at)
      VALUES($1,$2,$3,NULL,'next',30,'active','2099-01-01')`,[freshVoucher,tenant,member]);
    const nextSnap={...snap,membership_year:'2021',commitment:{...snap.commitment,term_key:'variable:2021'}};
    const nextQ={...q,monthlySnapshot:nextSnap,allocations:[{voucherId:freshVoucher,amountMinor:3000}]};
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,currency,cost_breakdown,membership_year)
      VALUES($1,$2,$3,'pending','2099-01-01','GBP','{}','2021')`,[freshToken,tenant,member]);
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,'next',$5,'2099-01-01')`,[freshQuote,tenant,freshToken,member,nextQ]);
    const next=(await db.query('SELECT membership_variable_voucher_reserve($1,$2,$3,$4,$5) AS s',
      [tenant,freshToken,freshQuote,'next',{...history,membership_year:'2021',term_key:'variable:2021'}])).rows[0].s;
    assert.notEqual(next.id,s.id);
    await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,metadata,gocardless_mandate_id)
      VALUES($1,$2,$3,'active',$4,'MD1')`,[freshAgreement,tenant,member,
        {dd:{...nextSnap,voucher_funding:{variable_credit:true,settlement_id:next.id}}}]);
    await assert.rejects(db.query('SELECT membership_variable_voucher_commit($1,$2,$3)',[tenant,s.id,freshAgreement]),/does not match/);
    await db.query('SELECT membership_variable_voucher_commit($1,$2,$3)',[tenant,next.id,freshAgreement]);
    await db.query(`INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,status,metadata,gocardless_mandate_id,dynamic_next_collection_date)
      VALUES($1,$2,$3,'active','{"collection_mode":"dynamic","dynamic_first_date":"2020-01-01"}','MD1','2020-01-01')`,[freshPlan,tenant,freshAgreement]);
    const pending=(await db.query('SELECT to_jsonb(reserve_gocardless_dynamic_collection($1,$2,1,$3,$4,$5,$6)) AS r',
      [tenant,freshPlan,'2020-01-01',{monthly_amount_minor:1500,currency:'GBP',config_id:config,intended_date:'2020-01-01'},
        {status:'active',next_possible_charge_date:'2020-01-01'},'next-collection'])).rows[0].r;
    await db.query('SELECT attach_gocardless_dynamic_payment($1,$2,$3)',[tenant,pending.id,
      {id:'PMFailed',amount:500,currency:'GBP',charge_date:'2020-01-01',status:'failed',links:{mandate:'MD1'}}]);
    await assert.rejects(settle(pending),/Confirmed provider/);
    assert.equal((await db.query("SELECT count(*) FROM voucher_transaction WHERE type='booking_usage' AND voucher_id=$1",[freshVoucher])).rows[0].count,'0');
    await db.query("UPDATE membership_payment_plans SET status='payment_plan_cancelled' WHERE id=$1",[freshPlan]);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[freshVoucher])).rows[0].value),30);
    await assert.rejects(settle(pending),/released/);
    await db.query("UPDATE membership_payment_plans SET status='payment_plan_cancelled' WHERE id=$1",[freshPlan]);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[freshVoucher])).rows[0].value),30,'cancellation replay never releases twice');
  } finally {
    if(db) await db.end();
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop'],{encoding:'utf8'});
    await h.cleanup();
  }
});
