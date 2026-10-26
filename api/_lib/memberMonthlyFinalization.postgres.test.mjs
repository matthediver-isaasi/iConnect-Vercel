import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('fixed monthly application is atomic with hold release and survives replay', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('monthly-finalization-');
  const clients = []; let started = false;
  const command = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let n = 0; n < 3; n++) {
      const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
    }
    const [admin, a, b] = clients;
    await admin.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        billing_agreement_id uuid,status text,term_start_date date,membership_renewal_date date,
        commitment_snapshot jsonb);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid);
      CREATE TABLE gocardless_collection_reservations(plan_id uuid,status text);
      CREATE TABLE gocardless_payments(plan_id uuid,status text);
      CREATE TABLE gocardless_payment_retry_attempts(plan_id uuid);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text);
      CREATE TABLE membership_tier_band(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid);
      CREATE TABLE member_change_authority(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        source_record_id uuid,actor_kind text,authority jsonb);
      GRANT SELECT,UPDATE ON membership_payment_plans TO service_role;
    `);
    for (const file of ['202612310022_member_amendment_provider_operations.sql',
      '202612310025_member_monthly_finalization.sql']) {
      await admin.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    }
    await admin.query('INSERT INTO tenant VALUES($1)', [id(1)]);
    await admin.query('INSERT INTO member VALUES($1,$2)', [id(2), id(1)]);
    await admin.query('INSERT INTO membership_billing_agreements VALUES($1,$2,$3)', [id(4), id(1), id(2)]);
    await admin.query('INSERT INTO membership_payment_plans VALUES($1,$2,$3,$4)', [id(5), id(1), id(2), id(4)]);
    const source = (await admin.query(`INSERT INTO member_membership_history
      VALUES($1,$2,$3,$4,'active',CURRENT_DATE,CURRENT_DATE+365,'{"payment_frequency":"monthly"}')
      RETURNING to_jsonb(member_membership_history) v`, [id(3), id(1), id(2), id(4)])).rows[0].v;
    const target = (await admin.query(`INSERT INTO membership_tier_config
      VALUES($1,$2,'member') RETURNING to_jsonb(membership_tier_config) v`, [id(6), id(1)])).rows[0].v;
    const authority = {
      action: 'change', sourceSnapshot: source, targetSnapshot: target, targetBandSnapshot: null,
      fundingEvidence: { complete: true },
      calculation: { behaviour: 'retain_term', effectiveDate: source.term_start_date,
        surplusMinor: 0, finance: { blockers: [], available: { netMinor: 0, vatMinor: 0, grossMinor: 0 } },
        blockers: ['provider_schedule_coordination_required'],
        futureObligationMinor: 1000,
        newTerm: { startDate: source.term_start_date, renewalDate: source.membership_renewal_date } },
    };
    await admin.query('INSERT INTO member_change_authority VALUES($1,$2,$3,$4,$5,$6)',
      [id(7), id(1), id(2), id(3), 'admin', authority]);
    const prepared = { input: { changeAuthorityId: id(7), purchase: source,
      agreement: { id: id(4) }, plan: { id: id(5) }, effectiveDate: source.term_start_date },
      mutation: { kind: 'gc_amount' }, quote: { amountMinor: 1000, collectionDates: [source.term_start_date] } };
    const evidence = { status: 'provider_applied', fingerprint: 'a'.repeat(64) };
    await admin.query(`INSERT INTO member_amendment_provider_operation
      (id,tenant_id,member_id,source_record_id,plan_id,actor_id,operation_key,prepared,fingerprint,state,claim_token,evidence)
      VALUES($1,$2,$3,$4,$5,$6,'monthly-test',$7,$8,'provider_applied',$9,$10)`,
    [id(8), id(1), id(2), id(3), id(5), id(9), prepared, 'a'.repeat(64), id(10), evidence]);
    for (const c of [a, b]) await c.query('SET ROLE service_role');
    const finish = c => c.query('SELECT finalize_member_monthly_amendment($1,$2,$3,$4) v',
      [id(1), id(8), id(9), 'Approved retained-term change']);
    await assert.rejects(finish(a), /Durable finalization approval/);
    await a.query('SELECT approve_member_monthly_finalization($1,$2,$3,$4)',
      [id(1), id(8), id(9), 'Approved retained-term change']);
    await assert.rejects(a.query('SELECT approve_member_monthly_finalization($1,$2,$3,$4)',
      [id(1), id(8), id(9), 'Different approval']), /immutable/);
    assert.equal((await a.query('SELECT * FROM pending_member_monthly_finalizations(30)')).rows.length, 1);
    await admin.query("UPDATE member_amendment_provider_operation SET updated_at=now()-interval '2 minutes'");
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query('UPDATE member_amendment_provider_operation SET updated_at=now()');
    await admin.query("UPDATE membership_tier_config SET structure_scope_type='organization'");
    await assert.rejects(finish(a), /authority changed/);
    await admin.query("UPDATE membership_tier_config SET structure_scope_type='member'");
    const bad = structuredClone(authority);
    bad.calculation.futureObligationMinor = 999;
    await admin.query('UPDATE member_change_authority SET authority=$1', [bad]);
    await assert.rejects(finish(a), /differs from provider/);
    bad.calculation.futureObligationMinor = 1000;
    bad.calculation.surplusMinor = 1;
    await admin.query('UPDATE member_change_authority SET authority=$1', [bad]);
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query('UPDATE member_change_authority SET authority=$1', [authority]);
    await assert.rejects(a.query('UPDATE membership_payment_plans SET member_id=member_id'), /collection hold/);
    await admin.query(`CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$;
      CREATE TRIGGER injected BEFORE INSERT ON member_amendment_provider_event
      FOR EACH ROW EXECUTE FUNCTION injected_failure()`);
    await assert.rejects(finish(a), /Injected/);
    assert.equal((await admin.query('SELECT state FROM member_amendment_provider_operation')).rows[0].state, 'provider_applied');
    await assert.rejects(a.query('UPDATE membership_payment_plans SET member_id=member_id'), /collection hold/);
    await admin.query('DROP TRIGGER injected ON member_amendment_provider_event');
    await admin.query("UPDATE member_amendment_provider_operation SET state='uncertain'");
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query("UPDATE member_amendment_provider_operation SET state='provider_applied'");
    const applications = await Promise.all([finish(a), finish(b)]);
    assert.deepEqual(applications[0].rows[0].v, applications[1].rows[0].v);
    assert.equal(applications[0].rows[0].v.targetSnapshot.config.id, id(6));
    await a.query('UPDATE membership_payment_plans SET member_id=member_id');
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_amendment_provider_event')).rows[0].n, 1);
    assert.equal((await a.query('SELECT * FROM pending_member_monthly_finalizations(30)')).rows.length, 0);
    assert.deepEqual((await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h')).rows[0].v, source);
    for (const role of ['anon', 'authenticated']) {
      await b.query(`SET ROLE ${role}`); await assert.rejects(finish(b), { code: '42501' });
    }
  } finally {
    for (const c of clients) await c.end();
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
