import test from 'node:test';
import assert from 'node:assert/strict';
import { planPostGraceRecordDates } from './postGraceRenewal.js';

function fixture(method = 'upfront') {
  const monthly = method !== 'upfront';
  return {
    reservation: { id: 'reservation', tenantId: 'tenant', memberId: 'member',
      electionId: 'election', previousTermId: 'old', historyId: 'new',
      commencementBasis: 'confirmed_payment', createdAt: '2026-11-01T10:00:00Z',
      graceEndDate: '2026-10-21', paymentMethod: method, firstPaymentMinor: 7100, currency: 'GBP' },
    evidence: { id: 'payment', tenantId: 'tenant', memberId: 'member', reservationId: 'reservation',
      provider: method === 'direct_debit' ? 'gocardless' : 'stripe',
      status: method === 'direct_debit' ? 'confirmed' : 'succeeded',
      paidAt: '2026-11-07T12:00:00Z', amountMinor: 7100, currency: 'GBP' },
    history: { id: 'new', tenant_id: 'tenant', member_id: 'member',
      membership_successor_election_id: 'election', previous_term_id: 'old',
      status: 'pending', payment_status: 'pending', billing_agreement_id: monthly ? 'agreement' : null },
    agreement: monthly ? { id: 'agreement', tenant_id: 'tenant', member_id: 'member',
      membership_successor_election_id: 'election', status: 'first_payment_pending',
      provider: method === 'direct_debit' ? 'gocardless' : 'stripe' } : null,
    plan: monthly ? { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement' } : null,
    now: new Date('2026-11-09T10:00:00Z'),
  };
}
for (const method of ['upfront', 'monthly_card', 'direct_debit']) {
  test(`${method} dates come from payment, retain predecessor, and leave inputs unchanged`, () => {
    const input = fixture(method), before = structuredClone(input);
    const result = planPostGraceRecordDates(input);
    assert.equal(result.dates.term_start_date, '2026-11-07');
    assert.equal(result.dates.term_end_date, '2027-11-06');
    assert.equal(result.dates.membership_renewal_date, '2027-11-07');
    assert.equal(result.dates.previous_term_id, 'old');
    assert.equal(result.requiresAtomicWrite, true);
    assert.equal(result.requiresProviderScheduleReconciliation, method !== 'upfront');
    assert.deepEqual(input, before);
  });
}
for (const [name, change] of [
  ['different tenant', x => { x.history.tenant_id = 'other'; }],
  ['different member', x => { x.history.member_id = 'other'; }],
  ['different election', x => { x.history.membership_successor_election_id = 'other'; }],
  ['historic record', x => { x.history.id = 'old'; }],
  ['already paid', x => { x.history.payment_status = 'paid'; }],
  ['wrong agreement', x => { x.plan.billing_agreement_id = 'other'; }],
  ['wrong provider', x => { x.agreement.provider = 'stripe'; }],
  ['missing linked plan', x => { x.agreement.payment_plan_id = x.plan.id; x.plan = null; }],
  ['cancelled agreement', x => { x.agreement.status = 'cancelled'; }],
]) test(`rejects ${name} before any date update`, () => {
  const input = fixture('direct_debit'); change(input);
  assert.throws(() => planPostGraceRecordDates(input));
});
