import test from 'node:test';
import assert from 'node:assert/strict';
import { processEventInvoiceRecovery, reconcileEventInvoices, validRecoveryTaxIntent, validRecoverySnapshot } from './eventInvoiceRecovery.js';
import { createEventInvoiceRecoveryXero } from './eventInvoiceRecoveryXero.js';

function fixture({ taxKey = 'EXEMPTOUTPUT', rate = 0, inclusive = false, stripe = false, credit = false, throttle = false } = {}) {
  const calls = [], journal = [];
  let authority = null, providerInvoice = null, providerPayment = null;
  const snapshot = {
    version: 1, provider: { connectionId: 'connection', xeroTenantId: 'org' },
    taxResolution: { version: 1, kind: 'future_checkout_provider_tax', capturedAt: '2026-10-02T10:00:00Z' },
    contact: { name: 'Purchaser' }, currency: 'GBP', amount: credit ? 80 : 100, paymentMethod: stripe ? 'stripe' : 'invoice',
    settlement: stripe ? { paymentIntentId: 'pi_123', status: 'succeeded', livemode: true, amount: credit ? 80 : 100,
      currency: 'GBP', paidAt: '2026-10-02T10:00:00Z', accountCode: '090' } : null,
    invoice: { Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', Contact: { Name: 'Purchaser' },
      Date: '2026-10-02', DueDate: '2026-11-01', LineAmountTypes: inclusive ? 'Inclusive' : 'Exclusive',
      LineItems: [{ Description: 'Ticket', Quantity: 2, UnitAmount: 50, AccountCode: '200', ...(taxKey ? { TaxType: taxKey } : {}) },
        ...(credit ? [{ Description: 'Voucher', Quantity: 1, UnitAmount: -20, AccountCode: '200' }] : [])] },
  };
  const row = { id: 'job', tenant_id: 'tenant-a', source: 'booking', booking_group_reference: 'group',
    lease_token: 'lease', attempts: 1, snapshot };
  const db = {
    from(table) {
      const filters = {};
      return { select() { return this; }, eq(key, value) { filters[key] = value; return this; },
        async maybeSingle() {
          assert.equal(filters[table === 'xero_token' ? 'app_tenant_id' : 'tenant_id'], 'tenant-a');
          return { data: table === 'tenant_accounting_settings' ? { active_provider: 'xero' }
            : table === 'tenant_integrations' ? { is_enabled: true }
              : { id: 'connection', tenant_id: 'org', access_token: 'fixture-only', expires_at: new Date(Date.now() + 3600000).toISOString() } };
        } };
    },
    async rpc(name, args) {
      journal.push([name, args]);
      if (name.endsWith('_claim')) return { data: structuredClone(row) };
      if (name.endsWith('_tax_authority')) {
        if (args.p_resolved) authority = structuredClone(args.p_resolved);
        return { data: authority };
      }
      return { data: true };
    },
  };
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.headers['xero-tenant-id'], 'org');
    if (url.endsWith('/TaxRates') && throttle) return { status: 429, ok: false, headers: { get: () => '600' } };
    let body;
    if (url.endsWith('/Accounts')) body = { Accounts: [{ AccountID: 'account', Code: '200', Status: 'ACTIVE', TaxType: taxKey || 'NONE' }] };
    else if (url.endsWith('/TaxRates')) body = { TaxRates: [{ TaxType: taxKey || 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: rate }] };
    else if (url.includes('/Accounts?')) body = { Accounts: [{ Code: '090', Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }] };
    else if (url.endsWith('/Invoices') && init.method === 'POST') {
      providerInvoice = { ...JSON.parse(init.body).Invoices[0], InvoiceID: 'invoice', InvoiceNumber: 'INV-123', Total: snapshot.amount,
        AmountPaid: 0, AmountDue: snapshot.amount };
      providerInvoice.LineItems = providerInvoice.LineItems.map(line => ({ ...line, LineAmount: line.Quantity * line.UnitAmount }));
      body = { Invoices: [providerInvoice] };
    } else if (url.includes('/Invoices?')) {
      body = { Invoices: new URL(url).searchParams.get('page') === '1' && providerInvoice ? [providerInvoice] : [] };
    } else if (url.endsWith('/Payments') && init.method === 'PUT') {
      providerPayment = { ...JSON.parse(init.body).Payments[0], PaymentID: 'payment', Status: 'AUTHORISED' };
      body = { Payments: [providerPayment] };
    } else if (url.includes('/Payments?')) body = { Payments: providerPayment ? [providerPayment] : [] };
    else throw new Error(`Unexpected provider access: ${url}`);
    return { status: 200, ok: true, json: async () => body };
  };
  const factory = options => createEventInvoiceRecoveryXero({ ...options, fetchImpl });
  return { snapshot, row, db, calls, journal, factory, authority: () => authority };
}

for (const taxKey of ['EXEMPTOUTPUT', 'NONE', null]) {
  for (const stripe of [false, true]) test(`legacy no-tax ${taxKey || 'account default'}; ${stripe ? 'Stripe' : 'account'} with credits`, async () => {
    const f = fixture({ taxKey, stripe, credit: true });
    const original = structuredClone(f.snapshot);
    assert.equal(validRecoveryTaxIntent(f.snapshot), true);
    const adapter = await f.factory({ db: f.db, row: f.row, identity: 'identity', guard: async () => {}, deadlineAt: Date.now() + 30000 });
    const resolved = await adapter.resolveTaxIntent();
    assert.equal(validRecoverySnapshot(resolved), true);
    assert.equal(resolved.amount, 80);
    assert.deepEqual(f.snapshot, original);
    assert.ok(resolved.invoice.LineItems.every(line => line.TaxAmount === 0));
  });
}

test('tax 429 uses persisted shared cooldown before any invoice write and retries resolution', async () => {
  const f = fixture({ throttle: true });
  assert.deepEqual(await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory, random: () => 0 }), { status: 'retry' });
  const finish = f.journal.find(([name]) => name.endsWith('_finish'))[1];
  assert.equal(finish.p_reason, 'provider_rate_limited');
  assert.ok(Date.parse(finish.p_cooldown) >= Date.now() + 899000);
  assert.equal(finish.p_rejected_write, null);
  assert.equal(f.authority(), null);
  assert.ok(!f.journal.some(([name]) => name.endsWith('_start_write')));
  await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory });
  assert.equal(f.calls.filter(([url]) => url.endsWith('/TaxRates')).length, 2);
});

test('positive Exclusive VAT never silently reinterprets the checkout charge', async () => {
  const f = fixture({ taxKey: 'OUTPUT2', rate: 20, stripe: true });
  assert.deepEqual(await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory }), { status: 'needs_review' });
  assert.equal(f.journal.at(-1)[1].p_reason, 'tax_total_requires_review');
  assert.equal(f.snapshot.amount, 100);
  assert.equal(f.authority(), null);
  assert.ok(!f.journal.some(([name]) => name.endsWith('_start_write')));
});

test('explicit Inclusive keeps original charge and credit amounts', async () => {
  const f = fixture({ taxKey: 'OUTPUT2', rate: 20, inclusive: true, credit: true, stripe: true });
  const adapter = await f.factory({ db: f.db, row: f.row, guard: async () => {}, deadlineAt: Date.now() + 30000 });
  const resolved = await adapter.resolveTaxIntent();
  assert.equal(validRecoverySnapshot(resolved), true);
  assert.deepEqual(resolved.invoice.LineItems.map(line => line.UnitAmount), [50, -20]);
  assert.deepEqual(resolved.invoice.LineItems.map(line => line.TaxAmount), [16.67, -3.33]);
});

test('unresolved authority never permits resolution after an ambiguous write', async () => {
  const f = fixture();
  f.row.invoice_write_started_at = '2026-10-02T11:00:00Z';
  assert.deepEqual(await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory }), { status: 'needs_review' });
  assert.equal(f.calls.length, 0);
});

for (const stripe of [false, true]) test(`worker resolves, persists, writes and replays without duplicate ${stripe ? 'Stripe settlement' : 'account invoice'}`, async () => {
  const f = fixture({ stripe, credit: true });
  const original = structuredClone(f.snapshot);
  assert.deepEqual(await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory }), { status: 'complete' });
  assert.ok(f.authority()?.resolvedTaxEvidence);
  assert.deepEqual(f.snapshot, original);
  const persistedAt = f.journal.findIndex(([name, args]) => name.endsWith('_tax_authority') && args.p_resolved);
  const writtenAt = f.journal.findIndex(([name]) => name.endsWith('_start_write'));
  assert.ok(persistedAt >= 0 && writtenAt > persistedAt);
  assert.deepEqual(await processEventInvoiceRecovery({ db: f.db, providerFactory: f.factory }), { status: 'complete' });
  assert.equal(f.calls.filter(([url]) => url.endsWith('/TaxRates')).length, 1);
  assert.equal(f.calls.filter(([url, init]) => url.endsWith('/Invoices') && init.method === 'POST').length, 1);
  assert.equal(f.calls.filter(([url, init]) => url.endsWith('/Payments') && init.method === 'PUT').length, stripe ? 1 : 0);
});

test('future runner never discovers or reconstructs historical bookings by default', async () => {
  const calls = [];
  const db = { async rpc(name) { calls.push(name); return { data: name.endsWith('_claim') ? null : true }; } };
  assert.deepEqual(await reconcileEventInvoices({ db }), { swept: 0, hydrated: 0, complete: 0, retry: 0, needs_review: 0 });
  assert.ok(!calls.some(name => /sweep|historical|automatic_candidates/.test(name)));
});

test('new worker explicitly opts into tax intent claims for targeted and cron calls', async () => {
  for (const scope of [{}, { tenantId: 'tenant-a', source: 'booking', bookingGroupReference: 'group' }]) {
    const calls = [];
    const db = { async rpc(name, args) { calls.push([name, args]); return { data: null }; } };
    assert.deepEqual(await processEventInvoiceRecovery({ db, ...scope }), { status: 'idle' });
    assert.deepEqual(calls, [['event_invoice_recovery_claim', {
      p_tenant_id: scope.tenantId || null, p_source: scope.source || null,
      p_group: scope.bookingGroupReference || null, p_tax_resolution: true,
    }]]);
  }
});

test('percentage discount remains a discount, not a changed price or charge', async () => {
  const f = fixture({ inclusive: true, taxKey: 'OUTPUT2', rate: 20 });
  f.snapshot.invoice.LineItems[0].DiscountRate = 20;
  f.snapshot.amount = 80;
  const adapter = await f.factory({ db: f.db, row: f.row, guard: async () => {}, deadlineAt: Date.now() + 30000 });
  const resolved = await adapter.resolveTaxIntent();
  assert.equal(validRecoverySnapshot(resolved), true);
  assert.equal(resolved.invoice.LineItems[0].UnitAmount, 50);
  assert.equal(resolved.invoice.LineItems[0].DiscountRate, 20);
  assert.equal(resolved.invoice.LineItems[0].TaxAmount, 13.33);
});