import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated PostgreSQL: durable previews, no consent mutation, stale/duplicate/unsafe requests', { timeout: 45000 }, async () => {
  const harness = await createLocalPostgresHarness('collection-day-');
  const { root, data, socket } = harness;
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  const conn = ['-h', socket, '-p', String(harness.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = input => run('psql', conn, input);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${harness.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid,tenant_id uuid,membership_paused boolean,status text);
      CREATE TABLE organization(LIKE member);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,provider text,status text,metadata jsonb,gocardless_mandate_id text);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,billing_agreement_id uuid,member_id uuid,organization_id uuid,
        metadata jsonb,status text,collection_stopped_at timestamptz,gocardless_subscription_id text,gocardless_mandate_id text,
        dynamic_next_collection_date date,dynamic_next_check_at timestamptz,updated_at timestamptz,
        amount_minor integer,next_charge_date date,dynamic_collection_error text,completed_at timestamptz);
      CREATE TABLE membership_monthly_arrears_period(plan_id uuid,tenant_id uuid,settled_at timestamptz);
      CREATE TABLE gocardless_collection_reservations(id uuid DEFAULT gen_random_uuid(),plan_id uuid,tenant_id uuid,
        status text DEFAULT 'reserved',requested_charge_date date,billing_agreement_id uuid,collection_number integer,
        term_key text,due_date date,amount_minor integer,currency text,price_snapshot jsonb,provider_evidence jsonb,
        idempotency_key text,gocardless_payment_id text,provider_charge_date date,updated_at timestamptz);
      CREATE TABLE gocardless_payments(id uuid DEFAULT gen_random_uuid(),plan_id uuid,tenant_id uuid,status text,charge_date date,
        gocardless_payment_id text UNIQUE,gocardless_mandate_id text,amount_minor integer,currency text,updated_at timestamptz);
      CREATE TABLE membership_tier_config(id uuid,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid,tenant_id uuid,billing_agreement_id uuid,member_id uuid,
        term_key text,payment_status text,paid_at timestamptz,final_cost numeric);
      CREATE TABLE organisation_membership_history(id uuid,tenant_id uuid,billing_agreement_id uuid,organization_id uuid,
        term_key text,payment_status text,paid_at timestamptz,final_cost numeric);
      CREATE TABLE membership_payment_status_history(tenant_id uuid,entity_type text,entity_id uuid,from_status text,to_status text,reason text,source text);
    `);
    // Execute the real existing reservation and attachment functions too, not
    // stand-ins: lock interactions must cover the production collector path.
    const original = readFileSync(new URL('./20261108_explicit_direct_debit_collection_policy.sql', import.meta.url), 'utf8');
    sql(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(')));
    sql(readFileSync(new URL('./20261109_gocardless_dynamic_term_completion.sql', import.meta.url), 'utf8'));
    const amendmentMigration = readFileSync(new URL('./20261109_manage_monthly_collection_days.sql', import.meta.url), 'utf8');
    sql(amendmentMigration);
    sql(amendmentMigration); // Applying twice must not rename the wrapper over its implementation.
    const tenant = '00000000-0000-4000-8000-000000000001';
    const id = '00000000-0000-4000-8000-000000000002';
    const req = '00000000-0000-4000-8000-000000000003';
    // Future full calendar term avoids dependence on today's bank calendar.
    sql(`
      INSERT INTO tenant VALUES('${tenant}');
      INSERT INTO member VALUES('${id}','${tenant}',false,'active');
      INSERT INTO membership_billing_agreements VALUES('${id}','${tenant}','${id}',null,'gocardless','active',
        jsonb_build_object('dd',jsonb_build_object('instalment_count',12,'invoicing_mode','per_instalment',
          'collection_policy',jsonb_build_object('version',1,'pricing_policy','dynamic'),
          'currency','GBP',
          'commitment',jsonb_build_object('term_key','rolling:2090','term_start_date','2090-01-01','term_end_date','2090-12-31'))),'MD1');
      INSERT INTO membership_payment_plans(id,tenant_id,billing_agreement_id,member_id,organization_id,metadata,status,
        collection_stopped_at,gocardless_subscription_id,gocardless_mandate_id,dynamic_next_collection_date,
        dynamic_next_check_at,updated_at,amount_minor,next_charge_date,dynamic_collection_error) VALUES('${id}','${tenant}','${id}','${id}',null,
        '{"collection_mode":"dynamic","dynamic_first_date":"2090-01-15"}','active',null,null,'MD1','2090-01-15',null,now(),1200,null,null);
      INSERT INTO membership_tier_config VALUES('${id}','${tenant}');
    `);
    const call = (confirm, request = req, day = 20, tenantId = tenant, notice = '2090-01-01') =>
      `SELECT applied_at IS NOT NULL FROM change_gocardless_collection_day('${tenantId}','${id}','${request}',${day},${confirm},'${notice}','admin');`;
    assert.match(sql(call(false)), /f/);
    const consent = sql('SELECT metadata FROM membership_billing_agreements');
    assert.match(sql(call(true)), /t/);
    assert.match(sql(call(true)), /t/);
    assert.equal(sql('SELECT metadata FROM membership_billing_agreements'), consent);
    assert.match(sql('SELECT dynamic_next_collection_date FROM membership_payment_plans'), /2090-01-20/);
    assert.match(sql('SELECT count(*) FROM gocardless_collection_day_amendments WHERE applied_at IS NOT NULL'), /1/);
    const fails = statement => {
      const r = spawnSync('psql', conn, { input: statement, encoding: 'utf8' });
      assert.notEqual(r.status, 0, r.stdout);
      return r.stderr;
    };
    assert.match(fails(call(true, req, 21)), /identity conflict/);
    assert.match(fails(call(false, req, 20, id)), /not found in tenant/);
    const next = '00000000-0000-4000-8000-000000000004';
    assert.match(sql(call(false, next, 25)), /f/);
    sql(`INSERT INTO gocardless_collection_reservations(id,plan_id,tenant_id,status,requested_charge_date) VALUES('${id}','${id}','${tenant}','reserved','2090-01-20')`);
    assert.match(fails(call(true, next, 25)), /unresolved collection/);
    sql(`UPDATE gocardless_collection_reservations SET status='submitted'`);
    assert.match(fails(call(true, next, 25)), /preview expired/);
    assert.match(fails(call(false, next, 25, tenant, '2090-03-01')), /notice window/);
    sql(`UPDATE member SET membership_paused=true`);
    assert.match(fails(call(false, next, 25)), /lifecycle/);

    sql(`UPDATE member SET membership_paused=false; DELETE FROM gocardless_collection_reservations; TRUNCATE gocardless_collection_day_amendments;
      UPDATE membership_payment_plans SET metadata=metadata-'collection_schedule_version';`);
    const start = (statement, name) => {
      let output = '';
      let errors = '';
      let readyResolve;
      const ready = new Promise(resolve => { readyResolve = resolve; });
      const process = spawn('psql', conn, { env: { ...globalThis.process.env, PGAPPNAME: name } });
      process.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED')) readyResolve(); });
      process.stderr.on('data', chunk => { errors += chunk; });
      const done = new Promise(resolve => process.on('close', code => { readyResolve(); resolve({ code, output, errors }); }));
      process.stdin.end(statement);
      return { ready, done };
    };
    const lockPrefix = `BEGIN; SELECT id FROM membership_payment_plans WHERE id='${id}' FOR UPDATE; SELECT 'LOCKED'; SELECT pg_sleep(0.5);`;
    const contend = async (first, second) => {
      const leader = start(`${lockPrefix}${first} COMMIT;`, 'schedule_leader');
      await leader.ready;
      const follower = start(second, 'schedule_follower');
      // Verify a REAL second database session is waiting on the first lock.
      let waited = false;
      for (let i = 0; i < 20; i++) {
        if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='schedule_follower' AND wait_event_type='Lock'`).trim() === '1') {
          waited = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const results = await Promise.all([leader.done, follower.done]);
      assert.ok(waited, 'Expected actual competing SQL session blocked on the plan lock');
      assert.equal(results[0].code, 0, results[0].errors);
      return results[1];
    };
    // Two simultaneous confirmations of one persisted preview apply exactly once.
    sql(call(false, req, 22));
    const duplicate = await contend(call(true, req, 22), call(true, req, 22));
    assert.equal(duplicate.code, 0, duplicate.errors);
    assert.match(sql(`SELECT count(*) FROM gocardless_collection_day_amendments WHERE applied_at IS NOT NULL`), /1/);
    assert.match(sql(`SELECT metadata->>'collection_schedule_version' FROM membership_payment_plans`), /1/);
    const reserve = due => `SELECT id FROM reserve_gocardless_dynamic_collection('${tenant}','${id}',1,'${due}',
      '{"currency":"GBP","config_id":"${id}","intended_date":"${due}","monthly_amount_minor":1200}',
      '{"next_possible_charge_date":"${due}","status":"active"}','stable-payment-key');`;
    // Amendment wins: collector carrying the previously read intended date fails closed.
    sql(call(false, next, 24));
    const staleReserve = await contend(call(true, next, 24), reserve('2090-01-22'));
    assert.notEqual(staleReserve.code, 0);
    assert.match(staleReserve.errors, /does not match its purchased term/);
    assert.equal(sql('SELECT count(*) FROM gocardless_collection_reservations').trim(), '0');
    // Reservation wins: change is rejected while provider submission is in flight.
    const third = '00000000-0000-4000-8000-000000000005';
    sql(call(false, third, 26));
    const blocked = await contend(reserve('2090-01-24'), call(true, third, 26));
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.errors, /unresolved collection/);
    const reservationId = sql('SELECT id FROM gocardless_collection_reservations').trim();
    const attach = `SELECT id FROM attach_gocardless_dynamic_payment('${tenant}','${reservationId}',
      '{"id":"PM_TEST","amount":1200,"currency":"GBP","charge_date":"2090-01-24","status":"pending_submission","links":{"mandate":"MD1"}}');`;
    // Attachment wins: a pre-reservation preview cannot become valid by racing
    // the transition to submitted. Count validation still rejects it.
    const staleAfterAttach = await contend(attach, call(true, third, 26));
    assert.notEqual(staleAfterAttach.code, 0);
    assert.match(staleAfterAttach.errors, /preview expired/);
    const fourth = '00000000-0000-4000-8000-000000000006';
    sql(call(false, fourth, 28));
    // Amendment wins vs old provider-webhook replay: attachment must read the
    // NEW anchor under the same lock and cannot restore the old next date.
    const replay = await contend(call(true, fourth, 28), attach);
    assert.equal(replay.code, 0, replay.errors);
    assert.equal(sql('SELECT dynamic_next_collection_date FROM membership_payment_plans').trim(), '2090-02-28');
    assert.equal(sql('SELECT count(*) FROM gocardless_payments').trim(), '1');

    // Real original completion RPC (with only its date expressions adapted):
    // settle collection #1 at day 24, #2 at day 28, then amend again and settle
    // the rest at day 26. Both stop and continuation-consented terms must settle.
    for (const endPolicy of ['stop', 'continue']) {
      if (endPolicy === 'continue') {
        // A fresh successor agreement/plan has its own independent version chain.
        sql(`TRUNCATE gocardless_dynamic_completion_deliveries,gocardless_dynamic_term_completions;
          TRUNCATE gocardless_collection_day_amendments; DELETE FROM gocardless_collection_reservations; DELETE FROM gocardless_payments;
          DELETE FROM member_membership_history;
          UPDATE membership_payment_plans SET metadata='{"collection_mode":"dynamic","dynamic_first_date":"2090-01-24"}',
            status='active',completed_at=NULL,dynamic_next_collection_date='2090-01-24';`);
        sql(reserve('2090-01-24'));
        const firstId = sql('SELECT id FROM gocardless_collection_reservations').trim();
        sql(attach.replace(reservationId, firstId));
        const freshReq = '00000000-0000-4000-8000-000000000007';
        sql(call(false, freshReq, 28)); sql(call(true, freshReq, 28));
      }
      sql(`UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{dd,collection_policy,end_policy}','"${endPolicy}"');
        INSERT INTO member_membership_history VALUES('${id}','${tenant}','${id}','${id}','rolling:2090','partial',NULL,144);
        UPDATE gocardless_collection_reservations SET provider_evidence=provider_evidence||'{"status":"confirmed"}';
        UPDATE gocardless_payments SET status='confirmed';`);
      assert.match(sql(`SELECT complete_gocardless_dynamic_term('${tenant}','${id}')->>'completed'`), /false/);
      for (let number = 2; number <= 12; number++) {
        if (number === 3) {
          const reqId = endPolicy === 'stop' ? '00000000-0000-4000-8000-000000000008' : '00000000-0000-4000-8000-000000000009';
          sql(call(false, reqId, 26)); sql(call(true, reqId, 26));
        }
        const due = `2090-${String(number).padStart(2, '0')}-${number === 2 ? '28' : '26'}`;
        const reserveNumber = reserve(due).replace(`'${id}',1,`, `'${id}',${number},`).replace('stable-payment-key', `stable-${number}`);
        const rid = sql(reserveNumber).trim();
        sql(`SELECT id FROM attach_gocardless_dynamic_payment('${tenant}','${rid}',
          '{"id":"PM_${number}","amount":1200,"currency":"GBP","charge_date":"${due}","status":"confirmed","links":{"mandate":"MD1"}}');`);
      }
      const dates = sql(`SELECT collection_number||':'||due_date FROM gocardless_collection_reservations ORDER BY collection_number`);
      assert.match(dates, /1:2090-01-24/);
      assert.match(dates, /2:2090-02-28/);
      assert.match(dates, /3:2090-03-26/);
      // Corrupt financial evidence must still prevent settlement.
      sql(`UPDATE gocardless_payments SET amount_minor=999 WHERE gocardless_payment_id='PM_12'`);
      assert.match(sql(`SELECT complete_gocardless_dynamic_term('${tenant}','${id}')->>'completed'`), /false/);
      sql(`UPDATE gocardless_payments SET amount_minor=1200 WHERE gocardless_payment_id='PM_12'`);
      sql(`UPDATE gocardless_collection_reservations SET due_date='2090-01-25' WHERE collection_number=1`);
      assert.match(sql(`SELECT complete_gocardless_dynamic_term('${tenant}','${id}')->>'completed'`), /false/);
      sql(`UPDATE gocardless_collection_reservations SET due_date='2090-01-24' WHERE collection_number=1`);
      const savedVersion = sql(`SELECT metadata->>'collection_schedule_version' FROM membership_payment_plans`).trim();
      sql(`UPDATE membership_payment_plans SET metadata=jsonb_set(metadata,'{collection_schedule_version}','999')`);
      assert.match(fails(`SELECT complete_gocardless_dynamic_term('${tenant}','${id}')`), /schedule evidence is incomplete/);
      sql(`UPDATE membership_payment_plans SET metadata=jsonb_set(metadata,'{collection_schedule_version}','${savedVersion}')`);
      assert.match(sql(`SELECT complete_gocardless_dynamic_term('${tenant}','${id}')->>'completed'`), /true/);
      assert.equal(sql('SELECT required_collections FROM gocardless_dynamic_term_completions').trim(), '12');
      assert.equal(sql('SELECT jsonb_array_length(payment_evidence) FROM gocardless_dynamic_term_completions').trim(), '12');
      assert.equal(sql('SELECT payment_status||\':\'||final_cost FROM member_membership_history').trim(), 'paid:144');
      assert.equal(sql('SELECT status FROM membership_payment_plans').trim(), 'expired');
      assert.equal(sql(`SELECT collection_number||':'||due_date FROM gocardless_collection_reservations ORDER BY collection_number`), dates);
      assert.match(fails(`UPDATE gocardless_collection_day_amendments SET proposed_anchor='2090-01-01' WHERE applied_at IS NOT NULL`), /immutable/);
    }
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await harness.cleanup();
  }
});