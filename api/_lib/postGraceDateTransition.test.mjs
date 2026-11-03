import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostGraceDateTransition } from './postGraceDateTransition.js';

test('early bank settlement updates plan-creation service dates but not the purchase label', () => {
  const input = fixture();
  Object.assign(input.agreement.metadata.dd, {
    membership_year: 'rolling:2026-11-01',
    membership_year_start: '2026-11-01', membership_year_end: '2027-10-31',
    membership_renewal_date: '2027-11-01',
  });
  const result = buildPostGraceDateTransition(input);
  const dd = result.after.agreement.metadata.dd;
  assert.equal(dd.membership_year, 'rolling:2026-11-01');
  assert.equal(dd.membership_year_start, result.dates.term_start_date);
  assert.equal(dd.membership_year_end, result.dates.term_end_date);
  assert.equal(dd.membership_renewal_date, result.dates.membership_renewal_date);
});

function fixture(method = 'direct_debit') {
  const monthly = method !== 'upfront';
  const dates = { term_start_date: '2026-11-01', term_end_date: '2027-10-31',
    membership_renewal_date: '2027-11-01', term_duration_months: 12,
    term_anchor_date: '2026-11-01', term_key: 'rolling:2026-11-01', previous_term_id: 'prior' };
  const snapshot = { amounts: { final_cost: 156, total_with_vat: 156, vat_amount: 0,
    monthly_amount: 13, currency: 'GBP' }, config: { name: 'Purchased schedule' },
  accepted_at: '2026-11-01T10:00:00Z', payment_frequency: monthly ? 'monthly' : 'upfront' };
  const scope = { tenant_id: 'tenant', member_id: 'member', organization_id: null,
    membership_successor_election_id: 'election' };
  const provider = method === 'direct_debit' ? 'gocardless' : 'stripe';
  return {
    reservation: { id: 'reservation', tenantId: 'tenant', memberId: 'member',
      electionId: 'election', previousTermId: 'prior', historyId: 'history',
      commencementBasis: 'confirmed_payment', createdAt: '2026-11-01T10:00:00Z',
      graceEndDate: '2026-10-21', paymentMethod: method, firstPaymentMinor: 1300, currency: 'GBP' },
    evidence: { id: 'payment', tenantId: 'tenant', memberId: 'member', reservationId: 'reservation',
      provider, status: provider === 'stripe' ? 'succeeded' : 'confirmed',
      paidAt: '2026-11-07T12:00:00Z', amountMinor: 1300, currency: 'GBP' },
    history: { ...scope, ...dates, id: 'history', membership_year: 'rolling:2026-11-01',
      billing_agreement_id: monthly ? 'agreement' : null,
      status: 'pending', payment_status: 'unpaid', commitment_snapshot: snapshot,
      total_with_vat: 156, voucher_allocation: { amount: 10, owner: 'member' } },
    agreement: monthly ? { ...scope, ...dates, id: 'agreement', provider,
      status: 'first_payment_pending', commitment_snapshot: structuredClone(snapshot),
      metadata: { dd: { commitment: { ...dates, commitment_snapshot: structuredClone(snapshot) },
        accepted_at: snapshot.accepted_at, membership_year_start: dates.term_start_date },
      consent: { original_dates: dates } } } : null,
    plan: monthly ? { ...scope, id: 'plan', billing_agreement_id: 'agreement',
      amount_minor: 1300, membership_year: 'rolling:2026-11-01',
      start_date: dates.term_start_date, next_charge_date: '2026-12-01',
      status: 'first_payment_pending', metadata: { consent: { dates } } } : null,
    now: '2026-11-09T00:00:00Z',
  };
}

for (const method of ['upfront', 'monthly_card', 'direct_debit']) {
  test(`${method}: one date transition preserves every purchased economic field`, () => {
    const input = fixture(method);
    const original = structuredClone(input);
    const result = buildPostGraceDateTransition(input);
    assert.deepEqual(input, original);
    assert.deepEqual(result.before.history, original.history);
    assert.equal(result.after.history.term_start_date, '2026-11-07');
    assert.equal(result.after.history.term_end_date, '2027-11-06');
    assert.equal(result.after.history.membership_year, original.history.membership_year);
    assert.deepEqual(result.after.history.commitment_snapshot, original.history.commitment_snapshot);
    assert.deepEqual(result.after.history.voucher_allocation, original.history.voucher_allocation);
    assert.equal(result.after.history.payment_status, 'unpaid');
    assert.equal(result.after.history.status, 'pending');
    assert.equal(result.releaseCollectionHold, false);
    if (input.plan) {
      assert.equal(result.after.plan.start_date, '2026-11-07');
      assert.equal(result.after.plan.next_charge_date, original.plan.next_charge_date);
      assert.equal(result.after.plan.membership_year, original.plan.membership_year);
      assert.equal(result.after.plan.amount_minor, 1300);
      assert.deepEqual(result.after.agreement.metadata.consent, original.agreement.metadata.consent);
      assert.deepEqual(result.after.agreement.metadata.dd.commitment.commitment_snapshot,
        original.agreement.commitment_snapshot);
      assert.equal(result.after.agreement.metadata.dd.commitment.term_start_date, '2026-11-07');
      assert.equal(result.after.agreement.metadata.dd.accepted_at, original.agreement.metadata.dd.accepted_at);
    }
  });
}
test('non-adjacent restart keeps predecessor in the election, not a fabricated adjacent term', () => {
  const input = fixture();
  input.history.previous_term_id = null;
  input.agreement.previous_term_id = null;
  const result = buildPostGraceDateTransition(input);
  assert.equal(result.dates.previous_term_id, null);
  assert.equal(result.after.history.previous_term_id, null);
  assert.equal(input.reservation.previousTermId, 'prior');
});
test('confirmed DD can precede plan creation without activating the membership', () => {
  const input = fixture();
  input.plan = null;
  input.agreement.status = 'active';
  const result = buildPostGraceDateTransition(input);
  assert.equal(result.after.plan, null);
  assert.equal(result.after.history.status, input.history.status);
  assert.equal(result.after.history.payment_status, input.history.payment_status);
  assert.equal(result.after.agreement.term_start_date, '2026-11-07');
  assert.equal(result.releaseCollectionHold, false);
});

for (const [name, mutate] of [
  ['repriced agreement', x => { x.agreement.commitment_snapshot.amounts.final_cost = 999; }],
  ['inconsistent provisional dates', x => { x.agreement.term_start_date = '2026-10-31'; }],
  ['missing snapshot', x => { delete x.history.commitment_snapshot; }],
  ['plan belongs to another member', x => { x.plan.member_id = 'other'; }],
  ['organisation plan', x => { x.plan.organization_id = 'organisation'; }],
  ['cancelled agreement', x => { x.agreement.status = 'cancelled'; }],
  ['partially settled history', x => { x.history.payment_status = 'partial'; }],
  ['unknown settlement status', x => { x.history.payment_status = null; }],
  ['wrong payment amount', x => { x.evidence.amountMinor = 1; }],
]) test(`rejects ${name}`, () => {
  const input = fixture(); mutate(input);
  assert.throws(() => buildPostGraceDateTransition(input));
});
