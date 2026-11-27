import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countSuccessfulCollections, resolvePaidCoverage, consentInstalmentCount, wholeMonthsBetween,
  createMemberDdCancellationEvidence,
} from './memberDdCancellationEvidence.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = id(1); const M = id(2);

// Small in-memory PostgREST-like reader: only the filters the evidence uses.
export function memoryDb(tables) {
  return {
    from(table) {
      const filters = []; let range = null; let limit = null;
      const rows = () => (tables[table] || []).filter(row => filters.every(f => f(row)));
      const q = {
        select() { return q; },
        eq(k, v) { filters.push(r => (k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] : r[k]) === v); return q; },
        neq(k, v) { filters.push(r => r[k] !== v); return q; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
        in(k, v) { filters.push(r => v.includes(r[k])); return q; },
        lte(k, v) { filters.push(r => r[k] <= v); return q; },
        gt(k, v) { filters.push(r => r[k] > v); return q; },
        order() { return q; },
        limit(n) { limit = n; return q; },
        range(a, b) { range = [a, b]; return q; },
        async maybeSingle() { return { data: rows()[0] || null, error: null }; },
        then(resolve, reject) {
          if (tables[table] === undefined) return Promise.resolve({ data: null, error: { code: '42P01', message: 'missing' } }).then(resolve, reject);
          let data = rows();
          if (range) data = data.slice(range[0], range[1] + 1);
          if (limit != null) data = data.slice(0, limit);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const TODAY = '2026-11-27';
export function ddFixture({ paid = 12, inFlight = 0, renewal = false, refunded = 0, instalments = 12, gap = false,
  cancelledPredecessor = false, roleAdmin = false, role = true } = {}) {
  const histories = []; const agreements = []; const plans = []; const payments = [];
  const add = (n, start, end, count, renewalOf) => {
    agreements.push({ id: id(100 + n), tenant_id: T, member_id: M, organization_id: null, agreement_type: 'member',
      provider: 'gocardless', environment: 'live', status: 'active',
      metadata: { dd: { instalment_count: instalments, kind: 'monthly_direct_debit', ...(renewalOf ? { renewal_of_agreement_id: renewalOf } : {}) } } });
    plans.push({ id: id(200 + n), tenant_id: T, member_id: M, organization_id: null, billing_agreement_id: id(100 + n),
      provider: 'gocardless', environment: 'live', interval_unit: 'monthly', gocardless_subscription_id: `SB${n}`,
      // A renewed predecessor's fixed subscription finished after its last instalment.
      ...(renewal && n === 0 ? { status: 'expired', completed_at: '2026-02-15T00:00:00Z' } : { status: 'active' }) });
    histories.push({ id: id(300 + n), tenant_id: T, member_id: M, status: n === 0 && renewal ? (cancelledPredecessor ? 'cancelled_by_request' : 'expired') : 'active',
      term_start_date: start, membership_renewal_date: end, billing_agreement_id: id(100 + n), payment_method: 'direct_debit',
      membership_source: 'personal', config_id: id(9) });
    for (let i = 0; i < count; i++) {
      payments.push({ id: payments.length, gocardless_payment_id: `PM${n}-${i}`, plan_id: id(200 + n), tenant_id: T, status: 'confirmed',
        refund_status: i < (n === (renewal ? 1 : 0) ? refunded : 0) ? 'refunded' : null });
    }
  };
  if (renewal) {
    add(0, '2025-03-01', gap ? '2026-02-01' : '2026-03-01', 12, null);
    add(1, '2026-03-01', '2027-03-01', paid, id(100));
  } else add(0, '2026-03-01', '2027-03-01', paid, null);
  const live = plans.at(-1).id;
  for (let i = 0; i < inFlight; i++) payments.push({ gocardless_payment_id: `PF${i}`, plan_id: live, tenant_id: T, status: 'submitted' });
  return {
    member: [{ id: M, tenant_id: T, role_id: id(7), membership_cancelled: false, membership_paused: false }],
    member_membership_history: histories, membership_billing_agreements: agreements, membership_payment_plans: plans,
    gocardless_payments: payments, membership_monthly_arrears_period: [], member_change_authority: [],
    member_membership_amendment: [], member_cancellation_request: [], membership_dd_renewals: [],
    membership_tier_config: [{ id: id(9), tenant_id: T, dd_arrears_fallback_role_id: role ? id(8) : null }],
    role: [{ id: id(8), tenant_id: T, name: 'Supporter', is_tenant_admin: roleAdmin }],
  };
}
const evaluate = (tables, today = TODAY) => createMemberDdCancellationEvidence({
  db: memoryDb(tables), now: () => new Date(`${today}T10:00:00Z`),
}).evaluate({ tenantId: T, memberId: M });

test('successful collections are distinct, and refunds, retries and in-flight never count', () => {
  const result = countSuccessfulCollections([
    { gocardless_payment_id: 'A', plan_id: 'p', status: 'submitted' },
    { gocardless_payment_id: 'A', plan_id: 'p', status: 'confirmed' },
    { gocardless_payment_id: 'B', plan_id: 'p', status: 'paid_out' },
    { gocardless_payment_id: 'C', plan_id: 'p', status: 'confirmed', refund_status: 'refunded' },
    { gocardless_payment_id: 'D', plan_id: 'p', status: 'charged_back' },
    { gocardless_payment_id: 'E', plan_id: 'p', status: 'failed' },
    { gocardless_payment_id: 'F', plan_id: 'p', status: 'pending_submission' },
  ]);
  assert.equal(result.successful, 2);
  assert.equal(result.inFlight, 1);
});

test('paid coverage follows purchased terms, never last payment plus a month', () => {
  assert.equal(wholeMonthsBetween('2026-03-01', '2027-03-01'), 12);
  assert.equal(wholeMonthsBetween('2026-01-31', '2027-01-31'), null);
  // Fully funded term covers the whole term.
  assert.deepEqual(resolvePaidCoverage({ termStart: '2026-03-01', renewalDate: '2027-03-01', instalmentCount: 12, paidThisTerm: 12, today: TODAY }),
    { effectiveDate: '2027-03-01', paidThroughDate: '2027-02-28' });
  // Nine settled instalments fund nine months exactly.
  assert.deepEqual(resolvePaidCoverage({ termStart: '2026-03-01', renewalDate: '2027-03-01', instalmentCount: 12, paidThisTerm: 9, today: TODAY }),
    { effectiveDate: '2026-12-01', paidThroughDate: '2026-11-30' });
  // Coverage already elapsed or an inexact allocation fails closed.
  assert.equal(resolvePaidCoverage({ termStart: '2026-03-01', renewalDate: '2027-03-01', instalmentCount: 12, paidThisTerm: 8, today: TODAY }).blocker, 'no_paid_coverage');
  assert.equal(resolvePaidCoverage({ termStart: '2026-03-01', renewalDate: '2027-03-01', instalmentCount: 10, paidThisTerm: 5, today: TODAY }).blocker, 'coverage_unverified');
});

test('consent instalment count must be evidenced and internally consistent', () => {
  assert.equal(consentInstalmentCount({ metadata: { dd: { instalment_count: 12 } } }), 12);
  assert.equal(consentInstalmentCount({ metadata: { dd: { instalment_count: 12, billing_request_payment: { included: true, remaining_instalments: 11 } } } }), 12);
  assert.equal(consentInstalmentCount({ metadata: { dd: { instalment_count: 12, billing_request_payment: { included: true, remaining_instalments: 10 } } } }), null);
  assert.equal(consentInstalmentCount({ metadata: {} }), null);
});

test('below, exactly and above the agreed threshold', async () => {
  assert.equal((await evaluate(ddFixture({ paid: 11 }))).blocker, 'below_threshold');
  const exact = await evaluate(ddFixture({ paid: 12 }));
  assert.equal(exact.eligible, true);
  assert.equal(exact.evidence.successfulCollections, 12);
  assert.equal(exact.evidence.effectiveDate, '2027-03-01');
  assert.equal(exact.evidence.fallbackRole.name, 'Supporter');
});

test('renewals do not reset the count; a gap or genuine cancellation starts again', async () => {
  const renewed = await evaluate(ddFixture({ renewal: true, paid: 9 }));
  assert.equal(renewed.eligible, true);
  assert.equal(renewed.evidence.successfulCollections, 21);
  assert.equal(renewed.evidence.sequenceLength, 2);
  // Paid-through uses this term's settled instalments: nine months from 1 March.
  assert.equal(renewed.evidence.paidThroughDate, '2026-11-30');
  assert.equal((await evaluate(ddFixture({ renewal: true, paid: 9, gap: true }))).blocker, 'below_threshold');
  assert.equal((await evaluate(ddFixture({ renewal: true, paid: 9, cancelledPredecessor: true }))).blocker, 'below_threshold');
});

test('refunded receipts cannot falsely satisfy the threshold', async () => {
  assert.equal((await evaluate(ddFixture({ paid: 12, refunded: 1 }))).blocker, 'below_threshold');
});

test('missing evidence, other arrangements and invalid roles fail closed', async () => {
  const noCount = ddFixture(); noCount.membership_billing_agreements[0].metadata.dd.instalment_count = undefined;
  assert.equal((await evaluate(noCount)).blocker, 'threshold_unverified');
  assert.equal((await evaluate(ddFixture({ role: false }))).blocker, 'fallback_role_missing');
  assert.equal((await evaluate(ddFixture({ roleAdmin: true }))).blocker, 'fallback_role_invalid');
  const org = ddFixture(); org.member_membership_history[0].organization_id = id(50);
  assert.equal((await evaluate(org)).blocker, 'organisation_funded');
  const card = ddFixture(); card.membership_billing_agreements[0].provider = 'stripe';
  assert.equal((await evaluate(card)).blocker, 'not_direct_debit');
  const upfront = ddFixture(); upfront.member_membership_history[0].payment_method = 'card';
  assert.equal((await evaluate(upfront)).blocker, 'not_direct_debit');
  const fenced = ddFixture(); fenced.membership_payment_plans[0].collection_stopped_at = '2026-11-01T00:00:00Z';
  assert.equal((await evaluate(fenced)).blocker, 'collections_stopped');
  const arrears = ddFixture(); arrears.membership_monthly_arrears_period = [{ id: 'x', tenant_id: T, plan_id: id(200), settled_at: null }];
  assert.equal((await evaluate(arrears)).blocker, 'outstanding_payments');
  // One provider payment claimed by two plans is contradictory evidence.
  const contradictory = ddFixture({ renewal: true, paid: 9 });
  contradictory.gocardless_payments.push({ ...contradictory.gocardless_payments[0], plan_id: id(201) });
  assert.equal((await evaluate(contradictory)).blocker, 'lineage_unverified');
  const competing = ddFixture();
  competing.membership_billing_agreements.push({ id: id(150), tenant_id: T, member_id: M, agreement_type: 'member', status: 'mandate_pending' });
  assert.equal((await evaluate(competing)).blocker, 'other_purchase');
  const broken = ddFixture(); delete broken.member_membership_history;
  assert.equal((await evaluate(broken)).blocker, 'evidence_unavailable');
});

test('a fully collected term whose subscription finished stays eligible; a still-collecting predecessor does not', async () => {
  const done = ddFixture({ paid: 12 });
  Object.assign(done.membership_payment_plans[0], { status: 'expired', completed_at: '2027-02-01T00:00:00Z' });
  const result = await evaluate(done);
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.planCompleted, true);
  const attention = ddFixture({ paid: 12 });
  Object.assign(attention.membership_payment_plans[0], { status: 'expired', completed_at: '2027-02-01T00:00:00Z', needs_attention: true });
  assert.equal((await evaluate(attention)).blocker, 'outstanding_payments');
  const stopped = ddFixture({ paid: 12 });
  stopped.membership_payment_plans[0].status = 'cancelled';
  assert.equal((await evaluate(stopped)).blocker, 'outstanding_payments');
  // Renewal predecessors keep their agreement status but are part of the lineage.
  const renewed = await evaluate(ddFixture({ renewal: true, paid: 9 }));
  assert.deepEqual(renewed.evidence.lineageAgreementIds, [id(101), id(100)]);
  const collecting = ddFixture({ renewal: true, paid: 9 });
  Object.assign(collecting.membership_payment_plans[0], { status: 'active', completed_at: null });
  assert.equal((await evaluate(collecting)).blocker, 'other_purchase');
});
