import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPostGraceRenewal as assess, paymentDatedRenewalTerm, planPostGraceSettlement } from './postGraceRenewal.js';

function fixture() {
  const config = { id: 'old-config', tenant_id: 'tenant', structure_scope_type: 'member',
    structure_field_id: 'class', structure_match_value: 'Full', billing_period: 'annual', renewal_grace_days: 90 };
  return { tenantId: 'tenant', member: { id: 'member', tenant_id: 'tenant', role_id: 'Former' },
    enabled: true, today: '2026-11-02', agreements: [], elections: [],
    histories: [{ id: 'prior', tenant_id: 'tenant', member_id: 'member', status: 'expired',
      payment_status: 'paid', term_start_date: '2025-07-23', term_end_date: '2026-07-22',
      term_key: 'rolling:2025-07-23', membership_renewal_date: '2026-07-23',
      commitment_snapshot: { config, payment_frequency: 'upfront' } }],
    configs: [{ ...config, id: 'current-config', effective_from: '2026-09-01', name: 'Current Full membership' }] };
}

test('late renewal uses saved class and current schedule, not Former access role', () => {
  const input = fixture(), before = structuredClone(input);
  const result = assess(input);
  assert.equal(result.eligible, true);
  assert.equal(result.configId, 'current-config');
  assert.equal(result.previousClass, 'Full');
  assert.equal(result.term_start_date, '2026-11-02');
  assert.equal(result.term_end_date, '2027-11-01');
  assert.equal(result.commencementBasis, 'confirmed_payment');
  assert.equal(result.provisional, true);
  assert.deepEqual(input, before);
});
test('grace is inclusive and late renewal does not alter within-grace behaviour', () => {
  assert.equal(assess({ ...fixture(), today: '2026-10-21' }).reason, 'still_within_grace');
  assert.equal(assess({ ...fixture(), today: '2026-10-22' }).eligible, true);
  assert.equal(assess({ ...fixture(), enabled: false }).reason, 'post_grace_disabled');
});
test('SQL dates and REST date strings yield identical late-renewal assessment', () => {
  const f = fixture(), expected = assess(f);
  for (const key of ['term_start_date', 'term_end_date', 'membership_renewal_date']) {
    f.histories[0][key] = new Date(`${f.histories[0][key]}T00:00:00Z`);
  }
  f.configs[0].effective_from = new Date('2026-09-01T00:00:00Z');
  assert.deepEqual(assess(f), expected);
});
test('fixed-year predecessor also starts a complete year from payment after grace', () => {
  const f = fixture(); delete f.histories[0].term_key;
  assert.equal(assess({ ...f, today: '2026-10-20' }).eligible, false);
  assert.equal(assess({ ...f, today: '2026-10-21' }).term_end_date, '2027-10-20');
});
for (const [name, modify, reason] of [
  ['paused', f => { f.member.membership_paused = true; }, 'membership_paused_or_cancelled'],
  ['cancelled', f => { f.member.membership_cancelled = true; }, 'membership_paused_or_cancelled'],
  ['cross tenant', f => { f.histories[0].tenant_id = 'other'; }, 'evidence_scope_mismatch'],
  ['cross owner', f => { f.histories[0].member_id = 'other'; }, 'evidence_scope_mismatch'],
  ['unpaid', f => { f.histories[0].payment_status = 'unpaid'; }, 'previous_settlement_requires_review'],
  ['monthly', f => { f.histories[0].billing_agreement_id = 'billing'; }, 'previous_settlement_requires_review'],
  ['unknown start', f => { f.histories[0].term_start_date = null; }, 'incomplete_term_evidence'],
  ['overlap', f => { f.histories.push({ ...f.histories[0], id: 'duplicate' }); }, 'overlapping_terms'],
  ['duplicate schedule', f => { f.configs.push({ ...f.configs[0], id: 'duplicate' }); }, 'current_schedule_ambiguous_or_unavailable'],
  ['no current schedule', f => { f.configs[0].effective_to = '2026-10-31'; }, 'current_schedule_ambiguous_or_unavailable'],
  ['pending agreement', f => { f.agreements.push({ tenant_id: 'tenant', member_id: 'member', status: 'pending' }); }, 'unresolved_billing_agreement'],
  ['pending election', f => { f.elections.push({ tenant_id: 'tenant', member_id: 'member', status: 'reserved' }); }, 'successor_already_reserved'],
]) test(`fails closed: ${name}`, () => { const f = fixture(); modify(f); assert.equal(assess(f).reason, reason); });

function settlement() {
  return {
    reservation: { id: 'reservation', tenantId: 'tenant', memberId: 'member',
      commencementBasis: 'confirmed_payment', createdAt: '2026-11-02T10:00:00Z',
      graceEndDate: '2026-10-21', currency: 'GBP', firstPaymentMinor: 1300, paymentMethod: 'direct_debit' },
    evidence: { provider: 'gocardless', id: 'payment', tenantId: 'tenant', memberId: 'member',
      reservationId: 'reservation', status: 'confirmed', paidAt: '2026-11-07T12:00:00Z', amountMinor: 1300, currency: 'GBP' },
    now: new Date('2026-11-09T10:00:00Z'),
  };
}
test('bank payment starts term on confirmed payment, not setup or webhook receipt', () => {
  const result = planPostGraceSettlement(settlement());
  assert.equal(result.term_start_date, '2026-11-07');
  assert.equal(result.term_end_date, '2027-11-06');
  assert.equal(result.membership_renewal_date, '2027-11-07');
});
test('card payment after midnight starts on its actual successful payment day', () => {
  const f = settlement();
  f.reservation.paymentMethod = 'monthly_card';
  Object.assign(f.evidence, { provider: 'stripe', status: 'succeeded', paidAt: '2026-11-03T00:00:01Z' });
  assert.equal(planPostGraceSettlement(f).term_start_date, '2026-11-03');
});
for (const [name, modify] of [
  ['mandate setup', f => { f.evidence.status = 'active'; }],
  ['failed payment', f => { f.evidence.status = 'failed'; }],
  ['wrong provider status', f => { f.evidence.status = 'succeeded'; }],
  ['other tenant', f => { f.evidence.tenantId = 'other'; }],
  ['other member', f => { f.evidence.memberId = 'other'; }],
  ['other reservation', f => { f.evidence.reservationId = 'other'; }],
  ['wrong payment method', f => { f.reservation.paymentMethod = 'monthly_card'; }],
  ['invalid reservation time', f => { f.reservation.createdAt = 'unknown'; }],
  ['missing payment time', f => { delete f.evidence.paidAt; }],
  ['future payment', f => { f.evidence.paidAt = '2027-01-01'; }],
  ['before reservation', f => { f.evidence.paidAt = '2026-11-01'; }],
  ['different amount', f => { f.evidence.amountMinor = 1299; }],
  ['wrong currency', f => { f.evidence.currency = 'USD'; }],
  ['zero provider payment', f => { f.evidence.amountMinor = f.reservation.firstPaymentMinor = 0; }],
]) test(`settlement rejects ${name}`, () => { const f = settlement(); modify(f); assert.throws(() => planPostGraceSettlement(f)); });
test('paid annual term handles leap-day anniversaries', () => {
  const result = paymentDatedRenewalTerm('2028-02-29');
  assert.equal(result.term_end_date, '2029-02-27');
  assert.equal(result.membership_renewal_date, '2029-02-28');
});
