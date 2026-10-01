import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { applyRepair, verifyExpectedBefore, validateArgs, validateEvidence, TENANT } from '../../scripts/repair-gocardless-payment-environment.mjs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const migration = source('20261124_gocardless_payment_environment.sql');
test('runner rejects ambiguous arguments and unpinned evidence before connecting', () => {
  assert.equal(validateArgs([]).apply, false);
  for (const args of [['--apply'], ['--apply', '--preflight'], ['--x'], ['--evidence=a', '--evidence=b']]) {
    assert.throws(() => validateArgs(args));
  }
  assert.throws(() => validateEvidence(Buffer.from('{}')), /SHA-256 mismatch/);
});

for (const cadence of ['original', 'amended']) {
  test(`isolated PostgreSQL ${cadence}: environment, ownership, cadence, retries and targeted repair`, { timeout: 60000 }, async () => {
    const harness = await createLocalPostgresHarness('gc-environment-');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' };
    const run = (command, args, input) => {
      const result = spawnSync(command, args, { input, encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    const conn = ['-h', harness.socket, '-p', String(harness.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
    const sql = input => run('psql', conn, input);
    const fails = (input, pattern) => {
      const result = spawnSync('psql', conn, { input, encoding: 'utf8', env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    };
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const plan = id(1), other = id(2), reservation = id(3);
    let started = false, client;
    try {
      run('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'postgres']);
      run('pg_ctl', ['-D', harness.data, '-l', path.join(harness.root, 'postgres.log'),
        '-o', `-F -k ${harness.socket} -c listen_addresses= -p ${harness.port}`, '-w', 'start']);
      started = true;
      sql(source('20261109_manage_monthly_collection_days.test.mjs').match(/sql\(`([\s\S]*?)`\);/)[1]);
      sql(`ALTER TABLE membership_payment_plans ADD COLUMN provider text DEFAULT 'gocardless', ADD COLUMN environment text;
        ALTER TABLE membership_billing_agreements ADD COLUMN environment text;
        ALTER TABLE gocardless_payments ADD COLUMN environment text DEFAULT 'sandbox', ADD COLUMN metadata jsonb;`);
      // Real current payment guards, including their existing manual timing
      // amendment. Fixture cohort tables contain no imported historical payments.
      sql(`CREATE TABLE bnms_dd_alpha_adoption(id uuid,tenant_id uuid,plan_id uuid,mandate_id text);
        CREATE TABLE bnms_dd_alpha_release(adoption_id uuid);
        CREATE TABLE bnms_dd_alpha_provider_history(provider_payment_id text);
        CREATE TABLE bnms_dd_beta_provider_history(provider_payment_id text);
        CREATE TABLE bnms_dd_historical_payment(provider_payment_id text);
        CREATE TABLE bnms_dd_manual_adoption(id uuid,tenant_id uuid,plan_id uuid,agreement_id uuid,mandate_id text);
        CREATE FUNCTION gocardless_manual_payment_authorized(uuid,uuid,text,integer,text,date)
        RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'This fixture must never authorize manual collection'; END $$;`);
      for (const [file, fn, trigger] of [
        ['20261108_bnms_dd_pilot_history.sql', 'bnms_dd_protect_canonical_payment', 'bnms_dd_no_historical_provider_replay'],
        ['20261112_bnms_dd_beta_held.sql', 'bnms_dd_beta_protect_payment', 'bnms_dd_beta_no_historical_replay'],
        ['20261117_bnms_dd_alpha_scheduled_release.sql', 'bnms_dd_alpha_protect_payment', 'bnms_dd_alpha_no_historical_replay'],
        ['20261121_bnms_dd_manual_95.sql', 'bnms_manual_payment_guard', 'bnms_manual_payment_guard'],
      ]) {
        let definition = source(file).match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?END \\$\\$;`))[0];
        if (fn === 'bnms_dd_alpha_protect_payment') definition = definition.replace(
          "clock_timestamp()<TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'",
          "(clock_timestamp()<TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London' AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,a.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))");
        if (fn === 'bnms_manual_payment_guard') definition = definition.replace(
          "clock_timestamp()<'2026-10-01 00:00:00 Europe/London'::timestamptz",
          "(clock_timestamp()<'2026-10-01 00:00:00 Europe/London'::timestamptz AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,NEW.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))");
        sql(`${definition}
          CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON public.gocardless_payments FOR EACH ROW EXECUTE FUNCTION public.${fn}();`);
      }
      const original = source('20261108_explicit_direct_debit_collection_policy.sql');
      sql(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(')));
      sql(source('20261109_gocardless_dynamic_term_completion.sql'));
      if (cadence === 'amended') sql(source('20261109_manage_monthly_collection_days.sql'));
      sql(source('20261123_gocardless_manual_collection.sql').match(
        /CREATE OR REPLACE FUNCTION public\.gocardless_manual_collection_due_date\([\s\S]*?END \$\$;/)[0]);
      const security = () => sql(`SELECT proname,proacl,proconfig,prosecdef,proowner FROM pg_proc
        WHERE proname LIKE 'attach_gocardless_dynamic_payment%' ORDER BY proname`);
      const beforeSecurity = security();
      sql(migration);
      sql(migration);
      assert.equal(security(), beforeSecurity);
      sql(`INSERT INTO membership_billing_agreements(id,tenant_id,provider,environment,metadata,gocardless_mandate_id)
        VALUES('${plan}','${TENANT}','gocardless','live','{"dd":{"instalment_count":12,"commitment":{"term_end_date":"2090-12-31"}}}','MD1');
        INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,environment,metadata,gocardless_mandate_id)
        VALUES('${plan}','${TENANT}','${plan}','live','{"collection_mode":"dynamic","dynamic_first_date":"2090-01-15"}','MD1');
        INSERT INTO gocardless_collection_reservations(id,plan_id,tenant_id,billing_agreement_id,collection_number,requested_charge_date,amount_minor,currency,provider_evidence)
        VALUES('${reservation}','${plan}','${TENANT}','${plan}',1,'2090-01-15',1300,'GBP','{}');`);
      const payload = { id: 'PM1', amount: 1300, currency: 'GBP', charge_date: '2090-01-15',
        status: 'pending_submission', links: { mandate: 'MD1' } };
      const attach = (payment = payload) => `SET ROLE service_role; SELECT id FROM attach_gocardless_dynamic_payment('${TENANT}','${reservation}','${JSON.stringify(payment)}');`;
      sql(attach());
      assert.equal(sql('SELECT environment FROM gocardless_payments'), 'live');
      assert.equal(sql('SELECT metadata IS NULL FROM gocardless_payments'), 't');
      assert.equal(sql('SELECT dynamic_next_collection_date FROM membership_payment_plans'), '2090-02-15');
      assert.equal(sql(`SELECT gocardless_manual_collection_due_date('${TENANT}','${plan}',2)`), '2090-02-15');
      sql(`UPDATE gocardless_payments SET status='confirmed',metadata='{"preserve":true}'`);
      const paymentBefore = sql('SELECT to_jsonb(p) FROM gocardless_payments p');
      sql(attach());
      assert.equal(sql('SELECT to_jsonb(p) FROM gocardless_payments p'), paymentBefore);
      fails(attach({ ...payload, environment: 'sandbox' }), /environment mismatch/);
      for (const [column, wrong, correct] of [
        ['tenant_id', other, TENANT], ['plan_id', other, plan], ['environment', 'sandbox', 'live'],
        ['gocardless_mandate_id', 'MD_WRONG', 'MD1'], ['amount_minor', '1400', '1300'],
        ['currency', 'EUR', 'GBP'], ['charge_date', '2090-01-16', '2090-01-15'],
      ]) {
        sql(`UPDATE gocardless_payments SET ${column}='${wrong}'; UPDATE gocardless_collection_reservations SET status='reserved'`);
        const before = sql('SELECT to_jsonb(p) FROM gocardless_payments p');
        fails(attach(), /Payment mirror conflicts/);
        assert.equal(sql('SELECT to_jsonb(p) FROM gocardless_payments p'), before);
        assert.equal(sql('SELECT status FROM gocardless_collection_reservations'), 'reserved');
        sql(`UPDATE gocardless_payments SET ${column}='${correct}'`);
      }
      for (const [table, column, wrong, correct, pattern] of [
        ['membership_payment_plans', 'environment', 'invalid', 'live', /environment mismatch/],
        ['membership_payment_plans', 'environment', null, 'live', /environment mismatch/],
        ['membership_billing_agreements', 'environment', 'sandbox', 'live', /environment mismatch/],
        ['membership_payment_plans', 'billing_agreement_id', other, plan, /ownership or environment mismatch/],
        ['membership_billing_agreements', 'tenant_id', other, TENANT, /agreement not found in tenant/],
        ['membership_billing_agreements', 'gocardless_mandate_id', 'MD_OTHER', 'MD1', /ownership or environment mismatch/],
      ]) {
        sql(`UPDATE ${table} SET ${column}=${wrong === null ? 'NULL' : `'${wrong}'`}`);
        fails(attach(), pattern);
        sql(`UPDATE ${table} SET ${column}='${correct}'`);
      }
      sql(`DELETE FROM gocardless_payments;
        UPDATE membership_payment_plans SET environment='sandbox';
        UPDATE membership_billing_agreements SET environment='sandbox'`);
      sql(attach());
      assert.equal(sql('SELECT environment FROM gocardless_payments'), 'sandbox');
      // Entire unrecognized function changes fail closed, even if insert text matches.
      const target = cadence === 'amended' ? 'attach_gocardless_dynamic_payment_before_schedule_amendments' : 'attach_gocardless_dynamic_payment';
      sql(`DO $$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.${target}(uuid,uuid,jsonb)'::regprocedure) INTO d;
        EXECUTE replace(d,'  next_due date;','  next_due date; -- unexpected drift'); END $$;`);
      fails(migration, /Unreviewed attachment implementation/);
      sql(`DO $$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.${target}(uuid,uuid,jsonb)'::regprocedure) INTO d;
        EXECUTE replace(d,'  next_due date; -- unexpected drift','  next_due date;'); END $$;`);

      // Synthetic fixture only: exact-ID backfill plus one extra payment sharing
      // a cohort mandate. No workspace connection or provider credentials used.
      sql('TRUNCATE gocardless_payments,gocardless_collection_reservations,membership_payment_plans,membership_billing_agreements CASCADE');
      const evidence = { matched: [] };
      for (let n = 1000; n < 1355; n++) {
        const pid = id(n), rid = id(n + 1000), cid = id(n + 2000);
        evidence.matched.push({ tenantId: TENANT, planId: pid, billingAgreementId: pid,
          reservationId: rid, canonicalPaymentRowId: cid, providerPaymentId: `PM${n}`, providerMandateId: `MD${n}`,
          canonicalEnvironment: 'sandbox', amountMinor: 1300, currency: 'GBP', chargeDate: '2090-10-06',
          canonicalStatus: 'pending_submission', canonicalUpdatedAt: '2090-10-01T10:00:00.000Z',
          dueDate: '2090-10-01', requestedChargeDate: '2090-10-06', reservationStatus: 'submitted' });
      }
      sql(evidence.matched.map(e => `
        INSERT INTO membership_billing_agreements(id,tenant_id,provider,environment,gocardless_mandate_id)
          VALUES('${e.planId}','${TENANT}','gocardless','live','${e.providerMandateId}');
        INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,environment,gocardless_mandate_id,metadata)
          VALUES('${e.planId}','${TENANT}','${e.planId}','live','${e.providerMandateId}','{"holds":"unchanged"}');
        INSERT INTO gocardless_collection_reservations(id,plan_id,tenant_id,billing_agreement_id,requested_charge_date,due_date,amount_minor,currency,gocardless_payment_id,status)
          VALUES('${e.reservationId}','${e.planId}','${TENANT}','${e.planId}','${e.chargeDate}','${e.dueDate}',1300,'GBP','${e.providerPaymentId}','submitted');
        INSERT INTO gocardless_payments(id,plan_id,tenant_id,gocardless_payment_id,gocardless_mandate_id,amount_minor,currency,charge_date,status,updated_at,metadata)
          VALUES('${e.canonicalPaymentRowId}','${e.planId}','${TENANT}','${e.providerPaymentId}','${e.providerMandateId}',1300,'GBP','${e.chargeDate}','pending_submission','${e.canonicalUpdatedAt}','{"untouched":true}');
      `).join('\n'));
      sql(`INSERT INTO gocardless_payments(id,tenant_id,gocardless_payment_id,gocardless_mandate_id,amount_minor,charge_date)
        VALUES('${id(9999)}','${TENANT}','PM_EXTRA','MD1000',1304,'2090-10-08');
        INSERT INTO bnms_dd_manual_adoption VALUES('${id(1001)}','${TENANT}','${id(1001)}','${id(1001)}','MD1001');
        INSERT INTO bnms_dd_alpha_adoption VALUES('${id(1002)}','${TENANT}','${id(1002)}','MD1002');
        INSERT INTO bnms_dd_alpha_release VALUES('${id(1002)}')`);
      client = new pg.Client({ host: harness.socket, port: harness.port, user: 'postgres', database: 'postgres', ssl: false });
      await client.connect();
      assert.equal((await verifyExpectedBefore(client, evidence)).length, 355);
      sql(`UPDATE gocardless_payments SET status='confirmed' WHERE id='${id(3000)}'`);
      await assert.rejects(applyRepair(client, migration, evidence), /Expected-before/);
      assert.equal(sql("SELECT count(*) FROM gocardless_payments WHERE environment='live'"), '0');
      sql(`UPDATE gocardless_payments SET status='pending_submission' WHERE id='${id(3000)}'`);
      // A new side-effecting trigger is rejected BEFORE any DML executes.
      sql(`CREATE FUNCTION test_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.metadata='{}'; RETURN NEW; END $$;
        CREATE TRIGGER test_side_effect BEFORE UPDATE ON gocardless_payments FOR EACH ROW EXECUTE FUNCTION test_side_effect()`);
      await assert.rejects(applyRepair(client, migration, evidence), /Payment trigger contract drift/);
      assert.equal(sql("SELECT count(*) FROM gocardless_payments WHERE environment='live'"), '0');
      sql('DROP TRIGGER test_side_effect ON gocardless_payments');
      const result = await applyRepair(client, migration, evidence);
      assert.equal(result.updatedPayments, 355);
      assert.equal(sql("SELECT count(*) FROM gocardless_payments WHERE environment='live'"), '355');
      assert.equal(sql("SELECT environment FROM gocardless_payments WHERE gocardless_payment_id='PM_EXTRA'"), 'sandbox');
      await assert.rejects(applyRepair(client, migration, evidence), /Expected-before/);
    } finally {
      if (client) await client.end();
      if (started) run('pg_ctl', ['-D', harness.data, '-m', 'immediate', '-w', 'stop']);
      await harness.cleanup();
    }
  });
}