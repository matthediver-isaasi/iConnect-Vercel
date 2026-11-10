import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT } from './lib/bnms-invoice-date-repair.mjs';
import { offlineDatabase } from './lib/renewal-audit-snapshot.mjs';
import { loadFormMembershipRenewalContext } from '../api/_lib/formMembershipRenewalContext.js';
const root = 'generated-artifacts/bnms-invoice-date-repair';
const mode = process.argv[2]; assert(['dry-run','apply','verify'].includes(mode));
const plan = JSON.parse(await fs.readFile(`${root}/plan.json`, 'utf8'));
const baselineSnapshot = JSON.parse(await fs.readFile(`${root}/baseline-snapshot.json`, 'utf8'));
const baseline = baselineSnapshot.tables;
const keys = ['start_mode','structure_scope_type','structure_field_id','structure_match_value','billing_period'];
if (mode === 'apply') assert.equal(JSON.parse(await fs.readFile(`${root}/final-dry-run.json`, 'utf8')).count, 45);
const db = await connectDestination(), results = [];
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if (mode !== 'verify') {
    await db.query(`ALTER TABLE public.bnms_invoice_date_reconstruction_audit ADD COLUMN IF NOT EXISTS corrected_record jsonb`);
    // Keep both versions of the exact repair; extend only schedule discovery metadata.
    const definition = (await db.query("select pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure) def")).rows[0].def;
    if (!definition.includes('bnms_invoice_schedule_identity_v1')) {
      const marker = 'AND a.before_record=to_jsonb(OLD) AND a.after_record=r';
      assert.equal(definition.split(marker).length, 2);
      await db.query(definition.replace(marker, `AND ((a.before_record=to_jsonb(OLD) AND a.after_record=r)
          OR (a.after_record=to_jsonb(OLD) AND a.corrected_record=r)) -- bnms_invoice_schedule_identity_v1`));
    }
  }
  for (const member of plan.plan.filter(p => p.state === 'candidate')) {
    await db.query('select id from member where tenant_id=$1 and id=$2 for update', [TENANT, member.memberId]);
    for (const repair of member.repairs) {
      const audit = (await db.query('select * from bnms_invoice_date_reconstruction_audit where history_id=$1 for update', [repair.historyId])).rows[0];
      assert.equal(audit.plan_hash, plan.digest);
      const current = (await db.query('select to_jsonb(h) row from member_membership_history h where id=$1 for update', [repair.historyId])).rows[0].row;
      const config = (await db.query('select to_jsonb(c) row from membership_tier_config c where id=$1 and tenant_id=$2 for share', [repair.config.id, TENANT])).rows[0].row;
      const policy = { ...audit.after_record.renewal_policy_snapshot };
      for (const key of keys) { assert.deepEqual(config[key], repair.config[key]); policy[key] = config[key]; }
      const corrected = { ...audit.after_record, renewal_policy_snapshot: policy };
      if (audit.corrected_record) {
        assert.deepEqual(audit.corrected_record, corrected);
        assert.deepEqual(current, corrected);
      } else {
        assert.notEqual(mode, 'verify');
        assert.deepEqual(current, audit.after_record);
        await db.query('update bnms_invoice_date_reconstruction_audit set corrected_record=$1 where history_id=$2',
          [JSON.stringify(corrected), repair.historyId]);
        await db.query('update member_membership_history set renewal_policy_snapshot=$1 where id=$2', [JSON.stringify(policy), repair.historyId]);
        assert.deepEqual((await db.query('select to_jsonb(h) row from member_membership_history h where id=$1', [repair.historyId])).rows[0].row, corrected);
      }
    }
    const histories = (await db.query('select to_jsonb(h) row from member_membership_history h where tenant_id=$1 and member_id=$2',
      [TENANT, member.memberId])).rows.map(r => r.row);
    const tables = { ...baseline, member_membership_history: [
      ...baseline.member_membership_history.filter(h => h.member_id !== member.memberId), ...histories ] };
    const stop = new Error('PRICING_BOUNDARY');
    let renewal;
    try {
      renewal = (await loadFormMembershipRenewalContext(offlineDatabase(tables, {
        membership_successor_elections_enabled: { data: tables.membership_successor_tenant_rollout.find(r => r.tenant_id === TENANT)?.enabled === true },
        post_grace_checkout_ready: { data: baselineSnapshot.grants.length === 3 && baselineSnapshot.grants.every(g => g.executable) },
      }), {
        tenantId: TENANT, memberId: member.memberId, now: new Date(), simulate: async () => { throw stop; },
      })).renewal;
    } catch (e) { if(e !== stop) throw e; renewal = { state: 'admitted_to_pricing_not_run' }; }
    assert.notEqual(renewal.state, 'review_required', JSON.stringify(renewal));
    results.push({ memberId: member.memberId, renewal });
  }
  await db.query('SAVEPOINT guard_test');
  let rejected = false;
  try { await db.query(`update member_membership_history set renewal_policy_snapshot=jsonb_set(renewal_policy_snapshot,'{renewal_grace_days}','91')
    where id=$1`, [plan.plan.find(p=>p.state==='candidate').repairs[0].historyId]); }
  catch(e) { rejected = /Purchased renewal policy is immutable/.test(e.message); }
  await db.query('ROLLBACK TO SAVEPOINT guard_test'); assert(rejected);
  assert.equal((await db.query("select has_table_privilege('service_role','bnms_invoice_date_reconstruction_audit','UPDATE') allowed")).rows[0].allowed, false);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  await fs.writeFile(`${root}/final-${mode}.json`, JSON.stringify({ count:results.length, results }, null, 2), {mode:0o600});
  console.log(JSON.stringify({ mode, count:results.length, states:results.reduce((a,r)=>(a[r.renewal.state]=(a[r.renewal.state]||0)+1,a),{}),
    first:results[0], protected:true }));
} catch(e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
