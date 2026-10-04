import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Runs in the successor test's disposable cluster, after all recovery migrations.
export async function verifyExpiryOnlyReservations(a, b) {
  await a.query('RESET ROLE');
  await b.query('RESET ROLE');
  await a.query(`
    CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean,
      structure_scope_type text,billing_period text,effective_from date,effective_to date,
      renewal_open_days integer,renewal_grace_days integer,renewal_disable_login boolean,
      renewal_change_role boolean,renewal_fallback_role_id uuid);
    ALTER TABLE member_membership_history ADD COLUMN membership_year text,
      ADD COLUMN payment_method text,ADD COLUMN billing_period text,ADD COLUMN currency text,
      ADD COLUMN tier_label text,ADD COLUMN config_id uuid,ADD COLUMN membership_renewal_date date,
      ADD COLUMN term_duration_months integer,ADD COLUMN term_anchor_date date,ADD COLUMN previous_term_id uuid,
      ADD COLUMN expiry_enforced_at timestamptz,ADD COLUMN notes text,
      ADD COLUMN final_cost numeric,ADD COLUMN total_with_vat numeric;
  `);
  await a.query(await readFile(new URL('../../supabase/migrations/20261128_membership_expiry_policy_assignment.sql', import.meta.url), 'utf8'));
  await a.query(await readFile(new URL('../../supabase/migrations/20261206_bnms_expiry_only_form_renewal.sql', import.meta.url), 'utf8'));
  // Freeze only the test function's clock: this historical cohort has a fixed
  // approval window, so this test must still be meaningful in later years.
  const definition = (await a.query(`SELECT pg_get_functiondef(
    'reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)'::regprocedure) d`)).rows[0].d;
  await a.query(definition.replaceAll("now() AT TIME ZONE 'UTC'", "'2026-10-04'::timestamp"));
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const member = '10000000-0000-4000-8000-000000000002';
  const history = '10000000-0000-4000-8000-000000000003';
  const config = '10000000-0000-4000-8000-000000000004';
  const notes = JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1, sourceHash: 'a'.repeat(64),
    paymentAuthority: 'operator_attested_upfront_paid_2025_2026', startDateAuthority: 'unknown_not_inferred',
    expiryAuthority: 'retained_legacy_expiry', termAuthority: 'operator_attested_existing_2025_2026' });
  await a.query('INSERT INTO tenant VALUES($1)', [tenant]);
  await a.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [member, tenant]);
  await a.query(`INSERT INTO membership_tier_config VALUES($1,$2,'Assigned',true,'member','annual',
    '2026-09-01',NULL,90,90,true,false,NULL)`, [config, tenant]);
  await a.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,term_end_date,status,payment_status,
    membership_year,payment_method,billing_period,currency,tier_label,notes)
    VALUES($1,$2,$3,'2026-09-25','active','paid','2025/2026','upfront','annual','GBP','Full',$4)`,
  [history, tenant, member, notes]);
  const before = (await a.query('SELECT to_jsonb(h) h FROM member_membership_history h WHERE id=$1', [history])).rows[0].h;
  const reserve = `SELECT reserve_membership_successor($1,$2,NULL,$3,'2026-09-26','2027-09-25',$4,$5,$6) e`;
  const args = [tenant, member, history, 'upfront', 'form', { simulation: { config: { id: config } } }];
  await assert.rejects(a.query(reserve, args), /not enabled/i);
  await a.query('INSERT INTO membership_successor_tenant_rollout(tenant_id,enabled) VALUES($1,true)', [tenant]);
  await assert.rejects(a.query(reserve, args), /assigned renewal authority/);
  await a.query(`INSERT INTO membership_expiry_policy_assignment
    (tenant_id,member_id,history_id,config_id,config_name,expiry_date,policy_snapshot,approval_source,approval_reference)
    VALUES($1,$2,$3,$4,'Assigned','2026-09-25',
    '{"renewal_open_days":90,"renewal_grace_days":90,"renewal_disable_login":true,"renewal_change_role":false,"renewal_fallback_role_id":null}',
    'operator','Disposable fixture approval')`, [tenant, member, history, config]);
  for (const [column, value] of [['notes', '{}'], ['payment_status', 'unpaid']]) {
    await a.query(`UPDATE member_membership_history SET ${column}=$1 WHERE id=$2`, [value, history]);
    await assert.rejects(a.query(reserve, args), /assigned renewal authority/);
    await a.query(`UPDATE member_membership_history SET ${column}=$1 WHERE id=$2`, [before[column], history]);
  }
  await assert.rejects(a.query(reserve, [...args.slice(0, 5), { simulation: { config: { id: member } } }]), /assigned renewal authority/);
  await a.query(`INSERT INTO membership_billing_agreements(tenant_id,member_id,term_start_date,status)
    VALUES($1,$2,'2025-09-26','active')`, [tenant, member]);
  await assert.rejects(a.query(reserve, args), /conflicting obligations/);
  await a.query('DELETE FROM membership_billing_agreements WHERE tenant_id=$1', [tenant]);
  await a.query('SET ROLE service_role');
  await b.query('SET ROLE service_role');
  const raced = await Promise.allSettled([
    a.query(reserve, args),
    b.query(reserve, [...args.slice(0, 3), 'direct_debit', 'form', args[5]]),
    b.query(reserve, [...args.slice(0, 3), 'direct_debit', 'worker', args[5]]),
  ]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
  const elected = raced.find(r => r.status === 'fulfilled').value.rows[0].e;
  assert.equal((await a.query(reserve, [...args.slice(0, 3), elected.payment_method, 'form', args[5]])).rows[0].e.id, elected.id);
  await a.query('RESET ROLE');
  assert.deepEqual((await a.query('SELECT to_jsonb(h) h FROM member_membership_history h WHERE id=$1', [history])).rows[0].h, before);
  for (const role of ['anon', 'authenticated']) {
    await a.query(`SET ROLE ${role}`);
    await assert.rejects(a.query('SELECT form_expiry_only_renewal_supported()'), /permission denied/);
    await assert.rejects(a.query(reserve, args), /permission denied/);
    await a.query('RESET ROLE');
  }
}