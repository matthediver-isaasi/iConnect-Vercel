import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeHistoricalInvoice, verifyHistoricalInvoice, refreshHistoricalInvoiceStatuses, historicalStatusBatches } from './historicalInvoiceStatusRefresh.js';

const ID = '11111111-1111-4111-8111-111111111111';
const row = { id: ID, tenant_id: 'app-tenant', record_kind: 'invoice',
  xero_company_id: 'company', xero_document_id: null, xero_document_type: null,
  invoice_number: 'INV-123', invoice_date: '2020-01-01', amount_minor: 12000,
  currency: 'GBP', status: 'imported unpaid', accounting_status_failures: 0,
  accounting_status_next_check_at: '2026-01-01T00:15:00.000Z' };
const invoice = { InvoiceID: ID, InvoiceNumber: 'INV-123', Type: 'ACCREC',
  Date: '/Date(1577836800000+0000)/', Total: 120, CurrencyCode: 'GBP',
  AmountDue: 0, AmountPaid: 120, AmountCredited: 0, Status: 'PAID' };

function transport(documents = [invoice], company = 'company', status = 200) {
  const calls = [];
  return {
    calls, getToken: async tenant => {
      assert.equal(tenant, 'app-tenant');
      return { accessToken: 'unit-test-only', tenantId: company };
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['xero-tenant-id'], 'company');
      return { ok: status === 200, status, json: async () => ({ Invoices: documents }) };
    },
  };
}

function database(rows, affected) {
  const writes = [];
  let writeBatches = 0;
  return {
    writes,
    get writeBatches() { return writeBatches; },
    rpc: async (name, args) => {
      if (name === 'claim_historical_invoice_status_refresh') {
        assert.deepEqual(args, { p_limit: 1000 });
        return { data: rows };
      }
      assert.equal(name, 'apply_historical_invoice_status_batch');
      assert.ok(args.p_updates.length <= 100);
      writeBatches++;
      writes.push(...args.p_updates);
      return { data: affected ?? args.p_updates.length };
    },
  };
}

test('exact signed amount, date, number, company, receivable type and cached identity required', async () => {
  assert.equal(verifyHistoricalInvoice(row, invoice).accounting_payment_status, 'paid');
  for (const change of [
    { Total: -120 }, { InvoiceNumber: 'INV-123 ' }, { Type: 'ACCPAY' },
    { Date: '/Date(1577923200000)/' }, { CurrencyCode: 'USD' },
    { InvoiceID: 'bad-id' }, { AmountDue: 1 }, { Status: 'UNKNOWN' },
    { Total: 120.001 }, { Status: 'AUTHORISED', AmountDue: 120 },
  ]) assert.throws(() => verifyHistoricalInvoice(row, { ...invoice, ...change }));
  assert.throws(() => verifyHistoricalInvoice({ ...row, xero_document_id: '22222222-2222-4222-8222-222222222222' }, invoice));
  const deps = transport([invoice], 'other-company');
  await assert.rejects(observeHistoricalInvoice(row, deps), /organisation differs/);
  assert.equal(deps.calls.length, 0);
});

test('only one exact invoice; unsupported credit/overpayment never call provider', async () => {
  for (const kind of ['credit', 'overpayment']) {
    const deps = transport();
    await assert.rejects(observeHistoricalInvoice({ ...row, record_kind: kind }, deps), /Unsupported/);
    assert.equal(deps.calls.length, 0);
  }
  for (const docs of [[], [invoice, invoice], [{ ...invoice, InvoiceNumber: 'different' }]]) {
    await assert.rejects(observeHistoricalInvoice(row, transport(docs)));
  }
  const deps = transport();
  await observeHistoricalInvoice({ ...row, xero_document_id: ID, xero_document_type: 'Invoices' }, deps);
  assert.equal(new URL(deps.calls[0].url).searchParams.get('IDs'), ID);
  assert.equal(new URL(deps.calls[0].url).searchParams.get('pageSize'), '100');
  assert.equal(deps.calls.length, 1); // no fallback from cached reference
});

test('paid, partial, unpaid and voided are metadata observations, not source status', () => {
  for (const [change, expected] of [
    [{}, 'paid'],
    [{ Status: 'AUTHORISED', AmountDue: 60, AmountPaid: 60 }, 'partial'],
    [{ Status: 'AUTHORISED', AmountDue: 120, AmountPaid: 0 }, 'unpaid'],
    [{ Status: 'VOIDED', AmountPaid: 0 }, 'voided'],
  ]) assert.equal(verifyHistoricalInvoice(row, { ...invoice, ...change }).accounting_payment_status, expected);
});

test('success updates only metadata with identity/lease CAS; preserves source status', async () => {
  const db = database([row]);
  const summary = await refreshHistoricalInvoiceStatuses(db, { ...transport(), now: () => 0 });
  assert.equal(summary.refreshed, 1);
  const { patch, expected } = db.writes[0];
  assert.equal(patch.accounting_status, 'PAID');
  assert.equal(patch.status, undefined);
  assert.equal(patch.accounting_status_next_check_at, '1970-01-01T21:00:00.000Z');
  for (const field of ['tenant_id', 'xero_company_id', 'invoice_number', 'invoice_date',
    'amount_minor', 'accounting_status_next_check_at', 'xero_document_id', 'xero_document_type', 'currency']) {
    assert.ok(Object.hasOwn(expected, field), field);
  }
  const raced = await refreshHistoricalInvoiceStatuses(database([row], 0), { ...transport(), now: () => 0 });
  assert.equal(raced.conflicts, 1);
});

test('errors retain last verified status and binding; persist exponential retry', async () => {
  const db = database([{ ...row, accounting_status_failures: 2 }]);
  const summary = await refreshHistoricalInvoiceStatuses(db, { ...transport([]), now: () => 0 });
  assert.equal(summary.errors, 1);
  const patch = db.writes[0].patch;
  assert.match(patch.accounting_status_error, /missing or ambiguous/);
  assert.equal(patch.accounting_status_next_check_at, '1970-01-01T08:00:00.000Z');
  for (const field of ['status', 'accounting_status', 'accounting_payment_status', 'accounting_status_checked_at', 'xero_document_id']) {
    assert.equal(Object.hasOwn(patch, field), false);
  }
});

test('429 defers remaining tenant; time budget defers leased rows; DB errors surface', async () => {
  const deps = transport([], 'company', 429);
  const db = database(Array.from({ length: 100 }, (_, i) => ({ ...row, id: `record-${i}` })));
  const summary = await refreshHistoricalInvoiceStatuses(db, { ...deps, now: () => 0 });
  assert.equal(summary.errors, 99);
  assert.equal(summary.deferred, 1);
  assert.equal(deps.calls.length, 1);
  let tick = 0;
  const timed = await refreshHistoricalInvoiceStatuses(database([row]), {
    ...transport(), now: () => tick++ === 0 ? 0 : 19000,
  });
  assert.equal(timed.deferred, 1);
  await assert.rejects(refreshHistoricalInvoiceStatuses({
    rpc: async () => ({ error: { message: 'missing migration' } }),
  }), /missing migration/);
});

test('durable queue is capped, fair, leased and service-only; cron never reconciles archive rows', () => {
  const sql = readFileSync('supabase/migrations/20261203_historical_invoice_status_refresh.sql', 'utf8');
  assert.match(sql, /PARTITION BY tenant_id ORDER BY/);
  assert.match(sql, /accounting_status_checked_at <= now\(\) - interval '21 hours'/);
  assert.match(sql, /r.position <= 1000/);
  assert.match(sql, /least\(coalesce\(p_limit, 1000\), 1000\)/);
  assert.match(sql, /SKIP LOCKED/);
  assert.match(sql, /interval '15 minutes'/);
  assert.match(sql, /record_kind = 'invoice'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  const source = readFileSync('api/_lib/historicalInvoiceStatusRefresh.js', 'utf8');
  assert.doesNotMatch(source, /import .*membershipPaymentReconciliation|\.from\('(?!historical_member_invoice)/);
});

test('7086 first sweep fits eight 3-hour ticks; 1000 rows use 11 GETs and 11 metadata writes under 18s', async () => {
  const all = Array.from({ length: 7086 }, (_, index) => ({
    ...row, id: `record-${index}`, invoice_number: `INV-${index}`,
  }));
  let elapsed = 0;
  let gets = 0;
  let tokens = 0;
  let ticks = 0;
  let refreshed = 0;
  for (let offset = 0; offset < all.length; offset += 1000) {
    ticks++;
    elapsed = 0;
    const db = database(all.slice(offset, offset + 1000));
    const rpc = db.rpc;
    db.rpc = async (...args) => { elapsed += 100; return rpc(...args); };
    const before = gets;
    const result = await refreshHistoricalInvoiceStatuses(db, {
      now: () => elapsed,
      sleep: async ms => { elapsed += ms; },
      getToken: async () => { tokens++; elapsed += 100; return { tenantId: 'company', accessToken: 'unit-test-only' }; },
      fetch: async url => {
        gets++; elapsed += 150;
        const params = new URL(url).searchParams;
        assert.equal(params.get('where'), 'Type=="ACCREC"');
        assert.equal(params.get('page'), '1');
        assert.equal(params.get('pageSize'), '100');
        const numbers = params.get('InvoiceNumbers').split(',');
        assert.ok(numbers.length <= 99);
        return { ok: true, status: 200, json: async () => ({
          Invoices: numbers.map(InvoiceNumber => ({ ...invoice, InvoiceNumber })),
          pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: numbers.length },
        }) };
      },
    });
    refreshed += result.refreshed;
    assert.equal(result.errors, 0);
    assert.equal(result.deferred, 0);
    assert.ok(elapsed <= 18000);
    if (offset === 0) {
      assert.equal(gets - before, 11);
      assert.equal(db.writes.length, 1000);
      assert.equal(db.writeBatches, 11);
    }
  }
  assert.equal(refreshed, 7086);
  assert.equal(ticks, 8);
  assert.equal(tokens, 8); // once per tenant per run, not once per invoice
});

test('batch tenant round robin, bound IDs separate, URL size bound and completeness rejection', async () => {
  const rows = [
    ...Array.from({ length: 200 }, () => row),
    { ...row, tenant_id: 'other-tenant' },
    { ...row, xero_document_id: ID, xero_document_type: 'Invoices' },
  ];
  const batches = historicalStatusBatches(rows);
  assert.equal(batches[0][0].tenant_id, 'app-tenant');
  assert.equal(batches[1][0].tenant_id, 'other-tenant');
  assert.ok(batches.every(batch => batch.length <= 99));
  const long = historicalStatusBatches(Array.from({ length: 100 }, () => ({ ...row, invoice_number: 'a'.repeat(255) })));
  assert.ok(long.every(batch => batch.length <= 21));
  await assert.rejects(observeHistoricalInvoice(row, transport(Array(100).fill(invoice))), /incomplete/);
  const deps = transport();
  deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    Invoices: [invoice], pagination: { pageCount: 2, itemCount: 101 },
  }) });
  await assert.rejects(observeHistoricalInvoice(row, deps), /incomplete/);
});

test('unsettled observations are scheduled sooner than settled archival invoices', async () => {
  const db = database([row]);
  await refreshHistoricalInvoiceStatuses(db, {
    ...transport([{ ...invoice, Status: 'AUTHORISED', AmountPaid: 0, AmountDue: 120 }]), now: () => 0,
  });
  assert.equal(db.writes[0].patch.accounting_status_next_check_at, '1970-01-01T03:00:00.000Z');
});

test('one invalid CSV number cannot poison its otherwise valid provider batch', async () => {
  const db = database([row, { ...row, id: 'invalid', invoice_number: 'INV,ambiguous' }]);
  const deps = transport();
  const result = await refreshHistoricalInvoiceStatuses(db, { ...deps, now: () => 0 });
  assert.equal(result.refreshed, 1);
  assert.equal(result.errors, 1);
  assert.equal(deps.calls.length, 1);
  assert.equal(new URL(deps.calls[0].url).searchParams.get('InvoiceNumbers'), 'INV-123');
  assert.equal(db.writes.find(write => write.expected.id === 'invalid').patch.xero_document_id, undefined);
});
