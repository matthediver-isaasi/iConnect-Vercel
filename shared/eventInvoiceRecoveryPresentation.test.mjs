import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventInvoiceAwaited, eventInvoiceGroupRecord, eventInvoiceId,
  eventInvoiceNeedsAttention, eventInvoiceRefetchInterval, eventInvoiceShouldPoll,
} from './eventInvoiceRecoveryPresentation.mjs';

const booking = { payment_method: 'invoice', total_cost: 100, status: 'confirmed' };

test('awaited invoices require explicit eligible recovery state, never a missing invoice alone', () => {
  for (const status of ['pending', 'processing', 'retry', 'needs_review']) {
    assert.equal(eventInvoiceAwaited({ ...booking, invoice_recovery_status: status }), true);
  }
  for (const status of [null, undefined, '', 'unknown', 'complete', 'not_applicable']) {
    assert.equal(eventInvoiceAwaited({ ...booking, invoice_recovery_status: status }), false);
  }
  for (const excluded of [
    { payment_method: 'public_invoice_po' }, { payment_method: 'free' },
    { payment_method: 'voucher' }, { payment_method: 'training_fund' },
    { status: 'cancelled' }, { total_cost: 0 },
    { voucher_amount: 40, training_fund_amount: 60 },
  ]) {
    assert.equal(eventInvoiceAwaited({ ...booking, invoice_recovery_status: 'pending', ...excluded }), false);
  }
  assert.equal(eventInvoiceAwaited({ ...booking, xero_invoice_error: 'Provider error' }), false);
});

test('linkage on any attendee wins over recovery including settlement retry', () => {
  for (const field of ['accounting_invoice_id', 'xero_invoice_id']) {
    const linked = { ...booking, [field]: 'invoice-id', invoice_recovery_status: 'retry' };
    assert.equal(eventInvoiceAwaited(linked), false);
    assert.equal(eventInvoiceShouldPoll(linked), false);
    assert.equal(eventInvoiceId(eventInvoiceGroupRecord([{ ...booking, invoice_recovery_status: 'pending' }, linked])), 'invoice-id');
  }
  assert.equal(eventInvoiceAwaited({ ...booking, xero_invoice_number: 'Number-only', invoice_recovery_status: 'retry' }), true);
});

test('report projection and polling stop on review, linkage or query failure', () => {
  const payment = { paymentMethod: 'card', totalCost: 100, invoiceRecoveryStatus: 'retry' };
  assert.equal(eventInvoiceAwaited(payment), true);
  assert.equal(eventInvoiceRefetchInterval({ state: { status: 'success' } }, [payment]), 30000);
  assert.equal(eventInvoiceRefetchInterval({ state: { status: 'error' } }, [payment]), false);
  assert.equal(eventInvoiceRefetchInterval({ state: { fetchFailureCount: 1 } }, [payment]), false);
  const review = { ...payment, invoiceRecoveryStatus: 'needs_review' };
  assert.equal(eventInvoiceNeedsAttention(review), true);
  assert.equal(eventInvoiceRefetchInterval({ state: {} }, [review]), false);
  assert.equal(eventInvoiceRefetchInterval({ state: {} }, [{ ...payment, accountingInvoiceId: 'id' }]), false);
  assert.equal(eventInvoiceRefetchInterval({ state: {} }, [
    { ...booking, booking_group_reference: 'GROUP', invoice_recovery_status: 'retry' },
    { ...booking, booking_group_reference: 'GROUP', accounting_invoice_id: 'linked' },
  ]), false);
});