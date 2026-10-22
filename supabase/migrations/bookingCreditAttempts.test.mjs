import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('booking attempt fencing, atomic funding, capacity rollback, recovery and original-owner reversal', { timeout: 60000 }, async () => {
  const h=await createLocalPostgresHarness('booking-credit-');
  const run=(cmd,args,input,fail=false)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    if(fail) assert.notEqual(r.status,0,'must reject'); else assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  const args=['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'];
  const sql=(input,fail=false)=>run('psql',args,input,fail);
  const concurrent=input=>new Promise(resolve=>{
    const p=spawn('psql',args); let stderr=''; p.stderr.on('data',x=>stderr+=x);
    p.on('close',status=>resolve({status,stderr})); p.stdin.end(input);
  });
  const t='00000000-0000-0000-0000-000000000001',o='00000000-0000-0000-0000-000000000002',
    m='00000000-0000-0000-0000-000000000003',e='00000000-0000-0000-0000-000000000004',
    d='00000000-0000-0000-0000-000000000005',f='00000000-0000-0000-0000-000000000006',
    f2='00000000-0000-0000-0000-000000000007';
  let started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']); started=true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,voucher_allowed_role_ids jsonb,
        training_fund_allowed_role_ids jsonb,training_fund_balance numeric);
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
        max_usage_count integer,current_usage_count integer,organization_id uuid,member_id uuid,role_id uuid,member_group_id uuid);
      CREATE TABLE discount_code_usage(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,discount_code_id uuid,
        organization_id uuid,member_id uuid,usage_count integer);
      CREATE TABLE training_fund_transaction(tenant_id uuid,organization_id uuid,type text CHECK(type IN ('add','deduct','booking_usage','purchase','resync')),amount numeric,balance_before numeric,balance_after numeric,reason text);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,available_seats numeric,is_unlimited_registration boolean);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,member_id uuid,organization_id uuid,
        attendee_email text,ticket_class_id text,booking_reference text,booking_group_reference text,
        voucher_amount numeric,training_fund_amount numeric,status text,payment_method text,payment_status text,created_at timestamptz DEFAULT now(),ticket_price numeric NOT NULL);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      ALTER TABLE event ADD COLUMN pricing_config jsonb;
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,available_count integer,is_unlimited_tickets boolean);
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,
        event_reference_kind text,event_id uuid,ticket_type_id text);
      CREATE TABLE sales_commercial_allocation_movement(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,allocation_id uuid,
        movement_kind text,places integer,idempotency_key text,actor_kind text,actor_id uuid,metadata jsonb);
      CREATE TABLE sales_commercial_allocation_booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,allocation_id uuid,
        booking_kind text,booking_id uuid,places integer,designation text,booking_snapshot jsonb);
      CREATE TABLE sales_commercial_allocation_invitation(id uuid PRIMARY KEY,tenant_id uuid,allocation_id uuid,
        token_hash bytea,claimed_at timestamptz,released_at timestamptz,expires_at timestamptz,
        organization_id uuid,delegate_email text,booking_kind text,booking_id uuid);
      INSERT INTO organization VALUES('${o}','${t}','[]','[]',100);
      INSERT INTO member VALUES('${m}','${t}','${o}',NULL,'fixture@example.invalid');
      INSERT INTO event VALUES('${e}','${t}',20,false,'{"ticket_classes":[{"id":"${e}","available_count":20}]}');
      INSERT INTO complex_event VALUES('${e}','${t}',20,false);
      INSERT INTO complex_event_ticket_class VALUES('${e}','${t}','${e}',20,false);
      INSERT INTO discount_code(id,tenant_id,is_active,current_usage_count,max_usage_count) VALUES('${d}','${t}',true,0,10);
    `);
    // Exercise the real deployed dependency definitions, not always-success
    // capacity or invitation stubs. Auth is the only transport fixture.
    const commercial = readFileSync(new URL('./20260910_sales_commercial_allocation.sql',import.meta.url),'utf8');
    const concurrency = readFileSync(new URL('./20260913_sales_concurrency_hardening.sql',import.meta.url),'utf8');
    const installFunction = (text,name) => {
      const start=text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      assert.ok(start>=0);
      const end=text.indexOf('END $$;',start);
      assert.ok(end>start);
      sql(text.slice(start,end+'END $$;'.length));
    };
    sql(commercial.slice(commercial.indexOf('CREATE VIEW public.sales_commercial_allocation_totals AS'),
      commercial.indexOf('CREATE OR REPLACE FUNCTION public.sales_capacity_state(')));
    for(const name of ['sales_capacity_state','check_oneoff_ticket_capacity','check_complex_event_ticket_capacity']) installFunction(commercial,name);
    installFunction(concurrency,'claim_sales_allocation_invitation');
    sql(readFileSync(new URL('./202610200001_individual_voucher_credit.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('./202610200007_booking_credit_attempts.sql',import.meta.url),'utf8'));
    const v=sql(`SELECT voucher_admin_write('${t}',NULL,'issue','{"organization_id":"${o}","code":"ORG","value":100,"expires_at":"2099-01-01"}','admin','issue')->>'id';`);
    const begin=(key,fence=f,source='booking')=>`SELECT booking_credit_begin('${t}','${key}','${fence}','${m}','${source}','${'a'.repeat(64)}');`;
    const rows=[{attendee_email:'fixture@example.invalid',ticket_class_id:e,booking_reference:'REF',voucher_amount:50,training_fund_amount:20,status:'confirmed',ticket_price:70}];
    const funding={payableMinor:5000,voucherMinor:5000,voucherIds:[v],trainingFundMinor:2000,expectedOrganizationId:o,discountIds:[d],currency:'GBP',eventTitle:'Fixture'};
    const finalize=(key,fence=f)=>`SELECT booking_credit_finalize('${t}','${key}','${fence}','${e}','${JSON.stringify(rows)}','${JSON.stringify(funding)}')->>'success';`;
    sql(begin('unsupported-stored-credit'));
    sql(`DO $$ BEGIN
      PERFORM booking_credit_finalize('${t}','unsupported-stored-credit','${f}','${e}','${JSON.stringify(rows)}','${JSON.stringify({...funding,accountMinor:100})}');
      RAISE EXCEPTION 'Unsupported credit was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'Stored account credit is unavailable%' THEN RAISE; END IF;
    END $$;`);
    assert.equal(sql('SELECT count(*) FROM booking;'),'0');
    assert.equal(sql(`SELECT available_seats FROM event WHERE id='${e}';`),'20');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),100);
    sql(begin('one'));
    sql(begin('one',f2),true);
    assert.equal(sql(finalize('one')),'true');
    assert.equal(sql(finalize('one')),'true');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),50);
    assert.equal(Number(sql(`SELECT training_fund_balance FROM organization WHERE id='${o}';`)),80);
    assert.equal(sql('SELECT count(*) FROM booking;'),'1');
    assert.equal(sql(`SELECT current_usage_count FROM discount_code WHERE id='${d}';`),'1');
    assert.equal(sql(`SELECT available_seats FROM event WHERE id='${e}';`),'19');
    assert.match(sql(begin('one',f2)),/"success": true/);
    // A lost HTTP response after commit is returned as success, not compensated.
    assert.equal(sql(`SELECT booking_credit_finish('${t}','one','${f}','{"success":false}',false)->>'success';`),'true');
    sql(begin('crash'));
    sql(`UPDATE booking_credit_attempt SET lease_until=now()-interval '1 second' WHERE purchase_key='crash';`);
    sql(begin('crash',f2));
    sql(finalize('crash'),true);
    sql(`UPDATE event SET pricing_config=jsonb_set(pricing_config,'{ticket_classes,0,available_count}','0');`);
    sql(finalize('crash',f2),true);
    assert.equal(sql('SELECT count(*) FROM booking;'),'1');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),50);
    assert.equal(Number(sql(`SELECT training_fund_balance FROM organization WHERE id='${o}';`)),80);
    assert.equal(sql(`SELECT current_usage_count FROM discount_code WHERE id='${d}';`),'1');
    assert.equal(sql(`SELECT available_seats FROM event WHERE id='${e}';`),'19');
    sql(`UPDATE event SET pricing_config=jsonb_set(pricing_config,'{ticket_classes,0,available_count}','20');`);
    const race=await Promise.all([concurrent(finalize('crash',f2)),concurrent(finalize('crash',f2))]);
    assert.ok(race.every(r=>r.status===0),JSON.stringify(race));
    assert.equal(sql('SELECT count(*) FROM booking;'),'2');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),0);
    // Original organisation survives member affiliation change.
    sql(`UPDATE member SET organization_id=NULL WHERE id='${m}';`);
    const reverse=`SELECT booking_credit_reverse('${t}','one','${f}','cancelled')->>'success';`;
    assert.equal(sql(reverse),'false'); assert.equal(sql(reverse),'false');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)),50);
    assert.equal(Number(sql(`SELECT training_fund_balance FROM organization WHERE id='${o}';`)),80);
    assert.equal(sql(`SELECT current_usage_count FROM discount_code WHERE id='${d}';`),'1');
    assert.equal(sql('SELECT count(*) FROM booking;'),'1');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','booking_credit_finalize(uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE');`),'f');
    sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','individual_vouchers_enabled','true');`);
    const personal=sql(`SELECT voucher_admin_write('${t}',NULL,'issue','{"member_id":"${m}","code":"PERSONAL","value":50,"expires_at":"2099-01-01"}','admin','personal')->>'id';`);
    const personalFunding={...funding,voucherIds:[personal],trainingFundMinor:0,discountIds:[],expectedOrganizationId:null};
    sql(begin('complex-personal',f,'complex_event_booking'));
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    const complexFinalize=`SELECT booking_credit_finalize('${t}','complex-personal','${f}','${e}','${JSON.stringify(rows)}','${JSON.stringify(personalFunding)}')->>'success';`;
    sql(complexFinalize,true);
    assert.equal(sql('SELECT count(*) FROM complex_event_booking;'),'0');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${personal}';`)),50);
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    assert.equal(sql(complexFinalize),'true');
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    assert.match(sql(begin('complex-personal',f2,'complex_event_booking')),/"success": true/);
    assert.equal(sql('SELECT count(*) FROM complex_event_booking;'),'1');
    assert.equal(sql(`SELECT available_seats FROM complex_event WHERE id='${e}';`),'19');
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    const invitedVoucher=sql(`SELECT voucher_admin_write('${t}',NULL,'issue','{"member_id":"${m}","code":"INVITE","value":50,"expires_at":"2099-01-01"}','admin','invite-voucher')->>'id';`);
    sql(`INSERT INTO sales_commercial_allocation VALUES('${f}','${t}','${f}','simple','${e}','${e}');
      INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places) VALUES
        ('${t}','${f}','allocated',1),('${t}','${f}','reserved',1);
      INSERT INTO sales_commercial_allocation_invitation(id,tenant_id,allocation_id,token_hash,expires_at,delegate_email)
        VALUES('${f2}','${t}','${f}',decode('aabb','hex'),'2099-01-01','fixture@example.invalid');`);
    sql(begin('allocation-claim'));
    const inviteFunding={...personalFunding,voucherIds:[invitedVoucher],allocationTokenHash:'aabb',allocationTicketId:e};
    assert.equal(sql(`SELECT booking_credit_finalize('${t}','allocation-claim','${f}','${e}','${JSON.stringify(rows)}','${JSON.stringify(inviteFunding)}')->>'success';`),'true');
    assert.equal(sql(`SELECT count(*) FROM sales_commercial_allocation_booking;`),'1');
    assert.equal(sql(`SELECT claimed_at IS NOT NULL FROM sales_commercial_allocation_invitation;`),'t');
    sql(`UPDATE member SET organization_id='${o}' WHERE id='${m}';
      UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    for (const method of ['account','invoice']) {
      const key=`deferred-${method}`;
      const credit=sql(`SELECT voucher_admin_write('${t}',NULL,'issue','{"organization_id":"${o}","code":"${key}","value":10,"expires_at":"2099-01-01"}','admin','${key}')->>'id';`);
      const invoiceRows=[{...rows[0],ticket_class_id:null,ticket_price:20,voucher_amount:10,training_fund_amount:0,
        payment_method:method,payment_status:'pending'}];
      const invoiceFunding={...funding,payableMinor:2000,voucherMinor:1000,voucherIds:[credit],trainingFundMinor:0,
        accountMinor:0,discountIds:[],invoiceInput:{amount:10,currency:'GBP',paymentMethod:method}};
      sql(begin(key));
      assert.equal(sql(`SELECT booking_credit_finalize('${t}','${key}','${f}','${e}','${JSON.stringify(invoiceRows)}','${JSON.stringify(invoiceFunding)}')->>'success';`),'true');
      assert.equal(sql(`SELECT payment_status FROM booking WHERE booking_group_reference='${key}';`),'pending');
      assert.equal(sql(`SELECT funding->'invoiceInput'->>'amount' FROM booking_credit_attempt WHERE purchase_key='${key}';`),'10');
      assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${credit}';`)),0);
    }
  } finally {
    if(started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
