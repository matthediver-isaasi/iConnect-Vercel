import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSnapshot, snapshotDb } from './audit-bnms-renewal-readiness.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
function fixture() {
  const history = { id: 'history', tenant_id: tenant, member_id: 'member',
    membership_year: '2025/2026', status: 'active', payment_status: 'paid',
    payment_method: 'upfront', billing_period: 'annual', currency: 'GBP',
    tier_label: 'Full', term_start_date: null, term_end_date: '2026-09-25',
    final_cost: null, total_with_vat: null,
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1,
      sourceHash: 'a'.repeat(64), paymentAuthority: 'operator_attested_upfront_paid_2025_2026',
      expiryAuthority: 'retained_legacy_expiry', startDateAuthority: 'unknown_not_inferred',
      termAuthority: 'operator_attested_existing_2025_2026' }) };
  return {
    member: [{ id: 'member', tenant_id: tenant, membership_paused: false }],
    member_membership_history: [history],
    membership_billing_agreements: [], membership_successor_election: [], membership_payment_quote: [],
    membership_tier_config: [{ id: 'config', tenant_id: tenant, name: 'Schedule',
      is_active: true, structure_scope_type: 'member', billing_period: 'annual',
      effective_from: '2026-09-01', start_mode: 'immediate' }],
    membership_expiry_policy_assignment: [{ id: 'assignment', tenant_id: tenant,
      history_id: 'history', member_id: 'member', config_id: 'config', config_name: 'Schedule',
      expiry_date: history.term_end_date, approval_source: 'operator',
      policy_snapshot: { renewal_open_days: 90, renewal_grace_days: 90,
        renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null } }],
  };
}
const options = { now: '2026-10-04T12:00:00Z', capability: true, rollout: false, sqlPolicies: { history: {} } };

test('audit reaches real admission but stops before pricing; live gate and snapshot remain unchanged', async () => {
  const tables = fixture();
  const before = structuredClone(tables);
  const [r] = await assessSnapshot(tables, options);
  assert.equal(r.assessment.state, 'eligible_renewal');
  assert.equal(r.hypotheticalContext.state, 'admitted_to_pricing_not_run');
  assert.equal(r.liveState.renewalChoicesUnavailable, true);
  assert.equal(r.liveState.eligible, false);
  assert.equal(r.applicationPolicyValid, true);
  assert.equal(r.provenanceValid, true);
  assert.deepEqual(tables, before);
});

for (const [name, mutate, expected] of [
  ['paused', t => { t.member[0].membership_paused = true; }, 'paused'],
  ['invalid provenance', t => { t.member_membership_history[0].notes = '{}'; }, 'review_required'],
  ['second undated history', t => {
    t.member_membership_history.push({ ...t.member_membership_history[0], id: 'other' });
  }, 'review_required'],
  ['overlapping history', t => {
    t.member_membership_history.push({ ...t.member_membership_history[0], id: 'overlap', term_start_date: '2026-01-01' });
  }, 'review_required'],
  ['open billing agreement', t => {
    t.membership_billing_agreements.push({ id: 'agreement', tenant_id: tenant, member_id: 'member', status: 'active' });
  }, 'renewal_pending'],
  ['reserved election', t => {
    t.membership_successor_election.push({ id: 'election', tenant_id: tenant, member_id: 'member',
      previous_term_id: 'history', status: 'reserved' });
  }, 'renewal_pending'],
  ['expired config', t => { t.membership_tier_config[0].effective_to = '2026-09-01'; }, 'review_required'],
]) {
  test(`actual context detects ${name}`, async () => {
    const tables = fixture(); mutate(tables);
    const [r] = await assessSnapshot(tables, options);
    assert.equal(r.hypotheticalContext.state, expected);
    assert.equal(r.liveState.renewalChoicesUnavailable, true);
  });
}
test('audit distinguishes a closed window and missing capability from record readiness', async () => {
  const [closed] = await assessSnapshot(fixture(), { ...options, now: '2026-12-25' });
  assert.equal(closed.hypotheticalContext.state, 'renewal_closed');
  const [missing] = await assessSnapshot(fixture(), { ...options, capability: false });
  assert.equal(missing.hypotheticalContext.reason, 'expiry_only_reservation_migration_required');
});
test('snapshot adapter rejects writes, unapproved RPCs and missing tables', async () => {
  const db = snapshotDb(fixture());
  await assert.rejects(db.rpc('reserve_membership_successor'), /forbidden/);
  assert.throws(() => db.from('missing'), /Unknown/);
  assert.equal(db.from('member').insert, undefined);
  assert.equal(db.from('member').update, undefined);
  assert.equal(db.from('member').delete, undefined);
});