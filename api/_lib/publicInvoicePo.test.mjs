import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicInvoicePo, requirePublicInvoicePoBalance } from './publicInvoicePo.js';

const purchaserInfo = { email: 'buyer@example.com', first_name: 'Public', last_name: 'Buyer', phone: '01234', organization: 'Example', answers: { access: 'Ramp' } };
function options({ member = false, error = null, ...overrides } = {}) {
  const calls = [];
  const query = {
    select() { return this; },
    eq(...args) { calls.push(args); return this; },
    ilike(...args) { calls.push(args); return this; },
    async limit() { return { data: member ? [{ id: 'member' }] : [], error }; },
  };
  return {
    client: { from(table) { assert.equal(table, 'member'); return query; } },
    event: { tenant_id: 'tenant', allow_public_invoice_po: true },
    purchaserInfo: structuredClone(purchaserInfo), calls,
    ...overrides,
  };
}

test('snapshot retains collected contact data independently of member attendees, never arbitrary metadata', async () => {
  const args = options({ attendees: [{ email: 'member@example.com', member_id: 'member' }] });
  const snapshot = await validatePublicInvoicePo(args);
  assert.equal(snapshot.classification, 'public_non_member');
  const { answers, ...contactDetails } = purchaserInfo;
  assert.deepEqual(snapshot.details, contactDetails);
  assert.ok(Date.parse(snapshot.submitted_at));
  args.purchaserInfo.phone = 'Changed';
  assert.equal(snapshot.details.phone, '01234');
  assert.equal(snapshot.details.answers, undefined);
  assert.deepEqual(args.calls, [['tenant_id', 'tenant'], ['email', 'buyer@example.com']]);
});
test('snapshot drops tokens and classification overrides from submitted metadata', async () => {
  const snapshot = await validatePublicInvoicePo(options({
    purchaserInfo: { ...purchaserInfo, token: 'sensitive', access_token: 'sensitive', classification: 'member', payment_method: 'invoice' },
  }));
  assert.equal(snapshot.classification, 'public_non_member');
  for (const key of ['token', 'access_token', 'classification', 'payment_method']) {
    assert.equal(snapshot.details[key], undefined);
  }
});
test('default off, authenticated caller, member purchaser and failed eligibility checks fail closed', async () => {
  for (const overrides of [
    { event: { tenant_id: 'tenant' } }, { authenticatedMember: { id: 'member' } },
    { member: true }, { error: { message: 'DB unavailable' } },
    { allocationContext: {} }, { purchaserInfo: null }, { purchaserInfo: { ...purchaserInfo, email: 'invalid' } },
  ]) await assert.rejects(validatePublicInvoicePo(options(overrides)));
});
test('payment mixing is rejected before any accounting or payment action', async () => {
  for (const overrides of [
    { stripePaymentIntentId: 'pi_123' }, { voucherIds: ['voucher'] },
    { trainingFundAmount: 1 }, { accountAmount: 1 }, { purchaseOrderNumber: {} },
  ]) await assert.rejects(validatePublicInvoicePo(options(overrides)));
});
test('PO is optional and email wildcard characters are escaped for membership lookup', async () => {
  await validatePublicInvoicePo(options({ purchaseOrderNumber: null }));
  const args = options({ purchaserInfo: { ...purchaserInfo, email: ' BUY_ER@Example.com ' }, purchaseOrderNumber: 'PO-123' });
  const snapshot = await validatePublicInvoicePo(args);
  assert.equal(snapshot.details.email, 'buy_er@example.com');
  assert.equal(args.calls[1][1], 'buy\\_er@example.com');
});
test('zero, negative, invalid and fully discounted amounts cannot become unpaid PO bookings', () => {
  for (const amount of [0, -1, null, undefined, NaN, Infinity, 'bad']) {
    assert.throws(() => requirePublicInvoicePoBalance(amount));
  }
  assert.doesNotThrow(() => requirePublicInvoicePoBalance(50));
});