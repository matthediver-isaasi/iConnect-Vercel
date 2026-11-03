import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePostGraceRenewal, loadPostGraceSimulationAuthority } from './postGraceCheckout.js';

function fixture() {
  const config = { id: 'schedule', tenant_id: 'tenant', name: 'Full member',
    structure_scope_type: 'member', structure_field_id: 'class', structure_match_value: 'Full',
    billing_period: 'annual', renewal_grace_days: 90, start_mode: 'immediate' };
  return {
    tenantId: 'tenant', member: { id: 'member', tenant_id: 'tenant', role_id: 'Former' },
    histories: [{ id: 'prior', tenant_id: 'tenant', member_id: 'member', status: 'expired',
      payment_status: 'paid', term_start_date: '2025-07-23', term_end_date: '2026-07-22',
      term_key: 'rolling:2025-07-23', membership_renewal_date: '2026-07-23',
      commitment_snapshot: { config, payment_frequency: 'upfront' } }],
    agreements: [], elections: [], configs: [config], now: new Date('2026-11-03T12:00:00Z'),
  };
}
function dbFor(f, enabled = true) {
  const tables = { member: [f.member], member_membership_history: f.histories,
    membership_billing_agreements: f.agreements, membership_successor_election: f.elections,
    membership_post_grace_policy: [{ tenant_id: f.tenantId, enabled }] };
  return { from(table) {
    const filters = [];
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      order() { return this; },
      rows() { return (tables[table] || []).filter(row => filters.every(([key, value]) => row[key] === value)); },
      async range(start, end) { return { data: this.rows().slice(start, end + 1), error: null }; },
      async maybeSingle() { return { data: this.rows()[0] || null, error: null }; } };
  } };
}
test('Former member quotes a full payment-dated year using the saved class', async () => {
  const f = fixture(), original = structuredClone(f);
  let options;
  const result = await quotePostGraceRenewal(dbFor(f), { ...f, simulate: async (tenant, member, opts) => {
    assert.equal(tenant, 'tenant'); assert.equal(member, 'member'); options = opts;
    return { success: true, config: f.configs[0],
      membershipYear: { start: new Date('2026-11-03T00:00:00Z'), end: new Date('2027-11-02T00:00:00Z') } };
  } });
  assert.equal(result.renewal.state, 'post_grace_renewal');
  assert.equal(result.renewal.successorStart, '2026-11-03');
  assert.equal(result.renewal.successorEnd, '2027-11-02');
  assert.equal(result.simulation.paymentSchedule.status, 'pending_payment_setup');
  assert.equal(result.simulation.previousTerm, null);
  assert.equal(options.postGracePredecessorId, 'prior');
  assert.deepEqual(options.fieldOverrides, { class: 'Full' });
  assert.deepEqual(f, original);
});
test('disabled rollout never invokes the simulator', async () => {
  const f = fixture();
  const result = await quotePostGraceRenewal(dbFor(f, false), { ...f,
    simulate: () => assert.fail('disabled tenant must not be quoted') });
  assert.equal(result.renewal.eligible, false);
});
test('simulation cannot accidentally return a backdated successor', async () => {
  const f = fixture();
  await assert.rejects(quotePostGraceRenewal(dbFor(f), { ...f,
    simulate: async () => ({ success: true, config: f.configs[0],
      membershipYear: { start: '2026-07-23', end: '2027-07-22' } }) }), /does not match/);
});
test('fixed-cycle terms are not silently relabelled as immediate consent', async () => {
  const f = fixture(); f.configs[0].start_mode = 'fixed_date';
  const result = await quotePostGraceRenewal(dbFor(f), { ...f,
    simulate: () => assert.fail('fixed-cycle restart needs its own contract') });
  assert.equal(result.renewal.eligible, false);
});
test('simulation rechecks server evidence, rejects stale dates and paused membership', async () => {
  const f = fixture();
  const input = { tenantId: f.tenantId, memberId: f.member.id, config: f.configs[0],
    predecessorId: 'prior', start: '2026-11-03', now: f.now };
  assert.equal((await loadPostGraceSimulationAuthority(dbFor(f), input)).eligible, true);
  await assert.rejects(loadPostGraceSimulationAuthority(dbFor(f), { ...input, start: '2026-11-02' }), /current/);
  f.member.membership_paused = true;
  await assert.rejects(loadPostGraceSimulationAuthority(dbFor(f), input), /requires review/);
});
