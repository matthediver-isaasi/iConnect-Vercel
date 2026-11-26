import test from 'node:test';
import assert from 'node:assert/strict';
import { organisationActivityPurchase } from './organisationActivityPurchase.js';

const access = { canView: true, tenantId: 'tenant', organizationId: 'org' };
const submission = () => ({
  id: 'submission', tenant_id: 'tenant', organization_id: 'org',
  payment_provider: 'invoice', payment_status: 'unpaid', payment_amount: '120', payment_currency: 'gbp',
  payment_meta: {
    invoice_order: { version: 1, provider: 'xero', snapshot: {
      lines: [{ description: 'Exhibition stand', quantity: 2 }, { description: 'Delegate ticket', quantity: 1 }],
    } },
    invoice_result: { id: 'invoice', invoiceNumber: 'INV-42', status: 'AUTHORISED' },
  },
});

test('summarises persisted lines, major-unit amount, invoice and unpaid status separately', () => {
  assert.deepEqual(organisationActivityPurchase(submission(), access), {
    items: ['2 × Exhibition stand', '1 × Delegate ticket'],
    amount: 'GBP 120.00', invoice: 'Invoice INV-42',
    invoiceStatus: 'AUTHORISED', paymentStatus: 'unpaid',
  });
});

test('no purchase or invoice details when permission, tenant or organisation does not match', () => {
  for (const overrides of [
    { canView: false }, { tenantId: null }, { tenantId: 'other' },
    { organizationId: 'other' }, { organizationId: null },
  ]) assert.equal(organisationActivityPurchase(submission(), { ...access, ...overrides }), null);
  assert.equal(organisationActivityPurchase({ ...submission(), tenant_id: undefined }, access), null);
});

test('non-purchase forms and card payments do not gain invoice summaries', () => {
  for (const provider of [undefined, null, 'stripe', 'gocardless']) {
    assert.equal(organisationActivityPurchase({ ...submission(), payment_provider: provider }, access), null);
  }
  assert.equal(organisationActivityPurchase(null, access), null);
});

test('pending accounting and number-only historical invoices do not require invoice retrieval', () => {
  const row = submission();
  delete row.payment_meta.invoice_result;
  assert.match(organisationActivityPurchase(row, access).invoice, /processing pending/);
  assert.equal(organisationActivityPurchase(row, access).paymentStatus, 'unpaid');
  row.payment_meta.invoice_result = { invoice_number: 'OLD-42' };
  assert.equal(organisationActivityPurchase(row, access).invoice, 'Invoice OLD-42');
});

test('legacy receipt names and quantities are retained without current catalogue lookups', () => {
  const row = submission();
  row.payment_meta = {};
  row.submission_data = { __cart_receipt: { version: 1, lines: [
    { name: 'Historical stand', description: 'Extra detail', quantity: 3 },
  ] } };
  assert.deepEqual(organisationActivityPurchase(row, access).items, ['3 × Historical stand']);
});

test('zero, missing and invalid amounts never invent money or currency', () => {
  for (const amount of [null, undefined, '', ' ', 'invalid', Infinity, {}, false]) {
    assert.equal(organisationActivityPurchase({ ...submission(), payment_amount: amount }, access).amount, null);
  }
  assert.equal(organisationActivityPurchase({ ...submission(), payment_amount: 0 }, access).amount, 'GBP 0.00');
  assert.equal(organisationActivityPurchase({ ...submission(), payment_currency: null }, access).amount,
    '120.00 (currency not recorded)');
});

test('recorded payment states are displayed as recorded, never derived from invoice issuance', () => {
  for (const status of ['unpaid', 'paid', 'pending_payment', 'failed', null]) {
    assert.equal(organisationActivityPurchase({ ...submission(), payment_status: status }, access).paymentStatus,
      status?.replaceAll('_', ' ') || 'not recorded');
  }
});
