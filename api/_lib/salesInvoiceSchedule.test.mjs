import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  scheduleLocalDate, scheduleDueDate, scheduleInvoiceLines, dispatchSalesSchedule,
  deliverSalesSchedule, runSalesInvoiceSchedule, salesScheduleEnabled,
} from './salesInvoiceSchedule.js';
import { prepareSalesAccountingEnvelope } from './accountingProductProducer.js';
import { validateAccountingRequestResult } from './accountingRequestProviders.js';
import { salesInvoiceScheduleHandler } from '../cron/sales-invoice-schedule.js';
import { createSalesInvoice, prepareQueuedSalesRequest } from './salesAccounting.js';
import { getAccountingQueueAdapter, assertAccountingSource } from './accountingQueueIntegration.js';

const frozen = { name: 'Deposit', netMinor: 1000, taxMinor: 200, grossMinor: 1200, currency: 'GBP',
  taxRateBps: 2000, taxCode: { provider: 'xero', id: 'OUTPUT2', rateBps: 2000 },
  paymentTerms: { days: 14 }, recipient: { email: 'accepted@example.test', name: 'Accepted Customer' } };
const schedule = { id: 'schedule', tenant_id: 'tenant', sale_id: 'sale', quote_version_id: 'version',
  timezone: 'Europe/London', planned_issue_date: '2026-10-01', snapshot: frozen, status: 'pending' };
function dbFor(tables = {}, rpc = async () => ({ data: true })) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); },
    from(table) {
      const q = { then(resolve) { resolve({ data: tables[table] ?? null }); } };
      for (const method of ['select', 'eq', 'is', 'in', 'order', 'update', 'maybeSingle', 'single']) q[method] = () => q;
      return q;
    } };
}
test('local calendar dates and independent payment terms cross DST and year boundaries', () => {
  assert.equal(scheduleLocalDate('Pacific/Auckland', new Date('2026-12-31T12:00:00Z')), '2027-01-01');
  assert.equal(scheduleLocalDate('America/Los_Angeles', new Date('2026-03-08T07:30:00Z')), '2026-03-07');
  assert.equal(scheduleDueDate('2026-12-31', 14), '2027-01-14');
  assert.equal(scheduleDueDate('2026-03-28', 1), '2026-03-29');
  assert.throws(() => scheduleDueDate('2026-01-01', -1), /terms/);
});
test('automation requires explicit Sales flag and both queue prerequisites', () => {
  const keys = ['SALES_INVOICE_SCHEDULE_ENABLED', 'ACCOUNTING_REQUEST_QUEUE_ENABLED', 'ACCOUNTING_REQUEST_QUEUE_SOURCES'];
  const old = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(salesScheduleEnabled(), false);
    process.env.SALES_INVOICE_SCHEDULE_ENABLED = 'true';
    assert.equal(salesScheduleEnabled(), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED = 'true';
    assert.equal(salesScheduleEnabled(), false);
    process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES = 'sales_invoice_schedule';
    assert.equal(salesScheduleEnabled(), true);
  } finally { keys.forEach((key, index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index]); }
});
test('group lines preserve accepted totals and tax identity; mixed entries reconcile exactly', () => {
  const [line] = scheduleInvoiceLines(frozen);
  assert.equal(line.quoted_unit_price_minor, 1000);
  assert.deepEqual(line.catalogue_snapshot.tax_code, frozen.taxCode);
  assert.equal(line.discount_bps, 0);
  assert.throws(() => scheduleInvoiceLines({ ...frozen, invoiceLines: [{ ...frozen, grossMinor: 1199 }] }), /reconcile/);
});
test('queued ownership survives disabled rollout without consulting providers or rebuilding', async () => {
  const owned = { ...schedule, status: 'queued', accounting_request_id: 'request' };
  const db = dbFor({ sales_invoice_schedule: owned });
  assert.equal(await dispatchSalesSchedule(db, 'tenant', 'schedule', {}, { enabled: () => false }), owned);
  assert.deepEqual(db.calls, []);
});
test('whole-sale direct and durable writers reject scheduled versions before queue resume', async () => {
  const db = dbFor({ sales_commercial_sale: { id: 'sale', quote_version_id: 'version' },
    sales_quote_version: { id: 'version', billing_schedule: { groups: [frozen] } } });
  await assert.rejects(createSalesInvoice(db, 'tenant', { actorId: 'admin' }, 'sale', {}, {
    getAccountingProvider: () => assert.fail('whole-sale provider is forbidden'),
    accountingQueue: { resume: () => assert.fail('whole-sale resume is forbidden') },
  }), { code: 'SALES_SCHEDULE_OWNS_INVOICING' });
});
test('early manual retry and disabled automation cannot enqueue or touch providers', async () => {
  const db = dbFor({ sales_invoice_schedule: { ...schedule, planned_issue_date: '2027-01-01' } });
  await assert.rejects(dispatchSalesSchedule(db, 'tenant', 'schedule', {}, {
    enabled: () => true, now: new Date('2026-10-01T12:00:00Z'),
  }), { code: 'SCHEDULE_NOT_DUE' });
  await assert.rejects(dispatchSalesSchedule(db, 'tenant', 'schedule', {}, { enabled: () => false }), { code: 'SCHEDULE_DISABLED' });
  assert.deepEqual(db.calls, []);
});
test('dispatch freezes actual issue date, independent due date and per-group identity before provider work', async () => {
  const db = dbFor({ sales_invoice_schedule: schedule, sales_quote_version: {
    id: 'version', status: 'accepted', billing_schedule: {}, organisation_snapshot: { id: 'org', name: 'Organisation' },
  } }, async (name, args) => ({ data: name === 'claim_sales_schedule_dispatch'
    ? true : { ...schedule, status: 'queued', command: args.p_snapshot } }));
  const got = await dispatchSalesSchedule(db, 'tenant', 'schedule', {}, {
    enabled: () => true, now: new Date('2026-10-18T12:00:00Z'), getActiveAccountingProvider: async () => 'xero',
    resolveBinding: async () => ({ connectionId: 'connection', companyId: 'company' }),
    buildInvoice: async () => ({ netMinor: 1000, taxMinor: 200, grossMinor: 1200, currency: 'GBP' }),
    prepareEnvelope: () => {},
  });
  assert.equal(got.command.invoice.payload.issueDate, '2026-10-18');
  assert.equal(got.command.invoice.payload.dueDate, '2026-11-01');
  assert.equal(got.command.linkage.scheduleId, 'schedule');
  assert.equal(db.calls[0].name, 'claim_sales_schedule_dispatch');
  assert.equal(db.calls[1].name, 'enqueue_sales_invoice_schedule');
});
test('unaccepted version and absent frozen recipient fail closed before enqueue', async () => {
  for (const [row, version, code] of [
    [schedule, { status: 'issued', billing_schedule: {} }, 'SCHEDULE_NOT_ACCEPTED'],
    [{ ...schedule, snapshot: { ...frozen, recipient: null } }, {}, 'SCHEDULE_RECIPIENT_REQUIRED'],
  ]) {
    const db = dbFor({ sales_invoice_schedule: row, sales_quote_version: version });
    await assert.rejects(dispatchSalesSchedule(db, 'tenant', 'schedule', {}, {
      enabled: () => true, now: new Date('2026-10-18T12:00:00Z'),
    }), { code });
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].name, 'claim_sales_schedule_dispatch');
  }
});
const invoicePayload = provider => ({ customerId: 'customer', currency: 'GBP',
  idempotencyKey: 'schedule-key', netMinor: 1000, taxMinor: 200, grossMinor: 1200,
  issueDate: '2026-10-18', dueDate: '2026-11-01', lines: [{ description: 'Deposit', quantity: '1',
    unitPriceMinor: 1000, discountBps: 0, netMinor: 1000, taxMinor: 200, grossMinor: 1200,
    taxRateBps: 2000, taxCode: provider === 'xero' ? 'OUTPUT2' : 'tax', accountCode: '200', itemId: 'item' }] });
test('explicit audited customer resolution is revalidated against provider candidates without rewriting accepted economics', async () => {
  const db = dbFor({
    sales_invoice_schedule: { customer_resolution: { providerCustomerId: 'chosen' } },
    sales_accounting_customer_mapping: { provider_customer_id: 'chosen' },
  }, async name => ({ data: name === 'claim_sales_accounting_customer_mapping'
    ? { state: 'claimed', mappingId: 'mapping', claimToken: 'token' } : true }));
  const snapshot = { version: 1, preparation: true, payment: null, environment: null,
    invoice: { payload: invoicePayload('xero'), customer: { organisationId: 'org', name: 'Accepted organisation' }, command: {} },
    linkage: { actorId: 'worker' } };
  const before = structuredClone(snapshot);
  const prepared = await prepareQueuedSalesRequest({ row: { provider: 'xero', tenant_id: 'tenant',
    source_type: 'sales_invoice_schedule', source_id: 'schedule', snapshot }, db, transport: {} }, {
    provider: { name: 'xero', findSalesCustomers: async () => [{ id: 'other', name: 'Other' }, { id: 'chosen', name: 'Accepted organisation' }],
      createSalesCustomer: () => assert.fail('must not guess or create a customer') },
  });
  assert.deepEqual(snapshot, before);
  assert.equal(prepared.invoice.envelope.expected.contactId, 'chosen');
  assert.equal(prepared.invoice.envelope.expected.totalMinor, 1200);
});
for (const provider of ['xero', 'quickbooks']) {
  test(`${provider} frozen dates survive envelope creation and readback rejects altered dates`, () => {
    const envelope = prepareSalesAccountingEnvelope({ provider, payload: invoicePayload(provider), environment: 'sandbox' });
    const record = provider === 'xero' ? { ...envelope.payload, InvoiceID: 'invoice', Total: 12,
      SubTotal: 10, TotalTax: 2, Date: '/Date(1792281600000)/', DueDate: '2026-11-01T00:00:00' }
      : { ...envelope.payload, Id: 'invoice', TotalAmt: 12, TxnTaxDetail: { TotalTax: 2 } };
    const row = { provider, snapshot: { invoice: { envelope } } };
    assert.equal(validateAccountingRequestResult(row, 'invoice', record).id, 'invoice');
    assert.throws(() => validateAccountingRequestResult(row, 'invoice', { ...record, DueDate: '2026-11-02' }), /MISMATCH/);
  });
  test(`${provider} schedule uses central fenced writer, provider readback, then atomic source linker`, async () => {
    const envelope = prepareSalesAccountingEnvelope({ provider, payload: invoicePayload(provider), environment: 'sandbox' });
    const row = { id: 'request', tenant_id: 'tenant', provider, company_id: 'company', connection_id: 'connection',
      source_type: 'sales_invoice_schedule', source_id: schedule.id, invoice_status: 'writing',
      snapshot: { invoice: { envelope }, linkage: { scheduleId: schedule.id, saleId: 'sale', quoteVersionId: 'version' } } };
    const owned = { ...schedule, status: 'queued', accounting_request_id: row.id, provider, provider_company_id: 'company' };
    const db = dbFor({ sales_invoice_schedule: owned, sales_quote_version: { status: 'accepted', billing_schedule: {} } },
      async (name, args) => {
        assert.equal(name, 'link_sales_invoice_schedule');
        assert.equal(args.p_request, row.id);
        return { data: { linked: true, linkId: 'link' } };
      });
    const methods = [];
    let fences = 0;
    const adapter = await getAccountingQueueAdapter(row, { beforeRequest: async () => { fences++; } }, {
      db, resolveConnection: async () => ({ tenantId: 'tenant', provider, connectionId: 'connection',
        companyId: 'company', environment: 'sandbox', accessToken: 'mock-only' }),
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        const document = provider === 'xero' ? { ...envelope.payload, InvoiceID: 'invoice',
          Total: 12, SubTotal: 10, TotalTax: 2 } : { ...envelope.payload, Id: 'invoice', TotalAmt: 12, TxnTaxDetail: { TotalTax: 2 } };
        return new Response(JSON.stringify(provider === 'xero' ? { Invoices: [document] } : { Invoice: document }));
      },
    });
    row.invoice_result = await adapter.createInvoice(row);
    row.invoice_status = 'done';
    assert.deepEqual(await adapter.linkSource(row), { linked: true, linkId: 'link' });
    assert.deepEqual(methods, ['POST', 'GET']);
    assert.ok(fences >= 3);
    owned.provider_company_id = 'another-company';
    await assert.rejects(assertAccountingSource({ db, row }), /AUTHORITY_CHANGED/);
  });
}
for (const outcome of [{ success: true, messageId: 'mail-id' }, { success: false, ambiguousEffect: false },
  { success: false, ambiguousEffect: true }]) {
  test(`delivery persists independent ${outcome.success ? 'sent' : outcome.ambiguousEffect ? 'attention' : 'rejected'} evidence`, async () => {
    const row = { ...schedule, status: 'invoiced', provider: 'xero', provider_company_id: 'company', due_date: '2026-11-01' };
    const db = dbFor({ sales_accounting_invoice_link: { provider_invoice_id: 'invoice', provider_invoice_number: 'INV-1',
      provider_invoice_url: 'https://admin.example.test/not-for-recipients' } });
    let sends = 0;
    const got = await deliverSalesSchedule(db, row, {
      resolveBinding: async () => ({ companyId: 'company' }),
      loadBranding: async () => ({ name: 'Tenant Brand' }),
      getProvider: () => ({ fetchInvoicePdf: async () => Buffer.from('%PDF-1.4 test') }),
      send: async message => {
        sends++;
        assert.equal(message.to, frozen.recipient.email);
        assert.ok(message.attachments.length);
        assert.ok(!message.html.includes('admin.example'));
        return outcome;
      },
    });
    assert.equal(sends, 1);
    assert.equal(got.status, outcome.success ? 'sent' : outcome.ambiguousEffect ? 'attention' : 'rejected');
    assert.equal(db.calls[1].args.p_message, outcome.messageId || null);
  });
}
test('lost delivery claim never sends; changed company never sends', async () => {
  const db = dbFor({}, async () => ({ data: false }));
  assert.deepEqual(await deliverSalesSchedule(db, schedule, { send: () => assert.fail('must not send') }), { skipped: true });
  const other = dbFor({ sales_accounting_invoice_link: { provider_invoice_id: 'invoice' } });
  const got = await deliverSalesSchedule(other, { ...schedule, provider: 'xero', provider_company_id: 'original' }, {
    resolveBinding: async () => ({ companyId: 'changed' }), send: () => assert.fail('must not send'),
  });
  assert.equal(got.status, 'rejected');
});
test('a transport exception after send begins is held for review, never a definite rejection', async () => {
  const db = dbFor({ sales_accounting_invoice_link: { provider_invoice_id: 'invoice' } });
  const outcome = await deliverSalesSchedule(db, { ...schedule, provider: 'xero', provider_company_id: 'company' }, {
    resolveBinding: async () => ({ companyId: 'company' }),
    getProvider: () => ({ fetchInvoicePdf: async () => Buffer.from('%PDF-1.4') }),
    loadBranding: async () => ({ name: 'Tenant' }),
    send: async () => { throw new Error('Connection lost after submission'); },
  });
  assert.equal(outcome.status, 'attention');
  assert.equal(db.calls[1].args.p_status, 'attention');
});
test('disabled worker sweeps owned delivery only and never dispatches new invoices', async () => {
  const db = dbFor({}, async (name, args) => {
    if (name === 'due_sales_invoice_schedules') {
      assert.equal(args.p_dispatch, false);
      return { data: [] };
    }
    return { data: {} };
  });
  const counts = await runSalesInvoiceSchedule({ db }, { enabled: () => false });
  assert.equal(counts.enabled, false);
  assert.equal(counts.examined, 0);
});
test('cron rejects unauthenticated requests before scheduling', async () => {
  const handler = salesInvoiceScheduleHandler({ db: {}, secret: 'test-secret', run: () => assert.fail('unauthorized') });
  const res = { setHeader() {}, status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 401);
});
test('migration retains legacy uniqueness and service-only atomic ownership/delivery fencing', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/202610180005_sales_grouped_accounting.sql', import.meta.url), 'utf8');
  for (const text of ['WHERE schedule_id IS NULL', 'WHERE schedule_id IS NOT NULL', 'FOR UPDATE',
    'accounting_request_enqueue', 'delivery_claim_token=p_token', 'FROM PUBLIC,anon,authenticated',
    'Accepted accounting ownership is immutable', 'Interrupted email send']) assert.ok(sql.includes(text), text);
});
