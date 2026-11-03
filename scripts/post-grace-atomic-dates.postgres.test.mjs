import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { exerciseFundedDateContract } from './test-support/post-grace-funding-fixture.mjs';

test('post-grace date transaction: ownership, financial preservation, rollback and replay', { timeout: 120000 }, async () => {
  const harness = await createLocalPostgresHarness('post-grace-atomic-');
  let db, started = false;
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    run('initdb', ['-D', harness.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', harness.data, '-l', path.join(harness.root, 'postgres.log'),
      '-o', `-F -k ${harness.socket} -c listen_addresses= -p ${harness.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: harness.socket, port: harness.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,payment_status text,billing_agreement_id uuid,term_start_date date,term_end_date date,
        term_key text,renewal_policy_snapshot jsonb,commitment_snapshot jsonb,incentive_snapshot jsonb,
        status text,previous_term_id uuid,membership_successor_election_id uuid,membership_year text,
        membership_renewal_date date,term_anchor_date date,term_duration_months int,total_with_vat numeric);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,
        structure_scope_type text,billing_period text,is_active boolean,start_mode text DEFAULT 'immediate');
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        organization_id uuid,previous_term_id uuid,payment_method text,status text,origin text,
        term_start_date date,term_end_date date,quote jsonb DEFAULT '{}',switch_state text DEFAULT 'idle');
      ALTER TABLE membership_successor_election ALTER COLUMN status SET DEFAULT 'reserved';
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        quote jsonb,recovered_commitment jsonb,cancelled_for_switch_at timestamptz);
      CREATE TABLE membership_billing_agreements(LIKE member_membership_history INCLUDING ALL,
        provider text,metadata jsonb);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,billing_agreement_id uuid,start_date date,next_charge_date date,
        membership_year text,amount_minor int,metadata jsonb,status text);
    `);
    // Use the actual immutable commitment trigger, not a permissive stand-in.
    // Its normal guard remains in force outside the exact transaction images.
    const rollingSql = readFileSync(new URL('../supabase/migrations/20260920_rolling_membership_commitments.sql', import.meta.url), 'utf8');
    const functions = rollingSql.slice(rollingSql.indexOf('CREATE OR REPLACE FUNCTION rolling_commitment_fields'),
      rollingSql.indexOf("DO $$\nDECLARE t TEXT;\nBEGIN\n  FOREACH t", rollingSql.indexOf('CREATE OR REPLACE FUNCTION enforce_rolling')));
    assert.ok(functions.includes('A purchased membership commitment is immutable'));
    await db.query(functions);
    // Discover the complete post-grace chain in deployment filename order,
    // rather than masking a dependency mistake with a hand-ordered list.
    const migrationFiles = readdirSync(new URL('../supabase/migrations/', import.meta.url))
      .filter(file => /^\d+_post_grace_.*\.sql$/.test(file)).sort();
    assert.ok(migrationFiles.indexOf('20261103_post_grace_renewal_storage.sql')
      < migrationFiles.indexOf('20261104_post_grace_atomic_dates.sql'));
    for (const file of migrationFiles) {
      const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await db.query(sql);
      await db.query(sql);
      if (file === '20261104_post_grace_atomic_dates.sql') {
        // Check the staged gate before the later runtime-access migration,
        // while still executing the complete chain in deployment order.
        await db.query('SET ROLE service_role');
        await assert.rejects(db.query(`SELECT apply_post_grace_record_dates(
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`), /permission denied/);
        await db.query('RESET ROLE');
      }
    }
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const [tenant, member, prior, config, election, reservation, history, agreement, plan] =
      Array.from({ length: 9 }, (_, i) => id(i + 1));
    await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
    await db.query('INSERT INTO member VALUES($1,$2)', [member, tenant]);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,payment_status,term_start_date,term_end_date,renewal_policy_snapshot)
      VALUES($1,$2,$3,'paid',current_date-500,current_date-135,'{"renewal_grace_days":90}')`, [prior, tenant, member]);
    await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,billing_period,is_active)
      VALUES($1,$2,'member','annual',true)`, [config, tenant]);
    await db.query(`INSERT INTO membership_successor_election
      (id,tenant_id,member_id,organization_id,previous_term_id,payment_method,status,origin)
      VALUES($1,$2,$3,NULL,$4,'direct_debit','reserved','form')`,
      [election, tenant, member, prior]);
    await db.query('INSERT INTO membership_post_grace_policy(tenant_id,enabled) VALUES($1,true)', [tenant]);
    await db.query(`INSERT INTO membership_post_grace_renewal
      (id,tenant_id,member_id,previous_term_id,config_id,election_id,payment_method,
        first_payment_minor,currency,grace_end_date,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'direct_debit',1300,'GBP',current_date-45,now()-interval '3 days')`,
    [reservation, tenant, member, prior, config, election]);
    await db.query(`INSERT INTO membership_billing_agreements
      (id,tenant_id,member_id,status,provider,membership_successor_election_id,commitment_snapshot,metadata,previous_term_id)
      VALUES($1,$2,$3,'first_payment_pending','gocardless',$4,'{"price":156}',
        '{"dd":{"commitment":{"commitment_snapshot":{"price":156}},"accepted_at":"2026-01-01"}}',$5)`,
    [agreement, tenant, member, election, prior]);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,status,payment_status,billing_agreement_id,previous_term_id,
        membership_successor_election_id,commitment_snapshot,total_with_vat)
      VALUES($1,$2,$3,'pending','unpaid',$4,$5,$6,'{"price":156}',156)`,
    [history, tenant, member, agreement, prior, election]);
    await db.query(`INSERT INTO membership_payment_plans
      (id,tenant_id,member_id,billing_agreement_id,amount_minor,status,next_charge_date)
      VALUES($1,$2,$3,$4,1300,'first_payment_pending',current_date+30)`, [plan, tenant, member, agreement]);
    const expected = (await db.query(`SELECT jsonb_build_object(
      'history',(SELECT to_jsonb(x) FROM member_membership_history x WHERE id=$1),
      'agreement',(SELECT to_jsonb(x) FROM membership_billing_agreements x WHERE id=$2),
      'plan',(SELECT to_jsonb(x) FROM membership_payment_plans x WHERE id=$3)) AS rows`,
    [history, agreement, plan])).rows[0].rows;
    await db.query(`CREATE TRIGGER rolling_commitment_guard BEFORE UPDATE ON member_membership_history
      FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment();
      CREATE TRIGGER rolling_commitment_guard BEFORE UPDATE ON membership_billing_agreements
      FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment()`);
    const paid = (await db.query("SELECT now()-interval '1 day' AS paid")).rows[0].paid;
    await exerciseFundedDateContract(db, { tenant, member, election, reservation, history, agreement, expected, paid });
    const call = (before = expected, payment = 'PM-test') => db.query(`SELECT apply_post_grace_record_dates(
      $1,$2,$3,'gocardless',$4,'confirmed',$5,1300,'GBP',$6) AS receipt`,
    [tenant, member, reservation, payment, paid, before]);
    // The pre-runtime denial was checked during ordered migration above;
    // the full chain now grants the service role access, asserted below.
    await assert.rejects(call({ ...expected, history: { ...expected.history, total_with_vat: 999 } }), /changed/);
    assert.equal((await db.query('SELECT status FROM membership_post_grace_renewal')).rows[0].status, 'reserved');
    // A last-row failure must roll back earlier agreement/history changes and
    // the payment evidence. Never leave a partly finalized paid year behind.
    await db.query(`CREATE FUNCTION reject_plan() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated plan failure'; END $$;
      CREATE TRIGGER reject_plan BEFORE UPDATE ON membership_payment_plans
      FOR EACH ROW EXECUTE FUNCTION reject_plan()`);
    await assert.rejects(call(), /simulated plan failure/);
    assert.equal((await db.query('SELECT status FROM membership_post_grace_renewal')).rows[0].status, 'reserved');
    assert.equal((await db.query('SELECT count(*)::int n FROM membership_post_grace_date_application')).rows[0].n, 0);
    await db.query('DROP TRIGGER reject_plan ON membership_payment_plans');
    const receipt = (await call()).rows[0].receipt;
    assert.equal(receipt.state, 'applied');
    assert.equal(receipt.after_rows.history.total_with_vat, 156);
    assert.deepEqual(receipt.after_rows.history.commitment_snapshot, expected.history.commitment_snapshot);
    assert.equal(receipt.after_rows.history.payment_status, 'unpaid');
    assert.equal(receipt.after_rows.plan.amount_minor, 1300);
    assert.equal(receipt.after_rows.plan.next_charge_date, expected.plan.next_charge_date);
    assert.equal(receipt.after_rows.agreement.metadata.dd.accepted_at, '2026-01-01');
    assert.deepEqual((await call()).rows[0].receipt, receipt);
    await assert.rejects(db.query('UPDATE member_membership_history SET term_end_date=term_end_date+1 WHERE id=$1',
      [history]), /immutable|disagree/);
    await assert.rejects(call(expected, 'PM-other'), /different settlement evidence/);
    assert.equal((await db.query(`SELECT post_grace_date_write_allowed(
      'member_membership_history',$1,$2) allowed`, [receipt.before_rows.history, receipt.after_rows.history])).rows[0].allowed, false);
    // Browser roles cannot read the original consent images or insert a
    // manifest that could authorize an immutable-date transition.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const result = await db.query(`SELECT
        has_table_privilege($1,'membership_post_grace_date_application','INSERT') AS insert,
        has_table_privilege($1,'membership_post_grace_date_application','UPDATE') AS update,
        has_table_privilege($1,'membership_post_grace_date_application','DELETE') AS delete`, [role]);
      assert.deepEqual(result.rows[0], { insert: false, update: false, delete: false });
    }
    const newMember = id(21), newPrior = id(22);
    await db.query('INSERT INTO member VALUES($1,$2)', [newMember, tenant]);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,payment_status,term_start_date,term_end_date,commitment_snapshot)
      VALUES($1,$2,$3,'paid',current_date-500,current_date-135,'{"config":{"renewal_grace_days":90}}')`,
    [newPrior, tenant, newMember]);
    const dates = (await db.query(`SELECT to_char(current_date,'YYYY-MM-DD') start,
      to_char((current_date+interval '1 year')::date-1,'YYYY-MM-DD') finish`)).rows[0];
    const quote = { payerMemberId: newMember, simulation: {
      totalWithVat: 71, finalCost: 71,
      config: { id: config, pricing_model: 'flat', dd_monthly_amount: 13 },
      formRenewal: { commencementBasis: 'confirmed_payment', predecessorId: newPrior },
      paymentSchedule: { term_start_date: dates.start, term_end_date: dates.finish } } };
    const reserve = (method = 'upfront', owner = newMember) => db.query(`SELECT reserve_post_grace_renewal(
      $1,$2,$3,$4,$5,7100,'GBP',$6) reservation`, [tenant, owner, newPrior, config, method, quote]);
    const reserved = (await reserve()).rows[0].reservation;
    assert.equal(reserved.previous_term_id, newPrior);
    assert.deepEqual((await reserve()).rows[0].reservation, reserved);
    await assert.rejects(reserve('direct_debit'), /already reserved/);
    await assert.rejects(reserve('upfront', member), /Invalid payment-dated/);
    assert.equal((await db.query('SELECT count(*)::int n FROM membership_post_grace_renewal WHERE member_id=$1',
      [newMember])).rows[0].n, 1);
    await db.query("UPDATE membership_successor_election SET payment_method='monthly_card' WHERE id=$1", [reserved.id]);
    const switched = (await db.query('SELECT sync_post_grace_renewal_method($1,$2,$3) result',
      [tenant,newMember,reserved.id])).rows[0].result;
    assert.equal(switched.payment_method, 'monthly_card');
    assert.equal(switched.first_payment_minor, 1300);
    assert.equal(switched.payment_method_changes.length, 1);
    await assert.rejects(db.query(`UPDATE membership_payment_plans SET start_date=start_date+1 WHERE id=$1`,
      [plan]), /finalized post-grace service dates/);
    await assert.rejects(db.query(`INSERT INTO membership_payment_plans
      (id,tenant_id,member_id,billing_agreement_id,start_date)
      VALUES($1,$2,$3,$4,current_date-2)`, [id(23), tenant, member, agreement]),
    /finalized post-grace service dates/);
    await db.query(readFileSync('supabase/migrations/20261106_post_grace_runtime_access.sql', 'utf8'));
    const mirrors = (await db.query(`SELECT post_grace_metadata_dates(
      '{"dd":{"membership_year":"original-purchase","membership_year_start":"2026-01-01"}}',
      '{"term_start_date":"2026-11-03"}') result`)).rows[0].result;
    assert.equal(mirrors.dd.membership_year, 'original-purchase');
    assert.equal(mirrors.dd.membership_year_start, '2026-11-03');
    assert.equal((await db.query('SELECT post_grace_checkout_ready() ready')).rows[0].ready, true);
    for (const role of ['anon','authenticated','service_role']) {
      const access = (await db.query(`SELECT
        has_function_privilege($1,'reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)','EXECUTE') reserve,
        has_function_privilege($1,'apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)','EXECUTE') apply,
        has_function_privilege($1,'sync_post_grace_renewal_method(uuid,uuid,uuid)','EXECUTE') switch`,
      [role])).rows[0];
      assert.deepEqual(access, { reserve: role==='service_role', apply: role==='service_role', switch: role==='service_role' });
    }
  } finally {
    if (db) await db.end();
    if (started) spawnSync('pg_ctl', ['-D', harness.data, '-m', 'immediate', '-w', 'stop']);
    await harness.cleanup();
  }
});
