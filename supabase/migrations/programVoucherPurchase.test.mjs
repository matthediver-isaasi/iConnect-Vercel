import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { MIGRATIONS } from '../../scripts/verify-voucher-credit-migrations.mjs';

test('isolated programme transaction: legacy org credit, retry, personal toggle and rollback', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('program-voucher-');
  const run = (cmd,args,input,fail=false) => {
    const r = spawnSync(cmd,args,{input,encoding:'utf8'});
    if (fail) assert.notEqual(r.status,0); else assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  const sql = (input,fail=false) => run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'],input,fail);
  let started = false;
  const t='00000000-0000-0000-0000-000000000001', o='00000000-0000-0000-0000-000000000002', m='00000000-0000-0000-0000-000000000003';
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']); started=true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,voucher_allowed_role_ids jsonb,
        training_fund_allowed_role_ids jsonb, training_fund_balance numeric,program_ticket_balances jsonb);
      ALTER TABLE organization ADD COLUMN name text NOT NULL DEFAULT 'Fixture organization';
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,role_id uuid,email text);
      CREATE TABLE system_settings(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE voucher(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid NOT NULL,
        code text NOT NULL,value numeric NOT NULL,description text,expires_at timestamptz NOT NULL,
        issued_at timestamptz NOT NULL DEFAULT now(),valid_from timestamptz,status text DEFAULT 'active',
        used_at timestamptz,used_for_transaction_id uuid,funding_source text,notes text,created_by text);
      CREATE TABLE voucher_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),voucher_id uuid NOT NULL REFERENCES voucher(id),
        organization_id uuid,booking_reference text,event_id text,event_title text,member_id uuid,member_email text,
        amount numeric NOT NULL,balance_before numeric NOT NULL,balance_after numeric NOT NULL,type text NOT NULL DEFAULT 'usage',
        created_at timestamptz DEFAULT now(),tenant_id uuid NOT NULL,notes text);
      CREATE TABLE discount_code(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,expires_at timestamptz,
        max_usage_count numeric,current_usage_count numeric,organization_id uuid,member_id uuid,role_id uuid,member_group_id uuid);
      CREATE TABLE discount_code_usage(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,discount_code_id uuid,
        organization_id uuid NOT NULL,member_id uuid,usage_count numeric);
      CREATE TABLE program_ticket_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid,
        program_name text NOT NULL,transaction_type text NOT NULL,quantity numeric NOT NULL,member_email text,
        purchase_order_number text,booking_reference text,discount_code_id uuid,discount_amount_applied numeric,total_cost_before_discount numeric,notes text,
        cancelled_at timestamptz,cancelled_by_member_email text);
      CREATE TABLE training_fund_transaction(tenant_id uuid,organization_id uuid,type text,amount numeric,balance_before numeric,balance_after numeric,reason text);
      INSERT INTO tenant VALUES('${t}');
      INSERT INTO organization(id,tenant_id,voucher_allowed_role_ids,training_fund_allowed_role_ids,training_fund_balance,program_ticket_balances)
        VALUES('${o}','${t}','[]','[]',20,'{}');
      INSERT INTO member VALUES('${m}','${t}','${o}',NULL,'fixture@example.invalid');
    `);
    sql(`
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        member_id uuid,membership_year text,final_cost numeric,total_with_vat numeric,payment_status text,
        paid_at timestamptz,stripe_payment_intent_id text,payment_method text,status text,
        term_start_date date,scheduled_activation_date date,accounting_sync_status text,accounting_sync_error text,
        billing_agreement_id uuid,billing_period text,vat_amount numeric);
      CREATE TABLE organisation_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        organization_id uuid,final_cost numeric,total_with_vat numeric,vat_amount numeric,payment_status text,billing_agreement_id uuid);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
        status text,metadata jsonb,stripe_checkout_session_id text,gocardless_billing_request_id text,updated_at timestamptz);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,member_id uuid,organization_id uuid,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','po_submitted','paid','expired','cancelled')),
        expires_at timestamptz NOT NULL,final_cost numeric,currency text,cost_breakdown jsonb,membership_year text NOT NULL,
        stripe_payment_intent_id text,stripe_client_secret text,history_record_id uuid,paid_at timestamptz,updated_at timestamptz,
        token text NOT NULL UNIQUE,created_at timestamptz DEFAULT now());
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,booking_reference text,booking_group_reference text,
        voucher_amount numeric,member_id uuid,organization_id uuid,status text,payment_method text,
        event_id uuid,attendee_email text,ticket_price numeric NOT NULL);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      ALTER TABLE complex_event_booking ADD COLUMN voucher_id uuid;
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,program_tag text,status text,event_state text,registration_closes_at timestamptz);
    `);
    sql(readFileSync(new URL('./20260727_add_voucher_monthly_snapshot.sql',import.meta.url),'utf8'));
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,organization_id,month,closing_balance)
      VALUES('${t}','${o}','2026-01-01',123);`);
    for (const file of MIGRATIONS) sql(readFileSync(new URL(`./${file}`,import.meta.url),'utf8'));
    assert.equal(sql(`SELECT has_function_privilege('authenticated','membership_voucher_claim_collection(uuid,uuid,text,text,bigint,date)','EXECUTE');`),'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','membership_payment_start_provider(uuid,text,jsonb)','EXECUTE');`),'f');
    assert.equal(sql(`SELECT relrowsecurity FROM pg_class WHERE oid='membership_voucher_collection'::regclass;`),'t');
    for (const signature of ['membership_voucher_pin_accounting(uuid,uuid,jsonb)',
      'membership_fee_regenerate_quote(uuid,uuid,timestamptz,text,numeric,jsonb)',
      'voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb)']) {
      assert.equal(sql(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE');`),'f');
      assert.equal(sql(`SELECT has_function_privilege('service_role','${signature}','EXECUTE');`),'t');
    }
    assert.equal(Number(sql(`SELECT closing_balance FROM voucher_monthly_snapshot WHERE organization_id='${o}';`)),123);
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,owner_member_id,month,closing_balance)
      VALUES('${t}','${m}','2026-01-01',42);`);
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,owner_member_id,month)
      VALUES('${t}','${m}','2026-01-01');`,true);
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,month) VALUES('${t}','2026-01-01');`,true);
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,organization_id,owner_member_id,month)
      VALUES('${t}','${o}','${m}','2026-02-01');`,true);
    sql(`INSERT INTO voucher_monthly_snapshot(tenant_id,owner_member_id,month)
      VALUES('00000000-0000-0000-0000-000000000099','${m}','2026-01-01');`,true);
    sql(`UPDATE voucher_monthly_snapshot SET owner_member_id=NULL,organization_id='${o}' WHERE owner_member_id='${m}';`,true);
    assert.equal(sql(`SELECT has_function_privilege('authenticated','validate_voucher_snapshot_owner()','EXECUTE');`),'f');
    sql(`SET ROLE authenticated; SELECT * FROM voucher_monthly_snapshot;`,true);
    const issue=(owner,key)=>sql(`SELECT voucher_admin_write('${t}',NULL,'issue','${JSON.stringify({...owner,code:key,value:50,expires_at:'2099-01-01'})}','admin','${key}')->>'id';`);
    const v=issue({organization_id:o},'org');
    const quote={tenantId:t,memberId:m,organizationId:o,programName:'Programme',programTag:'tag',tickets:2,
      totalMinor:10000,grossMinor:10000,discountMinor:0,discountId:null,trainingFundMinor:2000,remainingMinor:3000,
      voucherMinor:5000,voucherIds:[v],manualOrder:false,binding:'fixed-server-quote'};
    const complete=(key,q=quote,po='PO')=>`SELECT complete_program_credit_purchase('${t}','${key}','${JSON.stringify(q)}','account',NULL,'${po}')->>'success';`;
    assert.equal(sql(complete('purchase-a')),'true');
    assert.equal(sql(complete('purchase-a')),'true');
    assert.equal(sql('SELECT count(*) FROM program_ticket_transaction;'),'1');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),0);
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`),'2');
    assert.equal(Number(sql(`SELECT cash_amount FROM program_ticket_transaction;`)),30);
    assert.equal(Number(sql(`SELECT voucher_amount FROM program_ticket_transaction;`)),50);
    assert.equal(Number(sql(`SELECT training_fund_amount FROM program_ticket_transaction;`)),20);
    assert.deepEqual(JSON.parse(sql(`SELECT json_build_object('before',balance_before,'amount',amount,'after',balance_after)
      FROM training_fund_transaction WHERE organization_id='${o}';`)), { before: 20, amount: 20, after: 0 });
    assert.equal(Number(sql(`SELECT training_fund_balance FROM organization WHERE id='${o}';`)),0);
    assert.equal(sql(`SELECT count(*) FROM training_fund_transaction WHERE organization_id='${o}';`),'1',
      'same purchase retry cannot create another training-fund deduction');
    assert.equal(Number(sql(`SELECT (accounting_snapshot->>'remainingMinor')::numeric FROM program_credit_purchase;`)),3000);
    assert.equal(sql(`SELECT has_function_privilege('authenticated','snapshot_program_credit_accounting()','EXECUTE');`),'f');
    const snapshot = JSON.parse(sql(`SELECT accounting_snapshot FROM program_credit_purchase WHERE purchase_key='purchase-a';`));
    assert.equal(snapshot.grossMinor, 10000);
    assert.equal(snapshot.remainingMinor, 3000);
    assert.equal(snapshot.voucherMinor, 5000);
    assert.equal(snapshot.allocations[0].ownerType, 'organization');
    assert.ok(snapshot.allocations[0].displayName);
    const lease='00000000-0000-0000-0000-000000000010';
    assert.equal(sql(`SELECT count(*) FROM claim_program_credit_accounting('${t}','purchase-a','${lease}');`),'1');
    assert.equal(sql(`SELECT count(*) FROM claim_program_credit_accounting('${t}','purchase-a','${lease}');`),'0');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','claim_program_credit_accounting(uuid,text,uuid)','EXECUTE');`),'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','complete_program_credit_purchase(uuid,text,jsonb,text,text,text)','EXECUTE');`),'f');
    sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','individual_vouchers_enabled','true');`);
    const personal=issue({member_id:m},'personal');
    const personalQuote={...quote,trainingFundMinor:0,remainingMinor:5000,voucherIds:[personal],binding:'personal-quote'};
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    sql(complete('personal-disabled',personalQuote),true);
    assert.equal(sql(`SELECT value FROM voucher WHERE id='${personal}';`),'50');
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    sql(complete('missing-po',personalQuote,''),true);
    assert.equal(sql(`SELECT count(*) FROM voucher_credit_purchase WHERE purchase_key='missing-po';`),'0');
    assert.equal(sql(complete('personal-enabled',personalQuote)),'true');
    // Organisation-free personal entitlement uses the same durable invoice
    // continuation and must snapshot its cash liability and owner labels too.
    sql(`UPDATE member SET organization_id=NULL WHERE id='${m}';`);
    const standalone = { ...quote, organizationId: null, trainingFundMinor: 0, voucherMinor: 0,
      remainingMinor: 10000, voucherIds: [], binding: 'standalone' };
    assert.equal(sql(`SELECT complete_program_credit_purchase('${t}','standalone','${JSON.stringify(standalone)}',
      'card','pi_fixture',NULL)->>'success';`),'true');
    const personalSnapshot = JSON.parse(sql(`SELECT accounting_snapshot FROM program_credit_purchase WHERE purchase_key='standalone';`));
    assert.equal(personalSnapshot.organizationName, 'fixture@example.invalid');
    assert.equal(personalSnapshot.remainingMinor, 10000);
    assert.equal(personalSnapshot.paymentIntentId, 'pi_fixture');
    const standaloneVoucher = issue({member_id:m}, 'standalone-voucher');
    const fundedStandalone = { ...standalone, voucherMinor: 5000, remainingMinor: 5000,
      voucherIds: [standaloneVoucher], binding: 'standalone-funded' };
    assert.equal(sql(`SELECT complete_program_credit_purchase('${t}','standalone-funded','${JSON.stringify(fundedStandalone)}',
      'card','pi_fixture_funded',NULL)->>'success';`),'true');
    const fundedSnapshot = JSON.parse(sql(`SELECT accounting_snapshot FROM program_credit_purchase WHERE purchase_key='standalone-funded';`));
    assert.equal(fundedSnapshot.remainingMinor, 5000);
    assert.equal(fundedSnapshot.voucherMinor, 5000);
    assert.equal(fundedSnapshot.allocations[0].ownerType, 'member');
    assert.ok(fundedSnapshot.allocations[0].displayName);
  } finally {
    if(started) run('pg_ctl',['-D',h.data,'-m','immediate','stop']);
    await h.cleanup();
  }
});
