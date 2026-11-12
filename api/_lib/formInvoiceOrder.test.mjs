import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceBillingDetails, invoiceLines, prepareFormInvoiceSource } from './formInvoiceOrder.js';

test('invoice billing requires explicit stored text/email mappings', () => {
  const field = { invoice_billing_name_field_id: 'name', invoice_billing_email_field_id: 'email' };
  const fields = [{ id: 'name', type: 'text' }, { id: 'email', type: 'email' }];
  assert.equal(invoiceBillingDetails(field, fields, { name: 'Buyer', email: 'buyer@example.org' }).name, 'Buyer');
  assert.throws(() => invoiceBillingDetails(field, fields, { name: 'Buyer', email: 'bad' }), /billing name and email/);
  assert.throws(() => invoiceBillingDetails({}, fields, { name: 'Buyer', email: 'buyer@example.org' }), /billing name and email/);
});

test('ordinary invoice preserves gross amount and explicit default tax', () => {
  const [line] = invoiceLines({ amount: 120, label: 'Order', taxOptions: [{ id: 'OUTPUT2', rateBps: 2000 }],
    defaultCode: 'OUTPUT2', accountCode: '200' });
  assert.equal(line.netMinor, 10000);
  assert.equal(line.taxMinor, 2000);
  assert.equal(line.grossMinor, 12000);
  assert.throws(() => invoiceLines({ amount: 120, taxOptions: [], accountCode: '200' }), /default sales tax/);
});

test('cart invoice retains line-rounded economics and fails ambiguous tax mapping', () => {
  const input = { cartTerms: { lines: [{ name: 'Bundle', quantity: 3, taxRateBps: 2000,
    netMinor: 303, taxMinor: 61, grossMinor: 364 }] },
  taxOptions: [{ id: 'OUTPUT2', rateBps: 2000 }], accountCode: '200' };
  assert.equal(invoiceLines(input)[0].taxMinor, 61);
  assert.throws(() => invoiceLines({ ...input, taxOptions: [...input.taxOptions, { id: 'OTHER', rateBps: 2000 }] }), /unambiguous/);
});

test('invoice preparation publishes frozen cart lines and no settlement instruction', async () => {
  const row = { tenant_id: 'tenant', source_type: 'form_invoice_order', source_id: 'submission',
    provider: 'xero', company_id: 'company', snapshot: { version: 1, preparation: true, payment: null,
      linkage: { formId: 'form' }, lines: [{ description: 'Bundle', quantity: 1, netMinor: 10000,
        taxMinor: 2000, grossMinor: 12000, taxCode: 'OUTPUT2', accountCode: '200' }],
      invoice: { args: { appTenantId: 'tenant', currency: 'GBP' }, totalMinor: 12000, settings: {},
        dueDate: '2026-12-11', invoiceDate: '2026-11-11' } } };
  const result = await prepareFormInvoiceSource({ row, transport: {} }, { prepare: async args => {
    assert.equal(args.markAsPaid, false);
    return { companyId: 'company', contactId: 'contact', payload: { Type: 'ACCREC',
      Status: 'DRAFT', CurrencyCode: 'GBP', Contact: { ContactID: 'contact' },
      LineItems: [{ UnitAmount: 120 }] } };
  } });
  assert.equal(result.payment, null);
  assert.equal(result.invoice.envelope.payload.Status, 'AUTHORISED');
  assert.equal(result.invoice.envelope.payload.LineItems[0].UnitAmount, 100);
  assert.equal(result.invoice.envelope.expected.totalMinor, 12000);
});

test('cart accounting stays frozen on every line and TBC reference has no recovery suffix', async () => {
  for (const reference of ['TBC', 'PO-42']) {
    const lines = invoiceLines({
      cartTerms: { lines: [{ name: 'Bundle', quantity: 1, taxRateBps: 2000,
        netMinor: 10000, taxMinor: 2000, grossMinor: 12000 },
      { name: 'Product', quantity: 1, taxRateBps: 2000,
        netMinor: 1000, taxMinor: 200, grossMinor: 1200 }] },
      taxOptions: [{ id: 'OUTPUT2', rateBps: 2000 }], accountCode: '201', projectCode: 'Exhibition',
    });
    const row = { tenant_id: 'tenant', source_type: 'form_invoice_order', source_id: 'submission',
      provider: 'xero', company_id: 'company', snapshot: { version: 1, preparation: true, payment: null,
        linkage: { formId: 'form' }, lines,
        invoice: { args: { appTenantId: 'tenant', currency: 'GBP', reference }, totalMinor: 13200, settings: {},
          recoveryUrl: 'https://example.org/portal', dueDate: '2026-12-11', invoiceDate: '2026-11-11' } } };
    const result = await prepareFormInvoiceSource({ row, transport: {} }, { prepare: async args => ({
      companyId: 'company', contactId: 'contact', payload: { Type: 'ACCREC', Reference: args.reference,
        CurrencyCode: 'GBP', Contact: { ContactID: 'contact' }, LineItems: [{ UnitAmount: 132 }] },
    }) });
    const envelope = result.invoice.envelope;
    assert.equal(envelope.payload.Reference, reference);
    assert.equal(envelope.expected.fields.Reference, reference);
    assert.equal(envelope.markerField, 'Url');
    assert.match(envelope.payload.Url, /accountingRequest=/);
    for (const line of envelope.payload.LineItems) {
      assert.equal(line.AccountCode, '201');
      assert.deepEqual(line.Tracking, [{ Name: 'Projects', Option: 'Exhibition' }]);
    }
    assert.deepEqual(envelope.expected.fields.LineItems, envelope.payload.LineItems);
    assert.equal(envelope.expected.totalMinor, 13200);
    assert.equal(result.payment, null);
  }
});
