import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { APPROVED_ASSIGNMENT as a, assignApprovedPolicy } from '../../scripts/assign-bnms-expiry-only-renewal-policy.mjs';

// Disposable local Unix-socket cluster only. Never reads a connection env var.
test('expiry policy migration and exact assignment: isolated grants, bindings, immutability and idempotency', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'expiry-policy-pg-'));
  const cluster = join(directory, 'data');
  let running = false, db;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'),
      '-o', `-k ${directory} -p 55489 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    db = new pg.Client({ host: directory, port: 55489, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.tenant(id uuid PRIMARY KEY);
      CREATE TABLE public.member(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE public.membership_tier_config(
        id uuid PRIMARY KEY,tenant_id uuid,name text,start_mode text,structure_scope_type text,
        billing_period text,is_active boolean,effective_from date,effective_to date,updated_at timestamptz,
        renewal_open_days integer,renewal_grace_days integer,renewal_disable_login boolean,
        renewal_change_role boolean,renewal_fallback_role_id uuid);
      CREATE TABLE public.member_membership_history(
        id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,config_id uuid,
        membership_year text,status text,payment_status text,payment_method text,billing_period text,currency text,
        tier_label text,term_start_date date,term_end_date date,membership_renewal_date date,
        term_key text,term_duration_months integer,term_anchor_date date,previous_term_id uuid,
        commitment_snapshot jsonb,billing_agreement_id uuid,expiry_enforced_at timestamptz,
        final_cost numeric,total_with_vat numeric,notes text,annual_renewal_state text);
      GRANT SELECT ON public.member,public.member_membership_history,public.membership_tier_config TO service_role;
      GRANT UPDATE ON public.member_membership_history,public.membership_tier_config TO service_role;
    `);
    await db.query('INSERT INTO tenant VALUES ($1)', [a.tenant_id]);
    await db.query('INSERT INTO member VALUES ($1,$2)', [a.member_id, a.tenant_id]);
    await db.query(`INSERT INTO membership_tier_config VALUES
      ($1,$2,$3,'immediate','member','annual',true,'2026-09-01',null,
       '2026-09-21T11:05:39.732Z',90,90,true,false,null)`,
    [a.config_id, a.tenant_id, a.config_name]);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,membership_year,status,payment_status,payment_method,billing_period,currency,
       tier_label,term_end_date,notes)
      VALUES ($1,$2,$3,'2025/2026','active','paid','upfront','annual','GBP','Full Membership UK',
       '2026-09-25','{"source":"bnms_non_dd_current_backfill"}')`, [a.history_id, a.tenant_id, a.member_id]);
    const before = (await db.query('SELECT to_jsonb(h) AS history FROM member_membership_history h')).rows[0].history;
    await db.query(await readFile(new URL('../../supabase/migrations/20261128_membership_expiry_policy_assignment.sql', import.meta.url), 'utf8'));

    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM membership_expiry_policy_assignment'), /permission denied/);
      await assert.rejects(db.query('INSERT INTO membership_expiry_policy_assignment DEFAULT VALUES'), /permission denied/);
      await db.query('RESET ROLE');
    }
    const columns = Object.keys(a);
    const insert = `INSERT INTO membership_expiry_policy_assignment(${columns.join(',')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`;
    const values = row => columns.map(key => key === 'policy_snapshot' ? JSON.stringify(row[key]) : row[key]);
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query(insert, values({ ...a, expiry_date: '2026-09-26' })), /binding is invalid/);
    await assert.rejects(db.query(insert, values({ ...a, member_id: '00000000-0000-4000-8000-000000000001' })), /binding is invalid/);
    await assert.rejects(db.query(insert, values({ ...a, tenant_id: '00000000-0000-4000-8000-000000000001' })), /binding is invalid/);
    await assert.rejects(db.query(insert, values({ ...a, policy_snapshot: { ...a.policy_snapshot, renewal_grace_days: 91 } })), /invalid|check constraint/);
    await db.query('RESET ROLE');
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE service_role');
    assert.equal((await db.query(insert, values(a))).rowCount, 1, 'service role can insert approved bound authority');
    await db.query('ROLLBACK');

    await db.query("UPDATE membership_tier_config SET renewal_grace_days=89");
    await assert.rejects(assignApprovedPolicy(db), /configuration version\/policy/);
    assert.equal((await db.query('SELECT count(*)::int count FROM membership_expiry_policy_assignment')).rows[0].count, 0);
    await db.query("UPDATE membership_tier_config SET renewal_grace_days=90");
    const first = await assignApprovedPolicy(db);
    assert.equal(first.applied, true);
    assert.equal((await assignApprovedPolicy(db)).idempotent, true);
    const after = (await db.query('SELECT to_jsonb(h) AS history FROM member_membership_history h')).rows[0].history;
    assert.deepEqual(after, before, 'assignment must not change any historical column');
    assert.equal((await db.query('SELECT count(*)::int count FROM membership_expiry_policy_assignment')).rows[0].count, 1);

    await db.query('SET ROLE service_role');
    assert.equal((await db.query('SELECT * FROM membership_expiry_policy_assignment')).rowCount, 1);
    await assert.rejects(db.query("UPDATE membership_expiry_policy_assignment SET config_name='forged'"), /permission denied/);
    await assert.rejects(db.query('DELETE FROM membership_expiry_policy_assignment'), /permission denied/);
    await db.query('RESET ROLE');
    await assert.rejects(db.query("UPDATE membership_expiry_policy_assignment SET config_name='forged'"), /immutable/);
    await assert.rejects(db.query('DELETE FROM membership_expiry_policy_assignment'), /immutable/);
    await db.query("UPDATE member_membership_history SET term_end_date='2026-09-26'");
    await assert.rejects(assignApprovedPolicy(db), /historical invariants changed/);
  } finally {
    await db?.end();
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(directory, { recursive: true, force: true });
  }
});