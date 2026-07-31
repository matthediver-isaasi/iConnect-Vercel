// Task #3248 — Regression coverage for the applyStripePaymentToInvoice
// argument-shape mismatch. The public fee confirm path passes `invoiceId`,
// while the Xero implementation requires `xeroInvoiceId`; the provider
// facade must normalise so either shape works for every caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoiceIdArgs } from './accountingProvider.js';

test('invoiceId-only shape (public fee confirm path) maps to xeroInvoiceId', () => {
  const out = normalizeInvoiceIdArgs({
    appTenantId: 't1',
    invoiceId: 'inv-123',
    stripePaymentIntentId: 'pi_abc',
  });
  assert.equal(out.xeroInvoiceId, 'inv-123');
  assert.equal(out.invoiceId, 'inv-123');
  assert.equal(out.appTenantId, 't1');
  assert.equal(out.stripePaymentIntentId, 'pi_abc');
});

test('xeroInvoiceId-only shape maps to invoiceId', () => {
  const out = normalizeInvoiceIdArgs({ xeroInvoiceId: 'inv-456' });
  assert.equal(out.invoiceId, 'inv-456');
  assert.equal(out.xeroInvoiceId, 'inv-456');
});

test('both keys (gocardlessAccounting shape) pass through unchanged', () => {
  const out = normalizeInvoiceIdArgs({ invoiceId: 'a', xeroInvoiceId: 'a', amount: 12.5 });
  assert.equal(out.invoiceId, 'a');
  assert.equal(out.xeroInvoiceId, 'a');
  assert.equal(out.amount, 12.5);
});

test('missing both keys stays missing (implementations still throw loudly)', () => {
  const out = normalizeInvoiceIdArgs({ appTenantId: 't1' });
  assert.equal(out.xeroInvoiceId, undefined);
  assert.equal(out.invoiceId, undefined);
});
