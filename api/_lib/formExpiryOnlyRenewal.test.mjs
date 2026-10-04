import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFormMembershipRenewalEvidence as assess } from './formMembershipRenewalEvidence.js';
import { loadFormMembershipRenewalContext } from './formMembershipRenewalContext.js';
import { createMembershipSimulator } from './membershipSimulationCore.js';
import { snapshotFormMembershipPayment } from './formMembershipPaymentQuote.js';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
function fixture() {
  const history = { id: 'history', tenant_id: tenantId, member_id: 'member',
    membership_year: '2025/2026', status: 'active', payment_status: 'paid',
    payment_method: 'upfront', billing_period: 'annual', currency: 'GBP',
    tier_label: 'Full', term_start_date: null, term_end_date: '2026-09-25',
    final_cost: null, total_with_vat: null,
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1,
      sourceHash: 'a'.repeat(64), paymentAuthority: 'operator_attested_upfront_paid_2025_2026',
      expiryAuthority: 'retained_legacy_expiry', startDateAuthority: 'unknown_not_inferred',
      termAuthority: 'operator_attested_existing_2025_2026' }) };
  const config = { id: 'config', tenant_id: tenantId, name: 'Assigned schedule',
    start_mode: 'immediate', structure_scope_type: 'member', billing_period: 'annual',
    is_active: true, effective_from: '2026-09-01', flat_cost: 120, pricing_model: 'flat', currency: 'GBP' };
  const policy = { assignmentId: 'assignment', configId: config.id, tenantId,
    historyId: history.id, memberId: history.member_id, expiryDate: history.term_end_date,
    policySource: 'operator_assigned_expiry_only', renewalOpenDays: 90, renewalGraceDays: 90 };
  const input = { tenantId, memberId: 'member', histories: [history], agreements: [],
    successorConfig: config, expiryOnlyPolicies: { history: policy }, now: new Date('2026-10-04') };
  const tables = {
    member: [{ id: 'member', tenant_id: tenantId }],
    member_membership_history: input.histories, membership_billing_agreements: input.agreements,
    membership_tier_config: [config], membership_successor_election: [],
    membership_expiry_policy_assignment: [{ id: 'assignment', tenant_id: tenantId,
      history_id: 'history', member_id: 'member', config_id: 'config', config_name: config.name,
      expiry_date: history.term_end_date, approval_source: 'operator',
      policy_snapshot: { renewal_open_days: 90, renewal_grace_days: 90,
        renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null } }],
  };
  const db = {
    rpc: async () => ({ data: true }),
    from(name) {
      let rows = tables[name] || [];
      const q = {
        select() { return q; }, order() { return q; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return q; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return q; },
        or() { return q; }, limit() { return q; },
        single() { return q.maybeSingle(); },
        range(start, end) { return Promise.resolve({ data: structuredClone(rows.slice(start, end + 1)) }); },
        maybeSingle() { return Promise.resolve({ data: structuredClone(rows[0] || null) }); },
        then(resolve) { resolve({ data: structuredClone(rows) }); },
      };
      return q;
    },
  };
  const calls = [];
  const simulator = createMembershipSimulator(db);
  const simulate = async (tenant, member, options) => {
    calls.push(options);
    const context = await simulator.resolveRollingSimulationContext(db,
      { tenantId: tenant, memberId: member, config, options });
    assert.equal(context.expiryOnlyRenewal, true);
    return { success: true, config, membershipYear: context.window, annualCost: 120,
      finalCost: 120, totalWithVat: 120, vatAmount: 0, currency: 'GBP' };
  };
  return { history, config, policy, input, tables, db, calls, simulator,
    options: { tenantId, memberId: 'member', now: input.now, simulate } };
}

test('assigned expiry-only evidence keeps history unknown and quotes a full independent successor', async () => {
  const f = fixture();
  const before = structuredClone(f.history);
  const { renewal, simulation } = await loadFormMembershipRenewalContext(f.db, f.options);
  assert.equal(renewal.state, 'eligible_renewal');
  assert.equal(renewal.currentStart, null);
  assert.equal(renewal.successorStart, '2026-09-26');
  assert.equal(renewal.successorEnd, '2027-09-25');
  assert.equal(renewal.evidenceSource, 'operator_attested_expiry_only');
  assert.equal(simulation.previousTerm, null);
  const quote = snapshotFormMembershipPayment(simulation);
  assert.equal(quote.simResult.commitment.term_start_date, '2026-09-26');
  assert.equal(quote.simResult.commitment.term_anchor_date, '2026-09-26');
  assert.equal(quote.simResult.commitment.commitment_snapshot.amounts.total_with_vat, 120);
  assert.deepEqual(f.history, before);
});

test('expiry policy window has inclusive boundaries and does not move commencement to checkout day', () => {
  const f = fixture();
  for (const [now, state] of [['2026-06-26', 'renewal_not_open'], ['2026-06-27', 'eligible_renewal'],
    ['2026-12-24', 'eligible_renewal'], ['2026-12-25', 'renewal_closed']]) {
    const result = assess({ ...f.input, now });
    assert.equal(result.state, state);
    assert.equal(result.successorStart, '2026-09-26');
  }
});

test('unassigned, forged, out-of-scope or conflicting evidence fails closed', () => {
  for (const mutate of [
    f => { f.input.expiryOnlyPolicies = {}; },
    f => { f.history.notes = '{}'; },
    f => { f.history.payment_status = 'unpaid'; },
    f => { f.history.billing_agreement_id = 'old'; },
    f => { f.policy.expiryDate = '2026-09-26'; },
    f => { f.policy.memberId = 'other'; },
    f => { f.policy.renewalGraceDays = 91; },
    f => { f.config.id = 'unassigned'; },
    f => { f.config.effective_from = '2026-10-01'; },
    f => { f.input.tenantId = 'other'; },
    f => { f.input.organizationId = 'org'; f.input.memberId = null; },
    f => { f.input.histories.push({ ...f.history, id: 'second' }); },
    f => { f.input.histories.push({ ...f.history, id: 'earlier', term_start_date: '2025-01-01', term_end_date: '2025-12-31' }); },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(assess(f.input).eligible, false, String(mutate));
  }
});

test('pending agreements, future paid/unpaid histories and pause retain payment guards', () => {
  const f = fixture();
  f.input.agreements.push({ id: 'old', tenant_id: tenantId, member_id: 'member', status: 'active' });
  assert.equal(assess(f.input).state, 'renewal_pending');
  assert.equal(assess({ ...f.input, paused: true }).state, 'paused');
  f.input.agreements.length = 0;
  for (const payment_status of ['paid', 'unpaid']) {
    f.input.histories[1] = { ...f.history, id: 'future', term_start_date: '2026-09-26',
      term_end_date: '2027-09-25', payment_status };
    assert.equal(assess({ ...f.input, now: '2026-09-01' }).state,
      payment_status === 'paid' ? 'next_term_purchased' : 'renewal_pending');
  }
});

test('context refuses missing migration/assignment and preserves frozen election recovery', async () => {
  const f = fixture();
  f.db.rpc = async name => name === 'form_expiry_only_renewal_supported'
    ? { error: { code: 'PGRST202' } } : { data: true };
  assert.equal((await loadFormMembershipRenewalContext(f.db, f.options)).renewal.reason,
    'expiry_only_reservation_migration_required');
  assert.equal(f.calls.length, 0);
  f.tables.membership_expiry_policy_assignment.length = 0;
  assert.equal((await loadFormMembershipRenewalContext(f.db, f.options)).renewal.eligible, false);
  f.tables.membership_successor_election.push({ id: 'election', tenant_id: tenantId,
    member_id: 'member', previous_term_id: 'history', status: 'reserved',
    term_start_date: '2026-09-26', payment_method: 'upfront', quote: { simulation: { frozen: true } } });
  const recovered = await loadFormMembershipRenewalContext(f.db, f.options);
  assert.equal(recovered.renewal.state, 'renewal_pending');
  assert.deepEqual(recovered.simulation, { frozen: true });
  assert.equal(f.calls.length, 0);
});

test('simulation re-loads authority rather than trusting a supplied predecessor or boundary', async () => {
  for (const mutate of [
    f => { f.tables.membership_expiry_policy_assignment.length = 0; },
    f => { f.history.notes = '{}'; },
    f => { f.input.histories.push({ ...f.history, id: 'other' }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.simulator.resolveRollingSimulationContext(f.db, { tenantId,
      memberId: 'member', config: f.config, options: { source: 'form-renewal',
        expiryOnlyHistoryId: 'history', termStartDate: '2026-09-26', asOfDate: '2026-09-26' } }));
  }
});

test('real member simulator does not treat the expiry-only renewal as a new join or invent tenure', async () => {
  const f = fixture();
  Object.assign(f.config, { free_period_amount: 50, free_period_unit: 'percent',
    rollover_enabled: true, prorata_enabled: true });
  const result = await f.simulator.simulateMembershipForMember(tenantId, 'member', {
    source: 'form-renewal', configId: 'config', expiryOnlyHistoryId: 'history',
    termStartDate: '2026-09-26', asOfDate: '2026-09-26',
  });
  assert.equal(result.success, true, result.error);
  assert.equal(result.finalCost, 120);
  assert.equal(result.isNewMember, false);
  assert.equal(result.yearNumber, null);
  assert.equal(result.freeDiscount, 0);
  assert.equal(snapshotFormMembershipPayment(result).simResult.incentive_snapshot, undefined);
});