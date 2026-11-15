import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicInvoicePo, requirePublicInvoicePoBalance } from './publicInvoicePo.js';
import { literalNormalizedEmailPattern } from './publicTicketEmail.js';

const purchaserInfo = { email: 'buyer@example.com', first_name: 'Public', last_name: 'Buyer', phone: '01234', organization: 'Example', answers: { access: 'Ramp' },
  invoicing_address_line1: '1 Road', invoicing_city: 'London', invoicing_postal_code: 'N1 1AA', invoicing_country: 'United Kingdom' };
function options({ member = false, error = null, ...overrides } = {}) {
  const calls = [];
  const query = {
    select() { return this; },
    eq(...args) { calls.push(args); return this; },
    ilike(...args) { calls.push(args); return this; },
    filter(...args) { calls.push(args); return this; },
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
  assert.deepEqual(snapshot.details, { ...contactDetails, invoicing_address_line2: '', invoicing_region: '' });
  assert.ok(Date.parse(snapshot.submitted_at));
  args.purchaserInfo.phone = 'Changed';
  assert.equal(snapshot.details.phone, '01234');
  assert.equal(snapshot.details.answers, undefined);
  assert.deepEqual(args.calls, [['tenant_id', 'tenant'], ['email', 'imatch', literalNormalizedEmailPattern('buyer@example.com')]]);
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
  assert.equal(args.calls[1][2], literalNormalizedEmailPattern('buy_er@example.com'));
});
test('zero, negative, invalid and fully discounted amounts cannot become unpaid PO bookings', () => {
  for (const amount of [0, -1, null, undefined, NaN, Infinity, 'bad']) {
    assert.throws(() => requirePublicInvoicePoBalance(amount));
  }
  assert.doesNotThrow(() => requirePublicInvoicePoBalance(50));
});

test('public invoice bookings require and preserve a bounded billing address', async () => {
  const snapshot = await validatePublicInvoicePo(options());
  assert.equal(snapshot.details.invoicing_address_line1, '1 Road');
  assert.equal(snapshot.details.invoicing_country, 'United Kingdom');
  for (const field of ['organization', 'invoicing_address_line1', 'invoicing_city', 'invoicing_postal_code', 'invoicing_country']) {
    await assert.rejects(validatePublicInvoicePo(options({ purchaserInfo: { ...purchaserInfo, [field]: '' } })), /required/);
  }
  for (const value of [{ address: 'forged' }, 'x'.repeat(256), 'street\ninjected']) {
    await assert.rejects(validatePublicInvoicePo(options({ purchaserInfo: { ...purchaserInfo, invoicing_address_line1: value } })));
  }
});