import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, parseArgs, bookingFingerprint, TARGETS, TENANT, EVENT, ACCOUNT, hash } from './prepare-event-historical-recovery.mjs';
import { validHistoricalRecoveryEvidence } from '../api/_lib/eventInvoiceRecovery.js';

// Synthetic unit-test fixture only; the CLI production path never supplies fallbacks.
function fixture() {
  const bookings = TARGETS.map(t => ({
    id: t.id, tenant_id: TENANT, event_id: EVENT, booking_group_reference: t.group,
    status: 'confirmed', payment_method: 'card', stripe_payment_intent_id: t.pi,
    is_guest_booking: t.guest, member_id: t.member, total_cost: 166.67, ticket_price: 166.67,
    account_amount: 0, created_at: '2026-09-23T21:30:00Z',
  }));
  bookings.push({ id: ACCOUNT, tenant_id: TENANT, event_id: EVENT,
    booking_group_reference: 'OOE-1790858488719-1I8XH', status: 'confirmed', payment_method: 'account',
    total_cost: 200, account_amount: 200, organization_id: 'test-org', po_to_follow: true });
  return { version: 1, tenantId: TENANT, eventId: EVENT, observedAt: '2026-10-01T00:00:00Z',
    provider: { connectionId: 'test-connection', xeroTenantId: 'test-xero' },
    connections: [{ tenantId: 'test-xero' }], activeProvider: 'xero',
    settings: { xero_invoice_enabled: 'true', xero_sales_account_code: '210', xero_stripe_bank_account_code: '999' },
    accounts: [{ Code: '210', Status: 'ACTIVE' }, { Code: '999', Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }],
    taxRates: [{ TaxType: 'OUTPUT2', Status: 'ACTIVE', EffectiveRate: 20 }], bookings,
    members: [{ id: TARGETS[0].member, tenant_id: TENANT, first_name: 'Test', last_name: 'Booker', email: 'booker@example.invalid' }],
    paymentIntents: TARGETS.map((t, i) => ({
      id: t.pi, livemode: true, status: 'succeeded', amount: 16667, amount_received: 16667, currency: 'gbp', capture_method: 'automatic',
      metadata: { tenant_id: TENANT, event_id: EVENT, is_guest: String(t.guest), member_email: i ? '' : 'booker@example.invalid' },
      customer: { id: `cus_test${i}`, livemode: true, email: i ? 'payer@example.invalid' : 'booker@example.invalid', metadata: { tenant_id: TENANT } },
      latest_charge: { id: `ch_test${i}`, livemode: true, status: 'succeeded', paid: true, captured: true,
        refunded: false, amount_refunded: 0, amount_captured: 16667, currency: 'gbp', payment_intent: t.pi,
        created: Date.parse('2026-09-23T21:24:00Z') / 1000, billing_details: {} },
    })),
  };
}
test('offline exact plan reconstructs only two inclusive live cards, never account settlement', () => {
  const plan = buildPlan(fixture());
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.blocked[0].bookingId, ACCOUNT);
  assert.equal(plan.blocked[0].amountPayable, 200);
  assert.equal(plan.blocked[0].settlement, null);
  for (const row of plan.rows) {
    assert.equal(row.snapshot.invoice.LineAmountTypes, 'Inclusive');
    assert.equal(row.snapshot.invoice.LineItems[0].TaxAmount, 27.78);
    assert.equal(row.snapshot.historicalReview.immutableCheckoutEvidence, false);
    assert.equal(row.snapshot.settlement.livemode, true);
    assert.equal(validHistoricalRecoveryEvidence(row.snapshot, { version: 1, kind: 'approved_repair_manifest',
      environment: 'live', approvalReference: plan.reviewSha256, approvedBy: 'test', approvedAt: '2026-10-01',
      provenance: ['explicit test approval'], paymentIntentId: row.snapshot.settlement.paymentIntentId }), true);
  }
  assert.equal(plan.rows[1].snapshot.contact.name, 'payer@example.invalid');
});
test('receipt payer wins over unrelated attendee; contradictory payer email blocks', () => {
  const e = fixture();
  e.bookings[1].attendee_email = 'attendee@example.invalid';
  assert.equal(buildPlan(e).rows[1].snapshot.contact.email, 'payer@example.invalid');
  e.paymentIntents[1].receipt_email = 'different@example.invalid';
  assert.throws(() => buildPlan(e), /stripe_payer_email_missing_or_conflicting/);
});
test('booker must be verified by PI purchaser metadata, not attendee', () => {
  const e = fixture();
  e.paymentIntents[0].metadata.member_email = 'different@example.invalid';
  assert.throws(() => buildPlan(e), /original_member_purchaser_not_verified/);
});
test('test-mode, refunded, wrong amount and wrong PI fail closed', () => {
  for (const mutate of [
    e => { e.paymentIntents[0].livemode = false; },
    e => { e.paymentIntents[0].latest_charge.refunded = true; },
    e => { e.paymentIntents[0].amount_received = 20000; },
    e => { e.bookings[0].stripe_payment_intent_id = 'pi_test'; },
  ]) {
    const e = fixture(); mutate(e); assert.throws(() => buildPlan(e));
  }
});
test('account payable and original PO-to-follow cannot drift', () => {
  const e = fixture(); e.bookings[2].account_amount = 0;
  assert.throws(() => buildPlan(e), /account_booking_preservation/);
});
test('current connection, sales, tax and bank mapping must all be verified', () => {
  for (const mutate of [
    e => { e.connections = []; },
    e => { e.settings.xero_sales_account_code = '200'; },
    e => { e.taxRates[0].EffectiveRate = 0; },
    e => { e.accounts[1].CurrencyCode = 'USD'; },
  ]) {
    const e = fixture(); mutate(e); assert.throws(() => buildPlan(e));
  }
});
test('hash is stable and pins evidence/snapshots/authority candidate', () => {
  const e = fixture(); const a = buildPlan(e);
  assert.equal(a.reviewSha256, buildPlan(structuredClone(e)).reviewSha256);
  e.candidates = [{ operationId: 'test-op', tenantId: TENANT, source: 'booking',
    bookingGroupReference: TARGETS[0].group, operationUpdatedAt: '2026-10-01', bookingFingerprint: 'test' }];
  assert.notEqual(a.reviewSha256, buildPlan(e).reviewSha256);
  const { reviewSha256, ...payload } = a;
  assert.equal(reviewSha256, hash(payload));
});
test('source fingerprint ignores recovery mirrors only', () => {
  const e = fixture(); const b = e.bookings[0]; const original = bookingFingerprint(b);
  b.invoice_recovery_status = 'needs_review'; b.invoice_recovery_next_attempt_at = '2026-10-01';
  assert.equal(original, bookingFingerprint(b));
  b.status = 'cancelled'; assert.notEqual(original, bookingFingerprint(b));
});
test('CLI defaults offline and requires private paths and exact apply hash', () => {
  assert.equal(parseArgs(['--evidence', '/tmp/evidence.json', '--out', '/tmp/plan.json']).apply, false);
  for (const args of [
    ['--apply', '--evidence', '/tmp/e.json', '--out', '/tmp/r.json'],
    ['--capture', '--apply', '--out', '/tmp/r.json'],
    ['--evidence', '/tmp/e.json', '--out', 'scripts/private.json'],
    ['--evidence', '/tmp/e.json', '--out', '/tmp/e.json'],
    ['--capture', '--out', '/tmp/r.json', '--tenant', TENANT],
  ]) assert.throws(() => parseArgs(args));
});