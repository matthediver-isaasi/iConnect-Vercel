import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import pg from 'pg';
import { inspectContract, financialSnapshot } from '../../scripts/apply-gocardless-manual-collection.mjs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const migration = source('20261123_gocardless_manual_collection.sql');
for (const cadence of ['original', 'amended']) {
test(`isolated PostgreSQL (${cadence} cadence): full-guard service-role authorize/reserve/attach and recovery`, { timeout: 60000 }, async () => {
  const harness = await createLocalPostgresHarness('manual-collection-');
  // No workspace credentials or destination URLs enter child processes.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' };
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  const conn = ['-h', harness.socket, '-p', String(harness.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  // A disposable-cluster clock seam only, never used by application code/SQL.
  const clock = "SET test.clock='2026-09-30T12:00:00Z';";
  const sql = input => run('psql', conn, clock + input);
  const financialSql = input => sql(`SET ROLE service_role;${input}`);
  const fails = (input, pattern) => {
    const r = spawnSync('psql', conn, { input: clock + input, encoding: 'utf8', env });
    assert.notEqual(r.status, 0, r.stdout);
    if (pattern) assert.match(r.stderr, pattern);
  };
  const localClock = text => text.replaceAll('clock_timestamp()', 'public.test_clock()');
  let started = false;
  const t = '00000000-0000-4000-8000-000000000001', p = '00000000-0000-4000-8000-000000000002';
  const key = 'a'.repeat(64);
  const auth = `authorize_gocardless_manual_collection('${t}','${p}','2026-10-01',1,1300,'GBP','2026-10-05','${key}','finance@example.test','Reviewed early October collection',
    '{"agreement":"${p}","member":"${p}","organization":null,"mandate":"MD1","environment":"live"}')`;
  const evidence = `jsonb_build_object('status','active','checked_at','2026-09-30T12:00:00Z','next_possible_charge_date','2026-10-05','manual_authorization_id',(SELECT id::text FROM gocardless_manual_collection_authorizations WHERE plan_id='${p}'))`;
  const reserve = (proof = evidence) => `SET ROLE service_role;SELECT id FROM reserve_gocardless_dynamic_collection('${t}','${p}',1,'2026-10-01',
    '{"monthly_amount_minor":1300,"currency":"GBP","intended_date":"2026-10-01","config_id":"${p}"}',${proof},'${key}');`;
  try {
    run('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', harness.data, '-l', path.join(harness.root, 'postgres.log'), '-o', `-F -k ${harness.socket} -c listen_addresses= -p ${harness.port}`, '-w', 'start']);
    started = true;
    // Reuse the existing canonical collection-day test's SQL-only schema fixture.
    const seed = source('20261109_manage_monthly_collection_days.test.mjs').match(/sql\(`([\s\S]*?)`\);/)[1];
    sql(seed + `
      ALTER ROLE service_role BYPASSRLS;
      ALTER TABLE membership_payment_plans ADD COLUMN provider text DEFAULT 'gocardless', ADD COLUMN environment text DEFAULT 'live';
      ALTER TABLE membership_billing_agreements ADD COLUMN environment text DEFAULT 'live',
        ADD COLUMN gocardless_customer_id text, ADD COLUMN commitment_snapshot jsonb;
      CREATE FUNCTION public.test_clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT current_setting('test.clock')::timestamptz $$;
      CREATE TABLE bnms_dd_beta_adoption(id uuid,tenant_id uuid,member_id uuid,plan_id uuid,agreement_id uuid,mandate_id text);
      CREATE TABLE bnms_dd_alpha_adoption(LIKE bnms_dd_beta_adoption);
      CREATE TABLE bnms_dd_pilot_adoption(LIKE bnms_dd_beta_adoption);
      CREATE TABLE bnms_dd_manual_adoption(LIKE bnms_dd_beta_adoption);
      ALTER TABLE bnms_dd_manual_adoption ADD COLUMN evidence jsonb;
      CREATE TABLE bnms_dd_beta_release(adoption_id uuid,tenant_id uuid,member_id uuid,processing_not_before timestamptz,evidence jsonb);
      CREATE TABLE bnms_dd_alpha_release(LIKE bnms_dd_beta_release);
      CREATE TABLE bnms_dd_pilot_release(LIKE bnms_dd_beta_release);
      CREATE TABLE bnms_dd_manual_release(LIKE bnms_dd_beta_release);
      CREATE TABLE bnms_dd_alpha_provider_history(provider_payment_id text);
      CREATE TABLE bnms_dd_beta_provider_history(provider_payment_id text);
      CREATE TABLE bnms_dd_historical_payment(provider_payment_id text,xero_invoice_id text);
      ALTER TABLE member_membership_history ADD COLUMN xero_invoice_id text,ADD COLUMN accounting_invoice_id text,
        ADD COLUMN status text,ADD COLUMN term_start_date date,ADD COLUMN term_end_date date,
        ADD COLUMN commitment_snapshot jsonb;
      ALTER TABLE bnms_dd_beta_adoption ADD COLUMN customer_id text,ADD COLUMN history_id uuid;
      ALTER TABLE bnms_dd_alpha_adoption ADD COLUMN customer_id text,ADD COLUMN history_id uuid;
      ALTER TABLE bnms_dd_manual_adoption ADD COLUMN customer_id text,ADD COLUMN history_id uuid;
    `);
    const original = source('20261108_explicit_direct_debit_collection_policy.sql');
    sql(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(')));
    sql(source('20261109_gocardless_dynamic_term_completion.sql'));
    if (cadence === 'amended') sql(source('20261109_manage_monthly_collection_days.sql'));
    const functions = [
      ['20261115_bnms_dd_beta_scheduled_release.sql', 'bnms_dd_beta_hold_guard'],
      ['20261117_bnms_dd_alpha_scheduled_release.sql', 'bnms_dd_alpha_hold_guard'],
      ['20261116_bnms_dd_pilot_reservation_lifecycle.sql', 'bnms_dd_guard_initial_reservation'],
      ['20261121_bnms_dd_manual_95.sql', 'bnms_manual_reservation_gate'],
      ['20261117_bnms_dd_alpha_scheduled_release.sql', 'bnms_dd_alpha_protect_payment'],
      ['20261121_bnms_dd_manual_95.sql', 'bnms_manual_payment_guard'],
    ];
    for (const [file, fn] of functions) {
      const definition = source(file).match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?END \\$\\$;`))[0];
      sql(localClock(definition));
      sql(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON ${fn.includes('payment') ? 'gocardless_payments' : 'gocardless_collection_reservations'}
        FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
    }
    // Install the complete CURRENT runtime guard chain on all affected financial
    // tables, verbatim from migration source (not simplified trigger stand-ins).
    // Adoption/import cardinality setup is NOT a claim of full tenant-schema proof.
    const guardFiles = [
      '20261108_explicit_direct_debit_collection_policy.sql',
      '20261108_bnms_dd_pilot_history.sql',
      '20261112_bnms_dd_beta_held.sql',
      '20261113_bnms_dd_alpha_held.sql',
      '20261114_bnms_dd_pilot_processing_start.sql',
      '20261115_bnms_dd_beta_scheduled_release.sql',
      '20261116_bnms_dd_pilot_reservation_lifecycle.sql',
      '20261117_bnms_dd_alpha_scheduled_release.sql',
      '20261121_bnms_dd_manual_95.sql',
    ];
    const definitions = new Map(), bindings = new Map();
    const financialTables = new Set(['membership_payment_plans', 'membership_billing_agreements',
      'member_membership_history', 'gocardless_collection_reservations', 'gocardless_payments']);
    for (const file of guardFiles) {
      const text = source(file);
      for (const match of text.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\)[\s\S]*?END \$\$;/gm)) definitions.set(match[1], match[0]);
      for (const match of text.matchAll(/^CREATE TRIGGER (\w+)[\s\S]*?\bON public\.(\w+)[\s\S]*?EXECUTE FUNCTION public\.(\w+)\(\);/gm)) {
        if (financialTables.has(match[2])) bindings.set(match[1], { sql: match[0], table: match[2], fn: match[3] });
      }
    }
    for (const fn of new Set([...bindings.values()].map(binding => binding.fn))) {
      assert.ok(definitions.has(fn), `Missing full source for ${fn}`);
      sql(localClock(definitions.get(fn).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')));
    }
    // Remove the initial six direct test bindings; use the production names and
    // event/table bindings instead, including plan/agreement and history guards.
    for (const [, fn] of functions) sql(`DROP TRIGGER ${fn} ON ${fn.includes('payment') ? 'gocardless_payments' : 'gocardless_collection_reservations'}`);
    for (const [name, binding] of bindings) sql(`DROP TRIGGER IF EXISTS ${name} ON public.${binding.table};${binding.sql}`);
    assert.ok([...bindings.values()].some(binding => binding.fn === 'bnms_dd_beta_hold_guard' && binding.table === 'membership_payment_plans'));
    assert.ok([...bindings.values()].some(binding => binding.fn === 'bnms_manual_canonical_guard' && binding.table === 'membership_payment_plans'));
    for (const fn of ['bnms_dd_protect_canonical_payment', 'bnms_dd_beta_protect_payment', 'bnms_dd_alpha_protect_payment', 'bnms_manual_payment_guard']) {
      assert.ok([...bindings.values()].some(binding => binding.fn === fn && binding.table === 'gocardless_payments'), fn);
    }
    // Supabase service_role is BYPASSRLS; RPCs remain SECURITY DEFINER with their
    // real migration grants. Public/authenticated get no fixture table access.
    sql(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.tablename);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',r.tablename);
        EXECUTE format('GRANT SELECT ON public.%I TO service_role',r.tablename);
      END LOOP;
    END $$;`);
    const verifier = new pg.Client({ host: harness.socket, port: harness.port, user: 'postgres', database: 'postgres' });
    await verifier.connect();
    try {
      const before = await inspectContract(verifier, migration, { transformSource: localClock });
      const financialBefore = await financialSnapshot(verifier);
      assert.equal(before.cadence, cadence);
      assert.equal(before.manualInstalled, false);
      await verifier.query('BEGIN');
      await verifier.query(`CREATE OR REPLACE FUNCTION public.bnms_dd_beta_hold_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await assert.rejects(inspectContract(verifier, migration, { transformSource: localClock }), /source drift/);
      await verifier.query('ROLLBACK');
      sql(localClock(migration));
      sql(localClock(migration)); // idempotent and does not weaken rewritten guards
      const after = await inspectContract(verifier, migration, { requireManual: true, transformSource: localClock });
      assert.equal(after.cadence, cadence);
      assert.equal(after.manualInstalled, true);
      assert.deepEqual(await financialSnapshot(verifier), financialBefore);
      await verifier.query('BEGIN');
      await verifier.query('GRANT EXECUTE ON FUNCTION public.gocardless_manual_collection_due_date(uuid,uuid,integer) TO authenticated');
      await assert.rejects(inspectContract(verifier, migration, { requireManual: true, transformSource: localClock }), /privilege mismatch/);
      await verifier.query('ROLLBACK');
    } finally { await verifier.end(); }
    assert.match(financialSql('SELECT current_user,rolbypassrls FROM pg_roles WHERE rolname=current_user'), /service_role\|t/);
    sql(`
      INSERT INTO tenant VALUES('${t}');
      INSERT INTO member VALUES('${p}','${t}',false,'active');
      INSERT INTO membership_billing_agreements(id,tenant_id,member_id,provider,status,metadata,gocardless_mandate_id)
      VALUES('${p}','${t}','${p}','gocardless','active','{"dd":{"instalment_count":12,"invoicing_mode":"per_instalment",
      "collection_policy":{"version":1,"pricing_policy":"dynamic"},"currency":"GBP",
      "commitment":{"term_key":"year","term_start_date":"2026-10-01","term_end_date":"2027-09-30"}}}','MD1');
      INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,member_id,metadata,status,gocardless_mandate_id,dynamic_next_collection_date)
      VALUES('${p}','${t}','${p}','${p}','{"collection_mode":"dynamic","dynamic_first_date":"2026-10-01","bnms_release_required":false,"bnms_beta_held":true}','active','MD1','2026-10-01');
      INSERT INTO membership_tier_config VALUES('${p}','${t}');
      INSERT INTO bnms_dd_beta_adoption(id,tenant_id,member_id,plan_id,agreement_id,mandate_id) VALUES('${p}','${t}','${p}','${p}','${p}','MD1');
    `);
    fails(reserve(`'{"checked_at":"2026-09-30T12:00:00Z","status":"active","next_possible_charge_date":"2026-10-05"}'`), /held/);
    sql(`INSERT INTO bnms_dd_beta_release VALUES('${p}','${t}','${p}','2026-09-30T23:00:00Z','{"price":{"monthly_amount_minor":1300}}')`);
    fails(reserve(`'{"checked_at":"2026-09-30T12:00:00Z","status":"active","next_possible_charge_date":"2026-10-05"}'`), /processing-not-before/);
    fails(`SET ROLE authenticated; SELECT * FROM ${auth}`, /permission denied/);
    fails(`SELECT * FROM ${auth.replace(t, '00000000-0000-4000-8000-000000000009')}`, /not found/);
    fails(`SELECT * FROM ${auth.replaceAll('2026-10-01', '2026-11-01')}`, /invalid/);
    sql(`UPDATE membership_payment_plans SET collection_stopped_at=now() WHERE id='${p}'`);
    fails(`SELECT * FROM ${auth}`, /invalid/);
    sql(`UPDATE membership_payment_plans SET collection_stopped_at=null WHERE id='${p}'`);
    financialSql(`SELECT id FROM ${auth}`);
    fails(`SELECT * FROM ${auth}`, /duplicate key/);
    fails(`UPDATE gocardless_manual_collection_authorizations SET amount_minor=1`, /immutable/);
    fails(`SET test.clock='2026-09-30T12:06:00Z';${reserve()}`, /processing-not-before|expired/);
    fails(reserve(evidence.replace("'manual_authorization_id'", "'wrong_authorization_id'")), /processing-not-before/);
    const parallel = statement => new Promise(resolve => {
      const child = spawn('psql', conn, { env });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('close', status => resolve({ status, out, err }));
      child.stdin.end(clock + statement);
    });
    // Same canonical reservation identity, irrespective of manual/cron caller.
    const raced = await Promise.all([parallel(reserve()), parallel(reserve()),
      parallel(reserve(`'{"checked_at":"2026-09-30T12:00:00Z","status":"active","next_possible_charge_date":"2026-10-05"}'`))]);
    assert.equal(raced[0].status, 0, raced[0].err);
    assert.equal(raced[1].status, 0, raced[1].err);
    assert.equal(raced[0].out, raced[1].out);
    assert.equal(sql('SELECT count(*) FROM gocardless_collection_reservations').trim().split('\n').at(-1), '1');
    // A provider-success/local-attachment delay past expiry is recoverable.
    financialSql(`SET test.clock='2026-09-30T12:10:00Z';
      SELECT attach_gocardless_dynamic_payment('${t}',(SELECT id FROM gocardless_collection_reservations),
      '{"id":"PM_TEST_ONLY","amount":1300,"currency":"GBP","charge_date":"2026-10-05","status":"pending_submission","links":{"mandate":"MD1"}}');`);
    assert.match(sql('SELECT dynamic_next_collection_date FROM membership_payment_plans'), /2026-11-01/);
    assert.match(sql('SELECT status FROM gocardless_collection_reservations'), /submitted/);
    fails(`SELECT * FROM ${auth}`, /invalid|duplicate/);
    fails(`SELECT * FROM ${auth.replaceAll('2026-10-01', '2026-11-01').replace(',1,1300', ',2,1300')}`, /invalid/);
    // Revoking accepted evidence must not prevent attachment recovery.
    financialSql(`SELECT revoke_gocardless_manual_collection((SELECT id FROM gocardless_manual_collection_authorizations),'finance@example.test','Stop any new unreserved attempt');
      SET test.clock='2026-09-30T12:20:00Z';
      SELECT attach_gocardless_dynamic_payment('${t}',(SELECT id FROM gocardless_collection_reservations),
      '{"id":"PM_TEST_ONLY","amount":1300,"currency":"GBP","charge_date":"2026-10-05","status":"submitted","links":{"mandate":"MD1"}}');`);
    // Exercise the actual other cohort reservation AND payment guards, including
    // attachment after expiry. No stand-in payment or reservation function.
    for (const [index, cohort] of ['alpha', 'pilot', 'manual'].entries()) {
      const id = cohort === 'pilot' ? '33e5d54d-162e-436d-9bff-ec6676d198f9'
        : `00000000-0000-4000-8000-00000000001${index}`;
      const tenant = cohort === 'pilot' ? 'ff2df806-b321-4254-b651-3af11fccf1db' : t;
      const mandate = `MD_${cohort}`;
      const adoption = `bnms_dd_${cohort}_adoption`, release = `bnms_dd_${cohort}_release`;
      sql(`
        INSERT INTO member VALUES('${id}','${tenant}',false,'active');
        INSERT INTO membership_billing_agreements(id,tenant_id,member_id,provider,status,metadata,gocardless_mandate_id)
          SELECT '${id}','${tenant}','${id}',provider,status,metadata,'${mandate}' FROM membership_billing_agreements WHERE id='${p}';
        INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,member_id,metadata,status,gocardless_mandate_id,dynamic_next_collection_date)
          SELECT '${id}','${tenant}','${id}','${id}',metadata || '{"bnms_alpha_held":true}',status,'${mandate}','2026-10-01' FROM membership_payment_plans WHERE id='${p}';
        INSERT INTO membership_tier_config VALUES('${id}','${tenant}');
        INSERT INTO ${adoption}(id,tenant_id,member_id,plan_id,agreement_id,mandate_id)
          VALUES('${id}','${tenant}','${id}','${id}','${id}','${mandate}');
        INSERT INTO ${release} VALUES('${id}','${tenant}','${id}','2026-09-30T23:00:00Z','{"price":{"monthly_amount_minor":1300}}');
        ${cohort === 'manual' ? `UPDATE ${adoption} SET evidence='{"monthlyQuoteMinor":1300}' WHERE id='${id}';` : ''}
      `);
      const remap = text => text.replaceAll(p, id).replaceAll(t, tenant).replaceAll('MD1', mandate);
      const agreementBefore = sql(`SELECT metadata FROM membership_billing_agreements WHERE id='${id}'`);
      financialSql(`SELECT id FROM ${remap(auth)}`);
      fails(remap(reserve()).replace('"monthly_amount_minor":1300', '"monthly_amount_minor":1400'), /price|cadence|mismatch|expired|evidence/i);
      sql(remap(reserve()));
      financialSql(`SET test.clock='2026-09-30T12:15:00Z';
        SELECT attach_gocardless_dynamic_payment('${tenant}',(SELECT id FROM gocardless_collection_reservations WHERE plan_id='${id}'),
        '{"id":"PM_${cohort}_TEST","amount":1300,"currency":"GBP","charge_date":"2026-10-05","status":"pending_submission","links":{"mandate":"${mandate}"}}');`);
      assert.match(sql(`SELECT dynamic_next_collection_date FROM membership_payment_plans WHERE id='${id}'`), /2026-11-01/);
      assert.match(sql(`SELECT amount_minor,currency,charge_date,status FROM gocardless_payments WHERE plan_id='${id}'`),
        /1300\|GBP\|2026-10-05\|pending_submission/);
      assert.equal(sql(`SELECT metadata FROM membership_billing_agreements WHERE id='${id}'`), agreementBefore);
      if (cohort !== 'pilot') {
        fails(`UPDATE membership_billing_agreements SET gocardless_mandate_id='WRONG' WHERE id='${id}'`, /immutable|drift/i);
        fails(`UPDATE membership_payment_plans SET gocardless_mandate_id='WRONG' WHERE id='${id}'`, /immutable|drift/i);
      }
    }
    if (cadence === 'original') {
      assert.match(sql("SELECT to_regprocedure('public.gocardless_dynamic_collection_due_date(uuid,integer)') IS NULL"), /t/);
      fails(`BEGIN; UPDATE membership_payment_plans SET metadata=metadata||'{"collection_schedule_version":0}' WHERE id='${p}';
        SET ROLE service_role; SELECT gocardless_manual_collection_due_date('${t}','${p}',2);`, /version evidence/);
      const amendmentTable = source('20261109_manage_monthly_collection_days.sql')
        .match(/CREATE TABLE IF NOT EXISTS public\.gocardless_collection_day_amendments[\s\S]*?\n\);/)[0];
      fails(`BEGIN; ${amendmentTable}
        INSERT INTO gocardless_collection_day_amendments(request_id,tenant_id,plan_id,day,version,previous_anchor,proposed_anchor,effective_date,reservation_count)
        VALUES(gen_random_uuid(),'${t}','${p}',1,0,'2026-10-01','2026-10-01','2026-11-01',1);
        SET ROLE service_role; SELECT gocardless_manual_collection_due_date('${t}','${p}',2);`, /amendment evidence/);
      sql(`INSERT INTO membership_payment_plans(id,tenant_id,metadata)
        VALUES('00000000-0000-4000-8000-000000000099','${t}','{"dynamic_first_date":"2028-01-31"}')`);
      assert.match(financialSql(`SELECT gocardless_manual_collection_due_date('${t}','00000000-0000-4000-8000-000000000099',2)`), /2028-02-29/);
      fails(`SET ROLE service_role; SELECT gocardless_manual_collection_due_date('00000000-0000-4000-8000-000000000088','${p}',1)`, /tenant-owned/);
      fails(`SET ROLE authenticated; SELECT gocardless_manual_collection_due_date('${t}','${p}',1)`, /permission denied/);
    }
    if (cadence === 'amended') {
      const originalReserve = original.match(/CREATE OR REPLACE FUNCTION public\.reserve_gocardless_dynamic_collection\([\s\S]*?END \$\$;/)[0];
      fails(`BEGIN; ${originalReserve} SET ROLE service_role;
        SELECT gocardless_manual_collection_due_date('${t}','${p}',2);`, /amended financial cadence is inconsistent/);
    // Amended period uses the canonical helper and retains its next-month anchor.
    const amended = '00000000-0000-4000-8000-000000000020';
    sql(`
      INSERT INTO member VALUES('${amended}','${t}',false,'active');
      INSERT INTO membership_billing_agreements(id,tenant_id,member_id,provider,status,metadata,gocardless_mandate_id)
        SELECT '${amended}','${t}','${amended}',provider,status,
        jsonb_set(metadata,'{dd,commitment,term_start_date}','"2026-09-01"'),'MD_AMENDED'
        FROM membership_billing_agreements WHERE id='${p}';
      INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,member_id,metadata,status,gocardless_mandate_id,dynamic_next_collection_date)
        VALUES('${amended}','${t}','${amended}','${amended}',
        '{"collection_mode":"dynamic","dynamic_first_date":"2026-09-28","collection_schedule_version":1}','active','MD_AMENDED','2026-09-28');
      INSERT INTO membership_tier_config VALUES('${amended}','${t}');
      INSERT INTO gocardless_collection_day_amendments(request_id,tenant_id,plan_id,day,version,previous_anchor,proposed_anchor,effective_date,reservation_count,applied_at)
        VALUES('${amended}','${t}','${amended}',28,0,'2026-09-30','2026-09-28','2026-09-28',0,now());
    `);
    const amendedAuth = auth.replaceAll(p, amended).replaceAll('MD1', 'MD_AMENDED').replaceAll('2026-10-01', '2026-09-28').replaceAll('2026-10-05', '2026-09-30');
    financialSql(`SELECT id FROM ${amendedAuth}`);
    const amendedReserve = reserve().replaceAll(p, amended).replaceAll('2026-10-01', '2026-09-28').replaceAll('2026-10-05', '2026-09-30');
    sql(amendedReserve);
    financialSql(`SELECT attach_gocardless_dynamic_payment('${t}',(SELECT id FROM gocardless_collection_reservations WHERE plan_id='${amended}'),
      '{"id":"PM_AMENDED_TEST","amount":1300,"currency":"GBP","charge_date":"2026-09-30","status":"submitted","links":{"mandate":"MD_AMENDED"}}');`);
    assert.match(sql(`SELECT dynamic_next_collection_date FROM membership_payment_plans WHERE id='${amended}'`), /2026-10-28/);
    // A legitimate subsequent schedule amendment must not turn repeat clicks
    // into another manual attempt in the same London execution month.
    sql(`
      INSERT INTO gocardless_collection_day_amendments(request_id,tenant_id,plan_id,day,version,previous_anchor,proposed_anchor,effective_date,reservation_count,applied_at)
        VALUES(gen_random_uuid(),'${t}','${amended}',1,1,'2026-09-28','2026-09-01','2026-10-01',1,now());
      UPDATE membership_payment_plans SET metadata='{"collection_mode":"dynamic","dynamic_first_date":"2026-09-01","collection_schedule_version":2}',
        dynamic_next_collection_date='2026-10-01' WHERE id='${amended}';
    `);
    fails(`SELECT id FROM ${auth.replaceAll(p, amended).replaceAll('MD1', 'MD_AMENDED').replace(',1,1300', ',2,1300')}`, /duplicate key/);
    }

    // A revocation before reservation acceptance prevents submission forever.
    const revoked = '00000000-0000-4000-8000-000000000030';
    sql(`
      INSERT INTO member VALUES('${revoked}','${t}',false,'active');
      INSERT INTO membership_billing_agreements(id,tenant_id,member_id,provider,status,metadata,gocardless_mandate_id)
        SELECT '${revoked}','${t}','${revoked}',provider,status,metadata,'MD_REVOKED' FROM membership_billing_agreements WHERE id='${p}';
      INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,member_id,metadata,status,gocardless_mandate_id,dynamic_next_collection_date)
        SELECT '${revoked}','${t}','${revoked}','${revoked}',metadata,status,'MD_REVOKED','2026-10-01' FROM membership_payment_plans WHERE id='${p}';
      INSERT INTO membership_tier_config VALUES('${revoked}','${t}');
      SELECT id FROM ${auth.replaceAll(p, revoked).replaceAll('MD1', 'MD_REVOKED')};
      SELECT revoke_gocardless_manual_collection((SELECT id FROM gocardless_manual_collection_authorizations WHERE plan_id='${revoked}'),
        'finance@example.test','Revoked before reservation acceptance');
    `);
    fails(reserve().replaceAll(p, revoked), /revoked/);
    fails(`SET ROLE service_role; INSERT INTO gocardless_manual_collection_authorizations(tenant_id) VALUES('${t}')`, /permission denied/);
  } finally {
    if (started) run('pg_ctl', ['-D', harness.data, '-m', 'immediate', '-w', 'stop']);
    await harness.cleanup();
  }
});
}