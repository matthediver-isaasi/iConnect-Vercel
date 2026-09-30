import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const manifest='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const migrationFile='20261117_bnms_dd_alpha_scheduled_release.sql';
const source=file=>readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8');
const functionSource=(file,name)=>source(file).match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(\\)[\\s\\S]*?END \\$\\$;`))[0];

test('alpha isolated SQL: exact manifest, atomic 249 arming, gate, real service-role reserve/attach/recovery and immutable consent',{timeout:90000},async()=>{
  const h=await createLocalPostgresHarness('alpha-release-sql-');
  const run=(cmd,args,input)=>{
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;
  };
  const conn=['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'];
  const sql=input=>run('psql',conn,input);
  const reject=(input,pattern)=>{
    const r=spawnSync('psql',conn,{input,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,pattern);
  };
  let started=false;
  try{
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    sql(`
      CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      ${functionSource('20261108_bnms_dd_pilot_history.sql','bnms_dd_reject_history_mutation')}
      CREATE TABLE bnms_dd_alpha_adoption(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        plan_id uuid,agreement_id uuid,history_id uuid,mandate_id text,customer_id text,evidence jsonb,manifest_sha256 text,
        UNIQUE(id,tenant_id,member_id));
      CREATE TABLE bnms_dd_alpha_provider_history(provider_payment_id text);
      INSERT INTO bnms_dd_alpha_provider_history VALUES('historical');
      CREATE TRIGGER alpha_immutable BEFORE UPDATE OR DELETE ON bnms_dd_alpha_adoption
        FOR EACH ROW EXECUTE FUNCTION bnms_dd_reject_history_mutation();
      CREATE TRIGGER alpha_immutable BEFORE UPDATE OR DELETE ON bnms_dd_alpha_provider_history
        FOR EACH ROW EXECUTE FUNCTION bnms_dd_reject_history_mutation();
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        provider text,environment text,gocardless_mandate_id text,gocardless_subscription_id text,
        collection_stopped_at timestamptz,status text,metadata jsonb,updated_at timestamptz);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,provider text,environment text,
        gocardless_mandate_id text,gocardless_customer_id text,status text,metadata jsonb,updated_at timestamptz,needs_attention boolean,attention_reason text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid,
        status text,payment_status text,paid_at timestamptz,updated_at timestamptz,notes text,term_start_date date,final_cost numeric);
      CREATE TABLE gocardless_collection_reservations(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,plan_id uuid,billing_agreement_id uuid,
        collection_number integer,due_date date,requested_charge_date date,amount_minor integer,currency text,provider_evidence jsonb,gocardless_payment_id text);
      CREATE TABLE gocardless_payments(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,gocardless_payment_id text,gocardless_mandate_id text,status text,charge_date date);
      ${source('20261113_bnms_dd_alpha_held.sql').slice(source('20261113_bnms_dd_alpha_held.sql').indexOf('CREATE FUNCTION public.bnms_dd_alpha_hold_guard()'),
        source('20261113_bnms_dd_alpha_held.sql').indexOf('CREATE FUNCTION public.bnms_dd_alpha_verify_complete()'))}
    `);
    const fixture=Array.from({length:249},(_,i)=>{
      const n=i+1;
      return `
        INSERT INTO bnms_dd_alpha_adoption VALUES('${uuid(n)}','${tenant}','${uuid(n+1000)}','${uuid(n+2000)}','${uuid(n+3000)}','${uuid(n+4000)}','MD${n}','CU${n}','{"monthlyQuoteMinor":1300}','${manifest}');
        INSERT INTO membership_payment_plans VALUES('${uuid(n+2000)}','${tenant}','${uuid(n+1000)}','${uuid(n+3000)}','gocardless','live','MD${n}',NULL,now(),'first_payment_pending',
          '{"collection_mode":"dynamic","dynamic_first_date":"2026-10-01","bnms_alpha_held":true,"bnms_release_required":true}',now());
        INSERT INTO membership_billing_agreements VALUES('${uuid(n+3000)}','${tenant}','${uuid(n+1000)}','gocardless','live','MD${n}','CU${n}','first_payment_pending',
          '{"dd":{"activation_rule":"first_payment","collection_policy":{"version":1,"pricing_policy":"dynamic"},"invoicing_mode":"per_instalment","instalment_count":12,"currency":"GBP","commitment":{"term_key":"rolling:2026-10-01","term_start_date":"2026-10-01","term_end_date":"2027-09-30"}},"bnms_alpha_approval":{"held":true}}',now(),true,'held');
        INSERT INTO member_membership_history VALUES('${uuid(n+4000)}','${tenant}','${uuid(n+1000)}','${uuid(n+3000)}','pending_payment_setup','unpaid',NULL,now(),'immutable terms','2026-10-01',NULL);
      `;
    }).join('\n');
    sql(`BEGIN;${fixture}COMMIT;`);
    const migration=source(migrationFile);
    sql(`BEGIN;${migration}COMMIT;`);
    // Table authority and trigger/function identity, not merely matching names.
    assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='bnms_dd_alpha_release'::regclass;").trim(),'t');
    for(const role of ['anon','authenticated','service_role']){
      for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
        assert.equal(sql(`SELECT has_table_privilege('${role}','bnms_dd_alpha_release','${privilege}');`).trim(),'f');
      }
    }
    assert.equal(sql("SELECT count(*) FROM pg_policy WHERE polrelid='bnms_dd_alpha_release'::regclass;").trim(),'0');
    assert.equal(sql("SELECT count(*) FROM pg_constraint WHERE conrelid='bnms_dd_alpha_release'::regclass AND contype='f';").trim(),'2');
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname IN ('bnms_dd_alpha_hold_guard','bnms_dd_alpha_canonical_guard','bnms_dd_alpha_protect_payment','bnms_dd_alpha_release_owner_guard') AND NOT prosecdef AND proconfig=ARRAY['search_path=public'] AND proowner='postgres'::regrole;").trim(),'4');
    for(const [table,name,fn,type] of [
      ['membership_payment_plans','bnms_dd_alpha_plan_hold','bnms_dd_alpha_hold_guard',27],
      ['gocardless_collection_reservations','bnms_dd_alpha_reservation_hold','bnms_dd_alpha_hold_guard',23],
      ['membership_billing_agreements','bnms_dd_alpha_agreement_hold','bnms_dd_alpha_canonical_guard',27],
      ['member_membership_history','bnms_dd_alpha_history_hold','bnms_dd_alpha_canonical_guard',27],
      ['gocardless_payments','bnms_dd_alpha_no_historical_replay','bnms_dd_alpha_protect_payment',23],
      ['bnms_dd_alpha_release','alpha_release_owner','bnms_dd_alpha_release_owner_guard',7],
      ['bnms_dd_alpha_release','alpha_release_immutable','bnms_dd_reject_history_mutation',27],
    ]){
      assert.equal(sql(`SELECT count(*) FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND tgname='${name}'
        AND tgfoid='public.${fn}()'::regprocedure AND tgtype=${type} AND tgenabled='O';`).trim(),'1',name);
    }
    const arm=(n,overrides={})=>{
      const evidence={adoptionId:uuid(n),memberId:uuid(n+1000),planId:uuid(n+2000),agreementId:uuid(n+3000),mandateId:`MD${n}`,customerId:`CU${n}`,
        processingNotBefore:'2026-09-30T23:00:00Z',price:{monthly_amount_minor:1300,currency:'GBP'},...overrides};
      return `INSERT INTO bnms_dd_alpha_release(adoption_id,tenant_id,member_id,plan_id,evidence_sha256,evidence)
        VALUES('${uuid(n)}','${tenant}','${uuid(n+1000)}','${uuid(n+2000)}','${'a'.repeat(64)}','${JSON.stringify(evidence)}');
        UPDATE membership_billing_agreements SET needs_attention=false,attention_reason=NULL WHERE id='${uuid(n+3000)}';
        UPDATE membership_payment_plans SET collection_stopped_at=NULL,metadata=jsonb_set(metadata,'{bnms_release_required}','false') WHERE id='${uuid(n+2000)}';`;
    };
    reject(`UPDATE membership_payment_plans SET collection_stopped_at=NULL WHERE id='${uuid(2001)}';`,/reviewed release/);
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(4001)}';`,/reviewed release/);
    reject(arm(1,{price:{monthly_amount_minor:1301,currency:'GBP'}}),/owner\/evidence/);
    reject(arm(1,{agreementId:uuid(999)}),/owner\/evidence/);
    reject(`SET ROLE service_role;${arm(1)}`,/permission denied/);
    const all=Array.from({length:249},(_,n)=>arm(n+1)).join('\n');
    reject(`BEGIN;${all}SELECT 1/0;COMMIT;`,/division by zero/);
    assert.equal(sql('SELECT count(*) FROM bnms_dd_alpha_release;').trim(),'0');
    assert.equal(sql('SELECT count(*) FROM membership_payment_plans WHERE collection_stopped_at IS NOT NULL;').trim(),'249');
    sql(`BEGIN;${all}COMMIT;`);
    assert.equal(sql('SELECT count(*) FROM bnms_dd_alpha_release;').trim(),'249');
    reject(arm(1),/duplicate key/);
    for(const table of ['bnms_dd_alpha_release','bnms_dd_alpha_adoption','bnms_dd_alpha_provider_history']){
      reject(`DELETE FROM ${table};`,/immutable/);
    }
    reject("UPDATE bnms_dd_alpha_release SET evidence='{}';",/immutable/);
    reject(`UPDATE membership_billing_agreements SET metadata='{}' WHERE id='${uuid(3001)}';`,/immutable consent/);
    reject(`UPDATE member_membership_history SET final_cost=156 WHERE id='${uuid(4001)}';`,/financial\/dated/);
    reject(`UPDATE member_membership_history SET payment_status='paid' WHERE id='${uuid(4001)}';`,/confirmed first/);
    for(const [table,id] of [['membership_payment_plans',2001],['membership_billing_agreements',3001],['member_membership_history',4001]]){
      reject(`DELETE FROM ${table} WHERE id='${uuid(id)}';`,/cannot be deleted/);
    }
    // Only the database clock is substituted, exclusively in the disposable DB.
    sql(`CREATE FUNCTION public.test_alpha_clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT current_setting('test.clock')::timestamptz $$;
      ${functionSource(migrationFile,'bnms_dd_alpha_hold_guard').replaceAll('clock_timestamp()','public.test_alpha_clock()')}
      ${functionSource(migrationFile,'bnms_dd_alpha_protect_payment').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replaceAll('clock_timestamp()','public.test_alpha_clock()')}
      CREATE TABLE tenant(id uuid PRIMARY KEY);INSERT INTO tenant VALUES('${tenant}');
      CREATE TABLE member(id uuid,tenant_id uuid,membership_paused boolean,status text);
      CREATE TABLE organization(LIKE member);
      INSERT INTO member SELECT member_id,tenant_id,false,'active' FROM bnms_dd_alpha_adoption;
      CREATE TABLE membership_tier_config(id uuid,tenant_id uuid);INSERT INTO membership_tier_config VALUES('${uuid(9001)}','${tenant}');
      CREATE TABLE membership_monthly_arrears_period(plan_id uuid,tenant_id uuid,settled_at timestamptz);
      CREATE TABLE organisation_membership_history(id uuid,tenant_id uuid,billing_agreement_id uuid,organization_id uuid,term_key text,payment_status text,paid_at timestamptz,final_cost numeric);
      CREATE TABLE membership_payment_status_history(tenant_id uuid,entity_type text,entity_id uuid,from_status text,to_status text,reason text,source text);
      ALTER TABLE member_membership_history ADD COLUMN term_key text DEFAULT 'rolling:2026-10-01';
      ALTER TABLE membership_billing_agreements ADD COLUMN organization_id uuid;
      ALTER TABLE membership_payment_plans ADD COLUMN organization_id uuid,
        ADD COLUMN amount_minor integer DEFAULT 1300,ADD COLUMN next_charge_date date,
        ADD COLUMN dynamic_next_collection_date date DEFAULT '2026-10-01',
        ADD COLUMN dynamic_next_check_at timestamptz,ADD COLUMN dynamic_collection_error text,ADD COLUMN completed_at timestamptz;
      ALTER TABLE gocardless_collection_reservations ADD PRIMARY KEY(id),ADD COLUMN status text DEFAULT 'reserved',
        ADD COLUMN term_key text,ADD COLUMN price_snapshot jsonb,ADD COLUMN idempotency_key text UNIQUE,
        ADD COLUMN provider_charge_date date,ADD COLUMN updated_at timestamptz,ADD COLUMN blocked_reason text,
        ADD UNIQUE(plan_id,collection_number);
      ALTER TABLE gocardless_payments ADD COLUMN plan_id uuid,ADD COLUMN amount_minor integer,
        ADD COLUMN currency text,ADD COLUMN updated_at timestamptz,ADD UNIQUE(gocardless_payment_id);
      GRANT SELECT ON bnms_dd_alpha_adoption,bnms_dd_alpha_provider_history,gocardless_collection_reservations,gocardless_payments TO service_role;
      GRANT UPDATE ON gocardless_payments TO service_role;
    `);
    const policy=source('20261108_explicit_direct_debit_collection_policy.sql');
    sql(policy.slice(policy.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(')));
    sql(policy.slice(policy.indexOf('CREATE OR REPLACE FUNCTION public.guard_gocardless_dynamic_reservation()'),policy.indexOf('CREATE OR REPLACE FUNCTION public.guard_dd_collection_policy_snapshot()')));
    sql(source('20261109_gocardless_dynamic_term_completion.sql'));
    sql(source('20261109_manage_monthly_collection_days.sql'));
    const reserve=(date='2026-10-07',checked='2026-09-30T23:00:00Z',amount=1300,status='active')=>`
      SELECT id FROM reserve_gocardless_dynamic_collection('${tenant}','${uuid(2001)}',1,'2026-10-01',
        '{"config_id":"${uuid(9001)}","monthly_amount_minor":${amount},"currency":"GBP","intended_date":"2026-10-01"}',
        '{"status":"${status}","next_possible_charge_date":"${date}","checked_at":"${checked}"}','stable-alpha');`;
    const attach=status=>`SELECT id FROM attach_gocardless_dynamic_payment('${tenant}',
      (SELECT id FROM gocardless_collection_reservations WHERE plan_id='${uuid(2001)}'),
      '{"id":"PMalpha","amount":1300,"currency":"GBP","charge_date":"2026-10-07","status":"${status}","links":{"mandate":"MD1"}}');`;
    reject(`SET test.clock='2026-09-30T22:59:59.999Z';SET ROLE service_role;${reserve()}`,/processing-not-before/);
    reject(`SET test.clock='2026-09-30T23:00:00Z';SET ROLE service_role;${reserve('2026-10-09')}`,/reviewed price/);
    reject(`SET test.clock='2026-09-30T23:00:00Z';SET ROLE service_role;${reserve('2026-10-07','2026-09-30T22:59:59Z')}`,/post-gate/);
    reject(`SET test.clock='2026-09-30T23:00:00Z';SET ROLE service_role;${reserve('2026-10-07','2026-09-30T23:00:00Z',1301)}`,/reviewed price/);
    reject(`SET test.clock='2026-10-08T12:00:00Z';SET ROLE service_role;${reserve()}`,/in the past/);
    reject(`SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;${reserve('2026-10-07','2026-09-30T23:00:00Z',1300,'pending_submission')}`,/mandate|reviewed price/i);
    const reserved=sql(`SET test.clock='2026-09-30T23:00:00Z';SET ROLE service_role;${reserve()}`).trim().split('\n').at(-1);
    sql(`CREATE FUNCTION fixture_alpha_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF current_setting('test.fail_attachment',true)='true' THEN RAISE EXCEPTION 'injected attachment failure';END IF;RETURN NEW;END$$;
      CREATE TRIGGER fixture_alpha_failure BEFORE INSERT ON gocardless_payments FOR EACH ROW EXECUTE FUNCTION fixture_alpha_failure();`);
    reject(`SET test.clock='2026-10-01T00:00:00Z';SET test.fail_attachment='true';SET ROLE service_role;${attach('pending_submission')}`,/injected attachment/);
    assert.equal(sql(`SELECT status||':'||coalesce(gocardless_payment_id,'none') FROM gocardless_collection_reservations WHERE id='${reserved}';`).trim(),'reserved:none');
    assert.equal(sql(`SET test.clock='2026-10-01T00:00:00Z';SET ROLE service_role;${reserve()}`).trim().split('\n').at(-1),reserved);
    for(const status of ['pending_submission','submitted','confirmed','paid_out']){
      sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;${attach(status)}`);
      assert.equal(sql("SELECT provider_evidence->>'status' FROM gocardless_collection_reservations WHERE gocardless_payment_id='PMalpha';").trim(),status);
    }
    sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;${attach('pending_submission')}`);
    assert.equal(sql("SELECT provider_evidence->>'status' FROM gocardless_collection_reservations WHERE gocardless_payment_id='PMalpha';").trim(),'paid_out');
    assert.equal(sql("SELECT count(*) FROM gocardless_payments WHERE gocardless_payment_id='PMalpha';").trim(),'1');
    reject(`SET test.clock='2026-10-07T12:00:00Z';UPDATE gocardless_collection_reservations SET provider_evidence=jsonb_set(provider_evidence,'{checked_at}','"2026-10-02T00:00:00Z"') WHERE plan_id='${uuid(2001)}';`,/post-gate/);
    reject(`UPDATE member_membership_history SET status='active' WHERE id='${uuid(4001)}';`,/confirmed first/);
    reject(`SET test.clock='2026-10-07T12:00:00Z';INSERT INTO gocardless_payments(tenant_id,gocardless_payment_id,gocardless_mandate_id,status,charge_date)
      VALUES('${tenant}','historical','MD1','confirmed','2026-09-08');`,/historical/i);
    sql(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;UPDATE gocardless_payments SET status='paid_out' WHERE gocardless_payment_id='PMalpha';RESET ROLE;
      UPDATE member_membership_history SET status='active',payment_status='partial' WHERE id='${uuid(4001)}';`);
    assert.equal(sql(`SELECT status||':'||payment_status FROM member_membership_history WHERE id='${uuid(4001)}';`).trim(),'active:partial');
    reject(`SET test.clock='2026-10-07T12:00:00Z';SET ROLE service_role;UPDATE gocardless_payments SET gocardless_mandate_id='other' WHERE gocardless_payment_id='PMalpha';`,/identity drift/);
    reject(`BEGIN;${migration}COMMIT;`,/reservations exist/);
    // Unrelated pilot/beta/exception rows are not selected by alpha's registry.
    sql(`SET test.clock='2026-09-01T00:00:00Z';INSERT INTO gocardless_collection_reservations(tenant_id,plan_id) VALUES('${tenant}','${uuid(9999)}');`);
  }finally{
    if(started)run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);await h.cleanup();
  }
});