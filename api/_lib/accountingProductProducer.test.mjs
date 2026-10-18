import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSalesAccountingEnvelope, productAccountingQueueEnabled } from './accountingProductProducer.js';
import { createSalesInvoice } from './salesAccounting.js';

const invoice = () => ({
  customerId: 'customer', currency: 'GBP', netMinor: 1000, taxMinor: 200, grossMinor: 1200,
  idempotencyKey: 'original-sale-claim', purchaseOrderReference: 'PO-1',
  lines: [{ description: 'Accepted item', quantity: '2.5', unitPriceMinor: 500,
    netMinor: 1000, taxMinor: 200, grossMinor: 1200, discountBps: 2000,
    taxRateBps: 2000, taxCode: 'TAX', itemId: 'item', accountCode: '200' }],
});
for (const provider of ['xero', 'quickbooks']) {
  test(`${provider} preparation preserves the accepted economic snapshot and original claim`, () => {
    const payload = invoice();
    const before = structuredClone(payload);
    const envelope = prepareSalesAccountingEnvelope({ provider, payload, environment: 'sandbox' });
    assert.deepEqual(payload, before);
    assert.equal(envelope.operationKey, payload.idempotencyKey);
    assert.equal(envelope.expected.totalMinor, 1200);
    assert.equal(envelope.expected.contactId, 'customer');
    assert.ok(Object.isFrozen(envelope.payload));
    payload.lines[0].description = 'Edited catalogue';
    assert.equal(provider === 'xero' ? envelope.payload.LineItems[0].Description : envelope.payload.Line[0].Description, 'Accepted item');
    assert.equal(provider === 'xero' ? envelope.payload.LineItems[0].UnitAmount : envelope.payload.Line[0].SalesItemLineDetail.UnitPrice, 4);
    assert.equal(provider === 'xero' ? envelope.expected.fields.TotalTax : envelope.expected.fields.TxnTaxDetail.TotalTax, 2);
  });
}
test('preparation rejects missing claim authority and unsupported providers', () => {
  const payload = invoice();
  payload.idempotencyKey = null;
  assert.throws(() => prepareSalesAccountingEnvelope({ provider: 'xero', payload }), /INVALID_ENVELOPE/);
  assert.throws(() => prepareSalesAccountingEnvelope({ provider: 'other', payload }), /Unsupported/);
});

test('product rollout requires shared switch and explicit supported source opt-in', () => {
  const previous = { enabled: process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED, sources: process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES };
  try {
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'true';
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = 'training_fund_purchase, sales_commercial_sale';
    assert.equal(productAccountingQueueEnabled('sales_commercial_sale'), true);
    assert.equal(productAccountingQueueEnabled('training_fund_purchase'), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = '';
    assert.equal(productAccountingQueueEnabled('sales_commercial_sale'), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'false';
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = 'sales_commercial_sale';
    assert.equal(productAccountingQueueEnabled('sales_commercial_sale'), false);
  } finally {
    for (const [key, value] of Object.entries({
      ACCOUNTING_REQUEST_QUEUE_ENABLED: previous.enabled, ACCOUNTING_REQUEST_QUEUE_SOURCES: previous.sources,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

function legacyAuthorityDb() {
  return { from(table) {
    assert.ok(['sales_commercial_sale', 'sales_quote_version'].includes(table), 'only immutable ownership classification may be read before resume');
    const query = { select() { return query; }, eq() { return query; },
      async maybeSingle() { return { data: table === 'sales_commercial_sale'
        ? { id: 'sale', quote_version_id: 'version' } : { id: 'version', billing_schedule: null } }; } };
    return query;
  }, rpc() { throw new Error('Unexpected claim'); } };
}
test('accepted pending sale checks scheduled ownership then resumes without economics reads, new claim or direct writer', async () => {
  const db = legacyAuthorityDb();
  let resumes = 0;
  await assert.rejects(createSalesInvoice(db, 'tenant', { actorId: 'actor' }, 'sale', {}, {
    getAccountingProvider() { throw new Error('Unexpected provider lookup'); },
    accountingQueue: {
      enabled: () => true,
      async resume(args) {
        resumes++;
        assert.equal(args.sourceId, 'sale');
        return { accounting_pending: true, accounting_request_id: 'request', accounting_state: 'unknown' };
      },
    },
  }), error => error.code === 'ACCOUNTING_REQUEST_PENDING' && error.accountingAccepted
    && error.details.requestId === 'request');
  assert.equal(resumes, 1);
});

test('OFF sale still resumes an accepted durable owner without any legacy writer or live catalogue read', async () => {
  let lookup;
  await assert.rejects(createSalesInvoice(legacyAuthorityDb(), 'tenant', { actorId: 'actor' }, 'sale', {}, {
    getAccountingProvider() { throw new Error('Legacy fallback forbidden'); },
    accountingQueue: {
      enabled: () => false,
      resume: async args => {
        lookup = args;
        return { accounting_pending: true, accounting_request_id: 'existing-request', accounting_state: 'unknown' };
      },
    },
  }), error => error.code === 'ACCOUNTING_REQUEST_PENDING' && error.details.requestId === 'existing-request');
  assert.equal(lookup.allowMissingQueue, true);
});

test('OFF ownership lookup failure is not permission to use legacy writer', async () => {
  const failure = new Error('ACCOUNTING_QUEUE_LOOKUP_FAILED');
  await assert.rejects(createSalesInvoice(legacyAuthorityDb(), 'tenant', { actorId: 'actor' }, 'sale', {}, {
    getAccountingProvider() { throw new Error('Legacy fallback forbidden'); },
    accountingQueue: { enabled: () => false, resume: async () => { throw failure; } },
  }), error => error === failure);
});

test('fresh OFF source and missing-table OFF install retain legacy path; other DB errors fail closed', async () => {
  for (const lookupError of [null, { code: '42P01' }, { code: '42501' }, { code: '57014' }]) {
    let providerReads = 0;
    const db = {
      from(table) {
        const query = {
          select() { return query; }, eq() { return query; }, is() { return query; },
          async maybeSingle() {
            if (table === 'accounting_request_queue') return { data: null, error: lookupError };
            if (table === 'sales_commercial_sale') return { data: { id: 'sale', quote_version_id: 'version' } };
            if (table === 'sales_quote_version') return { data: { id: 'version', billing_schedule: null } };
            assert.equal(table, 'sales_accounting_invoice_link');
            return { data: { id: 'link', provider: 'xero', provider_invoice_id: 'invoice' }, error: null };
          },
        };
        return query;
      },
    };
    const { resumeAccountingSource } = await import('./accountingQueueIntegration.js');
    const run = () => createSalesInvoice(db, 'tenant', { actorId: 'actor' }, 'sale', {}, {
      getAccountingProvider: async () => { providerReads++; return { name: 'xero' }; },
      accountingQueue: { enabled: () => false, resume: resumeAccountingSource },
    });
    if (lookupError && lookupError.code !== '42P01') {
      await assert.rejects(run(), /ACCOUNTING_QUEUE_LOOKUP_FAILED/);
      assert.equal(providerReads, 0);
    } else {
      const result = await run();
      assert.equal(result.existing, true);
      assert.equal(result.invoice.invoiceId, 'invoice');
      assert.equal(providerReads, 1);
    }
  }
});

for (const providerName of ['xero', 'quickbooks']) {
  test(`${providerName} enabled sales enqueues immutable economics using original claim, never direct invoice writer`, async () => {
    const writes = [];
    const version = { id: 'version', status: 'accepted', currency: 'GBP',
      organisation_snapshot: { id: 'org', name: 'Buyer' }, net_minor: 1000, tax_minor: 200, gross_minor: 1200 };
    const line = { description: 'Accepted item', quantity: '2', quoted_unit_price_minor: 500,
      discount_bps: 0, tax_rate_bps: 2000, net_minor: 1000, tax_minor: 200, gross_minor: 1200 };
    const records = {
      sales_commercial_sale: { id: 'sale', quote_version_id: 'version' },
      sales_quote_version: version, sales_quote_line: [line],
      sales_accounting_tax_mapping: [{ tax_rate_bps: 2000, provider_tax_code: 'TAX' }],
      system_settings: { setting_value: providerName === 'xero' ? '200' : 'item' },
    };
    const db = {
      from(table) {
        const result = () => ({ data: records[table] || null, error: null });
        const query = {
          select() { return query; }, eq() { return query; }, is() { return query; }, in() { return query; }, order() { return query; },
          update(value) { writes.push({ table, value }); return query; },
          async maybeSingle() { return result(); },
          then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
        };
        return query;
      },
      async rpc(name) {
        if (name === 'claim_sales_accounting_invoice_attempt') return { data: {
          state: 'claimed', attemptId: 'attempt', providerIdempotencyKey: 'original-claim',
        }, error: null };
        if (name === 'claim_sales_accounting_customer_mapping') throw new Error('Customer lookup before enqueue forbidden');
        throw new Error('Unexpected RPC');
      },
    };
    let submitted;
    await assert.rejects(createSalesInvoice(db, 'tenant', { actorId: 'actor' }, 'sale', {}, {
      getAccountingProvider: async () => ({ name: providerName,
        createSalesInvoice() { throw new Error('Direct writer forbidden'); } }),
      accountingQueue: {
        enabled: () => true, resume: async () => null,
        resolveBinding: async () => ({ connectionId: 'connection', companyId: 'company', environment: 'sandbox' }),
        submitUnprepared: async args => {
          submitted = args;
          return { accounting_pending: true, accounting_request_id: 'request', accounting_state: 'pending' };
        },
      },
    }), error => error.code === 'ACCOUNTING_REQUEST_PENDING');
    assert.equal(submitted.snapshot.preparation, true);
    assert.equal(submitted.snapshot.invoice.payload.idempotencyKey, 'original-claim');
    assert.equal(submitted.snapshot.invoice.payload.grossMinor, 1200);
    assert.deepEqual(submitted.snapshot.linkage, { saleId: 'sale', quoteVersionId: 'version', attemptId: 'attempt', actorId: 'actor' });
    assert.equal(submitted.snapshot.payment, null);
    assert.equal(writes.length, 0, 'accepted claim must not be failed or source deleted');
  });
}