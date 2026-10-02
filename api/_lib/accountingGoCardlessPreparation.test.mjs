import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGoCardlessAccountingRequest, verifyGoCardlessExistingInvoice, resolveGoCardlessFrozenBank } from './accountingGoCardlessPreparation.js';
import { createAccountingRequestProviders, validateAccountingRequestResult } from './accountingRequestProviders.js';

const collection = { amountMinor: 1234, currency: 'GBP', date: '2026-10-01', bankAccountId: 'bank', reference: 'GC PM123' };
const rowFor = provider => ({
  id: 'queue', tenant_id: 'tenant', company_id: 'company', connection_id: 'connection',
  source_type: 'gocardless_payment', source_id: 'payment', provider, operation: 'payment',
  snapshot: { version: 1, preparation: true, environment: provider === 'quickbooks' ? 'sandbox' : null,
    invoice: {}, existingInvoice: { id: 'invoice', contactId: 'customer', currency: 'GBP' },
    payment: { collection }, linkage: { paymentId: 'payment' } },
});
const recordFor = provider => provider === 'xero'
  ? { InvoiceID: 'invoice', Contact: { ContactID: 'customer' }, CurrencyCode: 'GBP', AmountDue: 20, Total: 30, Status: 'AUTHORISED', Type: 'ACCREC' }
  : { Id: 'invoice', CustomerRef: { value: 'customer' }, CurrencyRef: { value: 'GBP' }, Balance: 20, TotalAmt: 30 };
for (const provider of ['xero', 'quickbooks']) {
  test(`${provider}: existing invoice payment-only exact frozen allocation`, async () => {
    const row = rowFor(provider);
    const original = structuredClone(row);
    const resolved = await prepareGoCardlessAccountingRequest({ row, providers: {
      assertBinding: async () => {}, preparationTransport: () => { throw new Error('not needed'); },
      readExistingInvoice: async () => recordFor(provider),
    } });
    assert.deepEqual(row, original);
    assert.equal(resolved.existingInvoice.verifiedRemainingMinor, 2000);
    assert.equal(resolved.payment.envelope.expected.totalMinor, 1234);
    assert.equal(resolved.payment.envelope.expected.invoiceId, 'invoice');
    assert.equal(resolved.payment.envelope.expected.date, collection.date);
    if (provider === 'quickbooks') assert.deepEqual(resolved.payment.envelope.payload.Line,
      [{ Amount: 12.34, LinkedTxn: [{ TxnId: 'invoice', TxnType: 'Invoice' }] }]);
    row.resolved_snapshot = resolved;
    row.invoice_result = { id: 'invoice' };
    const envelope = resolved.payment.envelope;
    const payment = provider === 'xero'
      ? { ...envelope.payload, PaymentID: 'paid', Status: 'AUTHORISED',
        Invoice: { InvoiceID: 'invoice', Contact: { ContactID: 'customer' }, CurrencyCode: 'GBP' } }
      : { ...envelope.payload, Id: 'paid', UnappliedAmt: 0 };
    assert.equal(validateAccountingRequestResult(row, 'payment', payment).id, 'paid');
    assert.throws(() => validateAccountingRequestResult(row, 'payment',
      { ...payment, [provider === 'xero' ? 'Date' : 'TxnDate']: '2026-10-02' }), /PAYMENT_DATE|PROVIDER_RESULT_MISMATCH/);
  });
  test(`${provider}: missing, excessive and inexact remaining fail closed`, () => {
    const row = rowFor(provider);
    for (const balance of [undefined, 0, 12.33, 'garbage']) {
      const record = { ...recordFor(provider), [provider === 'xero' ? 'AmountDue' : 'Balance']: balance };
      assert.throws(() => verifyGoCardlessExistingInvoice({ provider, collection, existingInvoice: row.snapshot.existingInvoice, record }), /REMAINING/);
    }
    assert.throws(() => verifyGoCardlessExistingInvoice({ provider, collection,
      existingInvoice: { ...row.snapshot.existingInvoice, requireExactRemaining: true }, record: recordFor(provider) }), /REMAINING/);
  });
}
test('durable row required before any contact/tax dependency', async () => {
  await assert.rejects(prepareGoCardlessAccountingRequest({ row: {} }), /DURABLE/);
});
test('frozen Xero code resolves exact active bank ID without reading current settings', async () => {
  const row = rowFor('xero');
  row.snapshot.payment.bankSetting = { key: 'xero_gocardless_bank_account_code', value: '090' };
  const transport = { fetch: async url => {
    assert.equal(new URL(url).searchParams.get('where'), 'Code=="090"');
    return Response.json({ Accounts: [{ AccountID: 'resolved-bank', Code: '090', Type: 'BANK', Status: 'ACTIVE', CurrencyCode: 'GBP' }] });
  } };
  assert.equal(await resolveGoCardlessFrozenBank({ row, transport, currency: 'GBP' }), 'resolved-bank');
  await assert.rejects(resolveGoCardlessFrozenBank({ row, transport, currency: 'EUR' }), /CURRENCY/);
  delete row.snapshot.payment.bankSetting;
  await assert.rejects(resolveGoCardlessFrozenBank({ row, transport, currency: 'GBP' }), /FROZEN_BANK/);
});
test('QBO frozen bank ID rejects inactive account and retains rate-limit embargo', async () => {
  const row = rowFor('quickbooks');
  row.snapshot.payment.bankSetting = { key: 'quickbooks_gocardless_bank_account_id', value: 'bank' };
  await assert.rejects(resolveGoCardlessFrozenBank({ row, currency: 'GBP', transport: {
    fetch: async () => Response.json({ Account: { Id: 'bank', Active: false, AccountType: 'Bank' } }),
  } }), /BANK_ACCOUNT_INVALID/);
  await assert.rejects(resolveGoCardlessFrozenBank({ row, currency: 'GBP', transport: {
    fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '900' } }),
  } }), error => error.retryAfter === '900');
});
test('membership preparation preserves addon/tax snapshot and cannot pay', async () => {
  const row = rowFor('xero');
  delete row.snapshot.existingInvoice;
  row.snapshot.invoice.args = { appTenantId: 'tenant', currency: 'GBP', markAsPaid: true,
    vatRate: { taxType: 'OUTPUT2' }, extraLineItems: [{ description: 'addon', unitCost: 1 }] };
  const lines = [{ Description: 'frozen membership', UnitAmount: '10.00', TaxType: 'OUTPUT2' },
    { Description: 'addon', UnitAmount: '1.00', TaxType: 'NONE' }];
  const resolved = await prepareGoCardlessAccountingRequest({ row, providers: {
    assertBinding: async () => {}, preparationTransport: () => ({ fetch: () => { throw new Error('network forbidden'); } }),
  } }, { prepareMembership: async (args, deps) => {
    assert.equal(args.markAsPaid, true);
    assert.equal(deps.prepareOnly, true);
    assert.deepEqual(args.extraLineItems, row.snapshot.invoice.args.extraLineItems);
    return { companyId: 'company', contactId: 'customer', payload: { Type: 'ACCREC', Status: 'AUTHORISED', LineItems: lines } };
  } });
  assert.equal(resolved.invoice.envelope.payload.LineItems[1].TaxType, 'NONE');
  assert.equal(resolved.payment.envelope.expected.invoiceId, '$invoice');
});
test('bound preparation transport denies financial writes and preserves Retry-After', async () => {
  const row = rowFor('quickbooks');
  let calls = 0;
  const adapter = createAccountingRequestProviders({
    resolveConnection: async () => ({ tenantId: 'tenant', provider: 'quickbooks', connectionId: 'connection',
      companyId: 'company', environment: 'sandbox', accessToken: 'test' }),
    beforeRequest: async candidate => { assert.equal(candidate, row); return { timeoutMs: 500 }; },
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); },
  });
  const transport = adapter.preparationTransport(row);
  await assert.rejects(transport.fetch('https://sandbox-quickbooks.api.intuit.com/v3/company/company/payment', { method: 'POST' }), /FORBIDDEN/);
  assert.equal(calls, 0);
  await assert.rejects(transport.fetch('https://sandbox-quickbooks.api.intuit.com/v3/company/company/query'), error => error.retryAfter === '120');
  assert.equal(calls, 1);
});