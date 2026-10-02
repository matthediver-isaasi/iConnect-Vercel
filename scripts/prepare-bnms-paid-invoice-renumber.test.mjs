import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, TENANT, XERO_TENANT, BLOCKER, hash, parseArgs, assertRenumberResult, buildPlan } from './prepare-bnms-paid-invoice-renumber.mjs';

// Deliberately synthetic, offline-only fixtures; never used by capture/production.
const fixture = () => {
  const e = { version: 1, tenantId: TENANT, xeroTenantId: XERO_TENANT, observedAt: '2026-10-02T00:00:00Z',
    connections: [{ tenantId: XERO_TENANT }], invoices: [], bookings: [], recovery: [], payments: [] };
  TARGETS.forEach((t, n) => {
    const paymentId = `offline-payment-${n}`;
    e.invoices.push({ InvoiceID: t.id, InvoiceNumber: t.number, Type: 'ACCREC', Status: 'PAID',
      LineAmountTypes: 'Inclusive', CurrencyCode: 'GBP', Total: 166.67, SubTotal: 138.89, TotalTax: 27.78,
      AmountPaid: 166.67, AmountDue: 0, AmountCredited: 0, Contact: { ContactID: `offline-contact-${n}` },
      LineItems: [{ LineItemID: `offline-line-${n}`, TaxType: 'OUTPUT2', AccountCode: '210', LineAmount: 166.67 }],
      Payments: [{ PaymentID: paymentId, Amount: 166.67 }] });
    e.bookings.push({ source: 'booking', row: { id: `offline-booking-${n}`, tenant_id: TENANT,
      xero_invoice_id: t.id, xero_invoice_number: t.number, booking_group_reference: `offline-group-${n}`,
      stripe_payment_intent_id: `offline-pi-${n}`, invoice_recovery_status: 'complete' } });
    e.recovery.push({ id: `offline-recovery-${n}`, tenant_id: TENANT, xero_tenant_id: XERO_TENANT,
      source: 'booking', invoice_id: t.id, invoice_number: t.number, booking_group_reference: `offline-group-${n}`,
      status: 'complete', payment_id: paymentId, settlement_payment_intent_id: `offline-pi-${n}` });
    e.payments.push({ PaymentID: paymentId, Invoice: { InvoiceID: t.id }, Amount: 166.67, Status: 'AUTHORISED' });
  });
  return e;
};
test('valid review is hash-pinned but not executable; no invented numbers', () => {
  const { plan, reviewSha256 } = buildPlan(fixture());
  assert.equal(reviewSha256, hash(plan));
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.blockers, [BLOCKER]);
  assert.equal(plan.providerWrites + plan.sqlWrites, 0);
  assert.ok(plan.repairs.every(r => r.newNumber === null));
});
test('apply and tenant/number overrides rejected before I/O', () => {
  assert.throws(() => parseArgs(['--apply']), new RegExp(BLOCKER));
  for (const args of [['--tenant=x'], ['--number=INV-123'], ['--capture', '--out', '/workspace/a.json'],
    ['--capture', '--capture', '--out', '/tmp/a.json']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['--capture', '--out', '/tmp/a.json']), { capture: true, out: '/tmp/a.json' });
});
test('reject scope/cardinality/number/status/ownership/payment drift', () => {
  const mutations = [
    e => { e.tenantId = 'wrong'; }, e => { e.xeroTenantId = 'wrong'; },
    e => { e.connections = []; }, e => { e.invoices.push(e.invoices[0]); },
    e => { e.invoices[0].InvoiceNumber = 'INV-123'; }, e => { e.invoices[0].AmountDue = 1; },
    e => { e.invoices[0].TotalTax = 27.77; }, e => { e.invoices[0].LineAmountTypes = 'Exclusive'; },
    e => { e.invoices[0].Payments = []; }, e => { e.bookings[0].row.xero_invoice_number = 'wrong'; },
    e => { e.recovery[0].invoice_number = 'wrong'; }, e => { e.recovery[0].status = 'processing'; },
    e => { e.recovery[0].lease_token = 'active'; }, e => { e.recovery[0].snapshot = {}; e.recovery[0].payment_id = 'wrong'; },
    e => { e.payments[0].Invoice.InvoiceID = TARGETS[1].id; },
    e => { e.bookings[0].row.stripe_payment_intent_id = 'wrong'; },
  ];
  for (const mutate of mutations) { const e = fixture(); mutate(e); assert.throws(() => buildPlan(e)); }
});
test('post-update invariant checker permits ONLY number and update timestamps', () => {
  const before = fixture().invoices[0], after = structuredClone(before);
  after.InvoiceNumber = 'offline-reserved-number';
  after.UpdatedDateUTC = '/Date(1)/';
  assert.doesNotThrow(() => assertRenumberResult(before, after, TARGETS[0], after.InvoiceNumber));
  for (const mutate of [
    i => { i.Contact.ContactID = 'other'; }, i => { i.LineItems[0].AccountCode = '211'; },
    i => { i.Payments[0].PaymentID = 'other'; }, i => { i.Reference = 'changed'; },
    i => { i.AmountPaid = 0; }, i => { i.Status = 'AUTHORISED'; },
  ]) { const changed = structuredClone(after); mutate(changed); assert.throws(() => assertRenumberResult(before, changed, TARGETS[0], after.InvoiceNumber)); }
});
test('evidence changed after review changes digest', () => {
  const e = fixture(), first = buildPlan(e);
  e.bookings[0].row.unrelated_field = 'drift';
  const next = buildPlan(e);
  assert.notEqual(first.reviewSha256, next.reviewSha256);
  assert.notEqual(first.plan.repairs[0].booking.fingerprint, next.plan.repairs[0].booking.fingerprint);
});
test('Xero may omit AmountCredited when there are no allocations; never accept credits', () => {
  const e = fixture();
  delete e.invoices[0].AmountCredited;
  assert.doesNotThrow(() => buildPlan(e));
  e.invoices[0].CreditNotes = [{ CreditNoteID: 'offline-credit' }];
  assert.throws(() => buildPlan(e));
});
test('CAS templates require full row equality and exact tenant/ID/number/status', () => {
  const { plan } = buildPlan(fixture(), 'a'.repeat(64));
  for (const { localCAS: c } of plan.repairs) {
    assert.match(c.bookingSQL, /to_jsonb\(b\)=\$6::jsonb/);
    assert.match(c.recoverySQL, /to_jsonb\(r\)=\$6::jsonb/);
    for (const sql of [c.bookingSQL, c.recoverySQL]) {
      assert.match(sql, /tenant_id=\$1 AND id=\$2/);
      assert.match(sql, /number=\$5/);
      assert.match(sql, /status='complete'/);
      assert.doesNotMatch(sql, /SET .*payment_id=/);
    }
    assert.equal(c.expectedRowsPerStatement, 1);
    assert.match(c.lockBookingSQL, /FOR UPDATE$/);
    assert.match(c.lockRecoverySQL, /FOR UPDATE$/);
  }
  assert.notEqual(buildPlan(fixture(), 'a'.repeat(64)).reviewSha256, buildPlan(fixture(), 'b'.repeat(64)).reviewSha256);
});