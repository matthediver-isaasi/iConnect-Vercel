import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseApproval, prepare, applyPlan, REPORT } from './apply-bnms-approved-renewal-policies.mjs';
import { POLICY, TENANT } from './repair-bnms-reviewed-expiry-policies.mjs';

// Called only by the disposable Unix-socket PostgreSQL suite.
export async function verifyApprovedBatch(db) {
  await db.query(`
    CREATE TABLE organisation_membership_history(id uuid);
    CREATE TABLE membership_billing_agreements(id uuid);
    CREATE TABLE membership_successor_election(id uuid);
    CREATE TABLE membership_successor_payment_attempt(id uuid);
    CREATE TABLE membership_successor_rollout(id uuid,enabled boolean);
    CREATE TABLE membership_successor_tenant_rollout(tenant_id uuid,enabled boolean);
    CREATE FUNCTION membership_successor_elections_enabled() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION membership_successor_elections_enabled(uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT false $$;
    CREATE FUNCTION form_expiry_only_renewal_policy(jsonb,uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION form_expiry_only_renewal_supported() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;
    CREATE FUNCTION reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
      -- IF NOT public.membership_successor_elections_enabled(p_tenant_id) THEN
      -- public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id)
      RETURN; END $$;
    REVOKE ALL ON FUNCTION membership_successor_elections_enabled(uuid),
      form_expiry_only_renewal_policy(jsonb,uuid,uuid),form_expiry_only_renewal_supported(),
      reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION membership_successor_elections_enabled(uuid),
      form_expiry_only_renewal_policy(jsonb,uuid,uuid),form_expiry_only_renewal_supported(),
      reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb) TO service_role;
  `);
  const cohort = parseApproval(await readFile(REPORT, 'utf8'));
  let index = 0;
  for (const a of cohort) {
    const member = `00000000-0000-4000-9000-${String(++index).padStart(12, '0')}`;
    await db.query('INSERT INTO member VALUES ($1,$2)', [member, TENANT]);
    const overseas = a.kind === 'Full Overseas';
    await db.query(`INSERT INTO membership_tier_config
      (id,tenant_id,name,start_mode,structure_scope_type,billing_period,is_active,effective_from,
       renewal_open_days,renewal_grace_days,renewal_disable_login,renewal_change_role)
      VALUES ($1,$2,$3,'immediate','member','annual',true,$4,$5,$5,$6,false)
      ON CONFLICT (id) DO UPDATE SET effective_from=EXCLUDED.effective_from`,
    [a.config.id, TENANT, a.config.name, a.config.start, overseas ? 0 : 90, !overseas]);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,membership_year,status,payment_status,payment_method,billing_period,currency,
       tier_label,term_end_date,notes) VALUES ($1,$2,$3,'2025/2026','active','paid','upfront','annual','GBP',$4,$5,$6)`,
    [a.id, TENANT, member, overseas ? 'Full Membership Overseas' : a.kind, a.expiry,
      JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1, sourceHash: 'a'.repeat(64),
        paymentAuthority: 'operator_attested_upfront_paid_2025_2026', startDateAuthority: 'unknown_not_inferred',
        expiryAuthority: 'retained_legacy_expiry', termAuthority: 'operator_attested_existing_2025_2026' })]);
  }
  let plan = await prepare(db, cohort);
  const count = async () => (await db.query('SELECT count(*)::int n FROM membership_expiry_policy_assignment')).rows[0].n;
  const initialCount = await count();
  const guard = async () => (await db.query("SELECT pg_get_functiondef('guard_membership_expiry_policy_assignment()'::regprocedure) d")).rows[0].d;
  const originalGuard = await guard();
  await db.query("UPDATE member_membership_history SET final_cost=10,total_with_vat=10 WHERE id=$1", [cohort[0].id]);
  await assert.rejects(applyPlan(db, plan, cohort), /drift/);
  await db.query("UPDATE member_membership_history SET final_cost=null,total_with_vat=null WHERE id=$1", [cohort[0].id]);
  await db.query("UPDATE membership_tier_config SET updated_at=now() WHERE id=$1", [cohort[0].config.id]);
  await assert.rejects(applyPlan(db, plan, cohort), /drift/);
  plan = await prepare(db, cohort);
  await db.query("UPDATE member SET tenant_id=null WHERE id=$1", [plan.records[0].history.member_id]);
  await assert.rejects(applyPlan(db, plan, cohort), /not found/);
  await db.query("UPDATE member SET tenant_id=$1 WHERE id=$2", [TENANT, plan.records[0].history.member_id]);
  assert.equal(await count(), initialCount);
  await db.query(`CREATE FUNCTION fail_approved_last() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.history_id='${cohort.at(-1).id}' THEN RAISE EXCEPTION 'injected last insert failure';
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER z_fail_approved_last BEFORE INSERT ON membership_expiry_policy_assignment
    FOR EACH ROW EXECUTE FUNCTION fail_approved_last()`);
  const failPlan = await prepare(db, cohort);
  await assert.rejects(applyPlan(db, failPlan, cohort), /injected last insert failure/);
  assert.equal(await count(), initialCount, 'all preceding inserts roll back');
  assert.equal(await guard(), originalGuard, 'DDL rolls back with assignments');
  await db.query('DROP TRIGGER z_fail_approved_last ON membership_expiry_policy_assignment; DROP FUNCTION fail_approved_last()');
  plan = await prepare(db, cohort);
  assert.equal((await applyPlan(db, plan, cohort, { rollback: true })).inserted, 0);
  assert.equal(await count(), initialCount);
  assert.equal(await guard(), originalGuard);
  assert.equal((await applyPlan(db, plan, cohort)).inserted, 72);
  assert.equal((await applyPlan(db, plan, cohort)).writesPerformed, false);
  assert.equal(await count(), initialCount + 72);
  // An otherwise identical sixth overseas history cannot borrow any exception.
  const a = plan.records.find(r => r.assignment.config_id === '1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce').assignment;
  const outsider = '00000000-0000-4000-8000-000000001234';
  await db.query(`INSERT INTO member_membership_history SELECT
    (jsonb_populate_record(null::member_membership_history,to_jsonb(h)||jsonb_build_object('id',$1::text))).*
    FROM member_membership_history h WHERE id=$2`, [outsider, a.history_id]);
  const keys = Object.keys(a);
  const insert = `INSERT INTO membership_expiry_policy_assignment(${keys.join(',')})
    VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`;
  const values = row => keys.map(k => k === 'policy_snapshot' ? JSON.stringify(POLICY) : row[k]);
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query(insert, values({ ...a, history_id: outsider })), /configuration\/snapshot is invalid/);
  await db.query('RESET ROLE');
}