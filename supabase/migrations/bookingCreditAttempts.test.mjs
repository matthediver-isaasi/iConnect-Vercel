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
    // Install the additive unified contract after proving the unchanged legacy
    // funding path, then exercise it against the same real capacity functions.
    sql(`
      ALTER TABLE booking ADD COLUMN invoice_recovery_status text;
      ALTER TABLE booking ADD COLUMN purchaser_context jsonb;
      ALTER TABLE booking ADD COLUMN stripe_payment_intent_id text;
      ALTER TABLE booking ADD COLUMN attendee_first_name text;
      ALTER TABLE booking ADD COLUMN attendee_last_name text;
      ALTER TABLE complex_event_booking ADD COLUMN invoice_recovery_status text;
      ALTER TABLE complex_event_booking ADD COLUMN purchaser_context jsonb;
      ALTER TABLE complex_event_booking ADD COLUMN stripe_payment_intent_id text;
      ALTER TABLE complex_event_booking ADD COLUMN attendee_first_name text;
      ALTER TABLE complex_event_booking ADD COLUMN attendee_last_name text;
      ALTER TABLE member ADD COLUMN first_name text;
      ALTER TABLE member ADD COLUMN last_name text;
      ALTER TABLE member ADD COLUMN supplied_organization_name text;
      ALTER TABLE member ADD COLUMN organization_group_id uuid;
      ALTER TABLE member ADD COLUMN IF NOT EXISTS role_id uuid;
      ALTER TABLE member ADD COLUMN role_effective_from date;
      ALTER TABLE member ADD COLUMN login_enabled boolean;
      ALTER TABLE member ADD COLUMN show_in_directory boolean;
      ALTER TABLE member ADD COLUMN communications_opted_out_all boolean;
      ALTER TABLE member ADD COLUMN status text;
      ALTER TABLE member ADD COLUMN is_guest boolean;
      ALTER TABLE member ALTER COLUMN id SET DEFAULT gen_random_uuid();
      CREATE FUNCTION normalize_public_ticket_email(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT lower(btrim(value)) $$;
      CREATE UNIQUE INDEX member_public_ticket_email_normalized_unique ON member(tenant_id,normalize_public_ticket_email(email));
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,is_admin boolean DEFAULT false,is_tenant_admin boolean DEFAULT false,
        requires_organization boolean DEFAULT false,requires_effective_from_date boolean DEFAULT false,max_members integer);
      INSERT INTO role(id,tenant_id) VALUES('00000000-0000-4000-8000-000000000031','${t}');
      ALTER TABLE booking ADD COLUMN xero_invoice_id text,ADD COLUMN xero_invoice_number text,ADD COLUMN total_cost numeric,ADD COLUMN currency text;
      ALTER TABLE complex_event_booking ADD COLUMN xero_invoice_id text,ADD COLUMN xero_invoice_number text,ADD COLUMN total_cost numeric,ADD COLUMN currency text;
      CREATE TABLE tenant_accounting_settings(tenant_id uuid,active_provider text);
      CREATE TABLE quickbooks_token(id uuid,app_tenant_id uuid,realm_id text,environment text);
      INSERT INTO tenant_accounting_settings VALUES('${t}','quickbooks');
      INSERT INTO quickbooks_token VALUES('${t}','${t}','original-realm','production');
    `);
    for(const migration of [
      '202607200001_public_invoice_po.sql',
      '202611300001_event_invoice_recovery.sql','202612040001_event_invoice_future_tax_authority.sql',
      '202612050001_accounting_request_queue.sql','202612050002_accounting_request_gc_preparation.sql',
      '202612050005_event_accounting_queue.sql','202612090003_public_invoice_po_billing.sql',
      '202612090004_public_invoice_booker_member.sql','202612090007_public_po_approval_guard.sql',
      '202612090008_public_po_invoice_email.sql','202701050001_public_po_booker_correction.sql',
      '202701220001_unified_booking_contract.sql',
    ]) sql(readFileSync(new URL('./'+migration,import.meta.url),'utf8'));
    assert.equal(sql(`SELECT unified_booking_readiness()->>'enabled';`),'false');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','unified_booking_finalize(uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE');`),'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role','unified_booking_finalize_core(uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE');`),'f');
    assert.equal(sql(`SELECT has_table_privilege('authenticated','unified_booking_contract','SELECT');`),'f');
    const customer={name:'Guest Booker',email:'guest@example.invalid',provenance:{kind:'guest_purchaser'}};
    for (const source of ['booking','complex_event_booking']) {
      const id=source==='booking'?'00000000-0000-4000-8000-000000000021':'00000000-0000-4000-8000-000000000022';
      const snapshot={version:2,request:{booker:{email:'guest@example.invalid'},selection:null},
        booker:{email:'guest@example.invalid',first_name:'Guest',last_name:'Booker'},contact:customer,policies:[]};
      const prepare=`SELECT unified_booking_prepare('${id}','${t}','${source}','${e}',NULL,'${JSON.stringify(snapshot)}');`;
      if(source==='booking'){
        assert.match(sql(`DO $$ BEGIN
          BEGIN PERFORM unified_booking_prepare('${id}','${t}','${source}','${e}',NULL,'${JSON.stringify(snapshot)}');
           RAISE EXCEPTION 'unsafe enabled'; EXCEPTION WHEN OTHERS THEN
           IF SQLERRM NOT LIKE 'Unified booking is not enabled%' THEN RAISE; END IF; END;
        END $$; SELECT 'blocked';`),/blocked/);
        sql('UPDATE unified_booking_rollout SET enabled=true,reader_version=2,worker_version=2;');
      }
      sql(prepare);
      sql(`SELECT unified_booking_begin('${id}','${t}','unified-${source}','${f}','${'c'.repeat(64)}');`);
      const unifiedRows=[{attendee_email:'guest@example.invalid',status:'confirmed',ticket_price:12,payment_method:'invoice',
        purchaser_context:{classification:'public_non_member',booking_contract_version:2,original_payment_method:'public_invoice_po',
          details:snapshot.booker,invoice_customer:{name:customer.name,kind:customer.provenance.kind}}}];
      const unifiedFunding={payableMinor:1200,voucherMinor:0,voucherIds:[],trainingFundMinor:0,expectedOrganizationId:null,
        currency:'GBP',invoiceInput:{amount:12,currency:'GBP',paymentMethod:'public_invoice_po',contact:customer},
        preparedInvoice:{version:2,status:'pending',provider:'xero',snapshot:{provider:{connectionId:'original',xeroTenantId:'company'}}}};
      const call=`SELECT unified_booking_finalize('${t}','unified-${source}','${f}','${e}','${JSON.stringify(unifiedRows)}','${JSON.stringify(unifiedFunding)}')->>'success';`;
      assert.equal(sql(call),'true');
      assert.equal(sql(call),'true','idempotent replay');
      assert.equal(sql(`SELECT count(*) FROM ${source} WHERE booking_group_reference='unified-${source}';`),'1');
      assert.equal(sql(`SELECT state FROM unified_booking_invoice WHERE purchase_key='unified-${source}';`),'pending');
      assert.equal(sql(`SELECT member_id IS NULL AND actor_id IS NULL AND invoice_status='pending' AND email_status='pending'
        FROM public_invoice_po_billing WHERE booking_group_reference='unified-${source}';`),'t');
      assert.equal(sql(`SELECT invoice_recovery_status FROM ${source} WHERE booking_group_reference='unified-${source}';`),'pending');
      assert.equal(sql(`SELECT unified_booking_provision('${t}','unified-${source}')->>'state';`),'not_applicable');
      // A browser role has neither a private read nor an invoice writer.
      assert.equal(sql(`SELECT has_table_privilege('anon','unified_booking_invoice','INSERT');`),'f');
    }
    const claimed=JSON.parse(sql(`SELECT unified_booking_invoice_claim();`));
    assert.equal(claimed.prepared.snapshot.provider.connectionId,'original');
    assert.equal(sql(`SELECT unified_booking_invoice_finish('${t}','${claimed.purchase_key}','${f}',true);`),'f','wrong fence');
    assert.equal(sql(`SELECT unified_booking_invoice_finish('${t}','${claimed.purchase_key}','${claimed.lease_token}',true);`),'t');
    const delayed={version:1,preparation:true,environment:'production',bookingContractVersion:2,payment:null,
      linkage:{source:'booking',group:'unified-booking'},approvalProvider:{connectionId:t,realmId:'original-realm'},
      invoice:{eventId:e,capturedAt:'2020-01-01T00:00:00Z',paymentMethod:'invoice',amount:12,currency:'GBP'}};
    sql(`UPDATE unified_booking_invoice SET prepared=jsonb_build_object('provider','quickbooks','snapshot','${JSON.stringify(delayed)}'::jsonb)
      WHERE purchase_key='unified-booking';
      UPDATE booking SET created_at='2020-01-01' WHERE booking_group_reference='unified-booking';`);
    assert.equal(sql(`SELECT (accounting_event_capture('${t}','booking','unified-booking','${t}','original-realm','${JSON.stringify(delayed)}')).id IS NOT NULL;`),'t',
      'exact committed outbox remains authoritative after both legacy age windows expire');
    assert.equal(sql(`SELECT (accounting_event_capture('${t}','booking','unified-booking','forged-company','different-realm','{}')).company_id;`),'original-realm',
      'existing queue owner wins over changed retry settings');
    for (const [suffix, enableLogin, duplicate] of [['23',false,false],['24',true,false],['25',false,true]]) {
      const request=`00000000-0000-4000-8000-0000000000${suffix}`;
      const email=`buyer${suffix}@example.invalid`;
      const buyer={first_name:'Original',last_name:'Booker',email};
      const snap={version:2,request:{booker:buyer},booker:buyer,contact:{name:'Original Booker',email,provenance:{kind:'guest_purchaser'}},
        policies:[{ticketId:e,createMember:true,enableLogin,roleId:'00000000-0000-4000-8000-000000000031'}]};
      const bookingRows=[{ticket_class_id:e,attendee_email:duplicate?'fixture@example.invalid':`attendee${suffix}@example.invalid`,
        attendee_first_name:'Separate',attendee_last_name:'Attendee',status:'confirmed',ticket_price:0,payment_method:'free',
        purchaser_context:{classification:'public_non_member',booking_contract_version:2,details:buyer,
          invoice_customer:{name:snap.contact.name,kind:snap.contact.provenance.kind}}}];
      const funding={payableMinor:0,voucherMinor:0,voucherIds:[],trainingFundMinor:0,expectedOrganizationId:null,currency:'GBP',
        invoiceInput:{amount:0,contact:snap.contact},preparedInvoice:{version:2,status:'not_applicable',snapshot:null}};
      sql(`SELECT unified_booking_prepare('${request}','${t}','booking','${e}',NULL,'${JSON.stringify(snap)}');
        SELECT unified_booking_begin('${request}','${t}','optional-${suffix}','${f}','${'d'.repeat(64)}');
        SELECT unified_booking_finalize('${t}','optional-${suffix}','${f}','${e}','${JSON.stringify(bookingRows)}','${JSON.stringify(funding)}');`);
      const state=sql(`SELECT unified_booking_provision('${t}','optional-${suffix}')->>'state';`);
      assert.equal(state,duplicate?'needs_review':'completed',
        sql(`SELECT provision_error_code FROM unified_booking_invoice WHERE purchase_key='optional-${suffix}';`));
      assert.equal(sql(`SELECT count(*) FROM booking WHERE booking_group_reference='optional-${suffix}' AND status='confirmed';`),'1');
      assert.equal(sql(`SELECT count(*) FROM public_invoice_po_billing WHERE booking_group_reference='optional-${suffix}';`),'0','free purchases never create invoices');
      if(!duplicate){
        assert.equal(sql(`SELECT bool_and(organization_id IS NULL AND organization_group_id IS NULL AND login_enabled=${enableLogin})
          FROM member WHERE email IN ('${email}','attendee${suffix}@example.invalid');`),'t');
        assert.equal(sql(`SELECT jsonb_array_length(provisioned) FROM unified_booking_invoice WHERE purchase_key='optional-${suffix}';`),'2');
        assert.equal(sql(`SELECT unified_booking_provision('${t}','optional-${suffix}')->>'state';`),'completed','replay never inserts duplicate accounts');
      } else {
        assert.equal(sql(`SELECT count(*) FROM member WHERE email='${email}';`),'0','optional failure rolls back every account, not registration');
      }
    }
    // Explicit manual conversion can associate activity with the original
    // booker even when no member creation was permitted by the ticket.
    const bId=sql(`SELECT id FROM booking WHERE booking_group_reference='unified-booking';`);
    sql(`UPDATE booking SET attendee_email='separate@example.invalid' WHERE id='${bId}';`);
    const converted=JSON.parse(sql(`SELECT create_public_invoice_booker('${t}','${bId}',false,
      'Guest','Booker','guest@example.invalid','',NULL,'00000000-0000-4000-8000-000000000031');`));
    assert.ok(converted.member.id);
    assert.equal(sql(`SELECT member_id::text FROM public_invoice_po_billing WHERE booking_group_reference='unified-booking';`),converted.member.id);
    assert.equal(sql(`SELECT count(*) FROM booking WHERE id='${bId}' AND member_id IS NULL;`),'1','booker conversion is not attendee re-parenting');
    assert.equal(sql(`SELECT prepared#>>'{snapshot,approvalProvider,connectionId}' FROM unified_booking_invoice WHERE purchase_key='unified-booking';`),t);
     // Install the opt-in total contract after the legacy assertions above.
     sql(`ALTER TABLE event ADD COLUMN is_complex boolean DEFAULT false;
       CREATE TABLE public_ticket_member_purchase(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,
         event_kind text,booking_ids uuid[] DEFAULT '{}',snapshot jsonb,state text DEFAULT 'prepared',
         stripe_payment_intent_id text,last_error_code text,updated_at timestamptz);`);
     sql(readFileSync(new URL('./20261005122000_public_ticket_member_booking_batch.sql',import.meta.url),'utf8'));
     sql(readFileSync(new URL('./202701220001_simple_event_total_capacity.sql',import.meta.url),'utf8'));
     const usage=Number(sql(`SELECT simple_event_capacity('${e}')->>'used';`));
     sql(`UPDATE event SET capacity_mode='total',total_capacity=${usage+1},
       pricing_config='{"ticket_classes":[{"id":"${e}","available_count":1000}]}' WHERE id='${e}';`);
     const currentOrg=sql(`SELECT organization_id FROM member WHERE id='${m}';`) || null;
     const totalVoucher=sql(`SELECT voucher_admin_write('${t}',NULL,'issue',
       '${JSON.stringify({organization_id:currentOrg,member_id:currentOrg ? undefined : m,code:'TOTAL-CREDIT',value:10,expires_at:'2099-01-01'})}',
       'admin','total-capacity-credit')->>'id';`);
     const zeroFunding={payableMinor:100,voucherMinor:100,voucherIds:[totalVoucher],trainingFundMinor:0,
       discountIds:[],currency:'GBP',expectedOrganizationId:currentOrg};
     const totalRows=[{...rows[0],ticket_price:1,voucher_amount:1,training_fund_amount:0}];
     const totalFinalize=(key)=>`SELECT booking_credit_finalize('${t}','${key}','${f}','${e}',
       '${JSON.stringify(totalRows)}','${JSON.stringify(zeroFunding)}')->>'success';`;
     sql(begin('total-credit'));
     assert.equal(sql(totalFinalize('total-credit')),'true');
     assert.equal(sql(totalFinalize('total-credit')),'true','total-mode credit retry is idempotent');
     assert.equal(sql(`SELECT simple_event_capacity('${e}')->>'remaining';`),'0');
     sql(begin('total-credit-overflow'));
     sql(totalFinalize('total-credit-overflow'),true);
     assert.equal(sql(`SELECT simple_event_capacity('${e}')->>'used';`),String(usage+1));
     assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${totalVoucher}';`)),9,'overflow rolled back voucher debit');
     sql(`SELECT booking_credit_reverse('${t}','total-credit','${f}','cancelled');`);
     assert.equal(sql(`SELECT simple_event_capacity('${e}')->>'remaining';`),'1');
     assert.equal(sql(`SELECT total_capacity FROM event WHERE id='${e}';`),String(usage+1));
     assert.equal(sql(`SELECT available_seats IS NULL FROM event WHERE id='${e}';`),'t');
     assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${totalVoucher}';`)),10,'credit reversal restored voucher');
  } finally {
    if(started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
