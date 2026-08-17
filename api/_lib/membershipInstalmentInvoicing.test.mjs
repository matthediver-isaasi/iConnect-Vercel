// Task #3633 — tests for the per-instalment invoicing library and the
// per-instalment branches in gocardlessAccounting / stripeMonthlyCard.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeInvoicingMode,
  agreementInvoicingMode,
  isPerInstalmentAgreement,
  shouldSuppressAnnualInvoice,
  annualInvoiceSuppressionDecision,
  postStripeInstalmentInvoice,
  buildInstalmentOutcomePatch,
  claimableStatuses,
} from './membershipInstalmentInvoicing.js';
import { postDdInstalmentToAccounting } from './gocardlessAccounting.js';
import { resolveDdOffer, buildAgreementSnapshot } from './gocardlessDirectDebit.js';
import { resolveCardMonthlyOffer, buildCardAgreementSnapshot } from './stripeMonthlyCard.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Chainable fake supabase. Each table resolves via a per-table handler
// receiving { op, filters, payload, selected }. update(...).select() resolves
// through the handler too (PostgREST-style: returns { data: [rows] }).
function fakeDb(handlers, log = []) {
  return {
    _log: log,
    from(table) {
      const state = { table, filters: {}, ors: [], ins: [], op: 'select', payload: null, selectAfterWrite: false };
      const chain = {
        select() { if (state.op !== 'select') state.selectAfterWrite = true; return chain; },
        order() { return chain; },
        limit() { return chain; },
        in(col, vals) { state.ins.push({ col, vals }); return chain; },
        or(expr) { state.ors.push(expr); return chain; },
        eq(col, val) { state.filters[col] = val; return chain; },
        update(payload) { state.op = 'update'; state.payload = payload; return chain; },
        insert(payload) { state.op = 'insert'; state.payload = payload; return chain; },
        maybeSingle() { return Promise.resolve(resolve()); },
        single() { return Promise.resolve(resolve()); },
        then(f, r) { return Promise.resolve(resolve()).then(f, r); },
      };
      function resolve() {
        log.push({ table, ...state });
        const h = handlers[table];
        if (!h) return { data: state.selectAfterWrite ? [] : null, error: null };
        return h(state) || { data: state.selectAfterWrite ? [] : null, error: null };
      }
      return chain;
    },
  };
}

const perInstalmentAgreement = (extra = {}) => ({
  id: 'ba_1',
  tenant_id: 't1',
  member_id: 'm1',
  metadata: {
    card: {
      invoicing_mode: 'per_instalment',
      config_id: 'cfg1',
      band_id: null,
      tier_label: 'Standard',
      membership_year: '2026-27',
      currency: 'GBP',
      monthly_amount_minor: 1000,
    },
  },
  ...extra,
});

const contextHandlers = {
  member: () => ({ data: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }, error: null }),
  membership_tier_config: () => ({ data: { id: 'cfg1', pricing_model: 'flat', flat_vat_rate: '20% (VAT on Income)', nominal_code: '4000' }, error: null }),
  system_settings: () => ({ data: null, error: null }),
};

// Provider whose invoice creation records the payment (the happy path).
function fakeProvider(calls, { paymentRecorded = true, applyCalls = [] } = {}) {
  return {
    name: 'xero',
    _applyCalls: applyCalls,
    async createMembershipInvoice(args) {
      calls.push(args);
      return { invoice_id: 'INV-ID-1', invoice_number: 'INV-001', payment_recorded: paymentRecorded };
    },
    async applyStripePaymentToInvoice(args) {
      applyCalls.push(args);
      return { invoice_id: args.invoiceId, invoice_number: 'INV-001', payment_recorded: true, raw: { payment_recorded: true } };
    },
  };
}

// A membership_instalment_invoices handler backed by a single mutable row —
// enforces the UNIQUE key and honours the CAS claim semantics.
function instalmentStore() {
  const store = { row: null };
  store.handler = (state) => {
    if (state.op === 'insert') {
      if (store.row) return { data: null, error: { code: '23505', message: 'duplicate' } };
      store.row = { id: 'row1', ...state.payload };
      return { data: null, error: null };
    }
    if (state.op === 'update') {
      const cas = state.ins.find((i) => i.col === 'accounting_sync_status');
      if (cas && !cas.vals.includes(store.row?.accounting_sync_status)) {
        return { data: state.selectAfterWrite ? [] : null, error: null }; // CAS lost
      }
      Object.assign(store.row, state.payload);
      return { data: state.selectAfterWrite ? [{ ...store.row }] : null, error: null };
    }
    return { data: store.row ? { ...store.row } : null, error: null };
  };
  return store;
}

// ---------------------------------------------------------------------------
// mode helpers
// ---------------------------------------------------------------------------

test('normalizeInvoicingMode defaults to annual', () => {
  assert.equal(normalizeInvoicingMode(undefined), 'annual');
  assert.equal(normalizeInvoicingMode('weird'), 'annual');
  assert.equal(normalizeInvoicingMode('per_instalment'), 'per_instalment');
});

test('agreementInvoicingMode reads dd and card snapshots, defaults annual', () => {
  assert.equal(agreementInvoicingMode({ metadata: { dd: { invoicing_mode: 'per_instalment' } } }), 'per_instalment');
  assert.equal(agreementInvoicingMode({ metadata: { card: { invoicing_mode: 'per_instalment' } } }), 'per_instalment');
  assert.equal(agreementInvoicingMode({ metadata: { dd: {} } }), 'annual');
  assert.equal(agreementInvoicingMode(null), 'annual');
  assert.equal(isPerInstalmentAgreement({ metadata: { dd: { invoicing_mode: 'annual' } } }), false);
});

test('claimableStatuses: posting only reclaimable when stale-reclaiming', () => {
  assert.ok(!claimableStatuses().includes('posting'));
  assert.ok(claimableStatuses({ reclaimStale: true }).includes('posting'));
});

test('buildInstalmentOutcomePatch: posted only when payment recorded', () => {
  const paid = buildInstalmentOutcomePatch({ providerName: 'xero', invoiceId: 'i1', invoiceNumber: 'N1', paymentRecorded: true });
  assert.equal(paid.accounting_sync_status, 'posted');
  assert.equal(paid.xero_invoice_id, 'i1');
  const unpaid = buildInstalmentOutcomePatch({ providerName: 'quickbooks', invoiceId: 'i2', invoiceNumber: 'N2', paymentRecorded: false });
  assert.equal(unpaid.accounting_sync_status, 'invoice_unpaid');
  assert.match(unpaid.accounting_sync_error, /payment not recorded/);
  assert.equal(unpaid.accounting_invoice_id, 'i2', 'linkage kept for the payment-application retry');
});

// ---------------------------------------------------------------------------
// offer + snapshot carry the mode (immutable at consent)
// ---------------------------------------------------------------------------

const ddSim = {
  success: true,
  currency: 'GBP',
  membershipYear: { label: '2026-27', start: '2026-04-01', end: '2027-03-31' },
  config: {
    id: 'cfg1',
    dd_enabled: true,
    pricing_model: 'flat',
    dd_monthly_amount: 10,
    dd_instalment_count: 12,
    dd_activation_rule: 'first_payment',
    dd_first_collection_rule: 'earliest',
    dd_grace_days: 7,
    dd_terms_version: 'v1',
    dd_invoicing_mode: 'per_instalment',
  },
};

test('resolveDdOffer + buildAgreementSnapshot carry per_instalment mode', () => {
  const offer = resolveDdOffer(ddSim);
  assert.equal(offer.invoicingMode, 'per_instalment');
  const snapshot = buildAgreementSnapshot({ offer, simResult: ddSim });
  assert.equal(snapshot.invoicing_mode, 'per_instalment');
});

test('resolveDdOffer defaults mode to annual', () => {
  const sim = { ...ddSim, config: { ...ddSim.config, dd_invoicing_mode: undefined } };
  const offer = resolveDdOffer(sim);
  assert.equal(offer.invoicingMode, 'annual');
  assert.equal(buildAgreementSnapshot({ offer, simResult: sim }).invoicing_mode, 'annual');
});

test('resolveCardMonthlyOffer + snapshot carry the mode', () => {
  const sim = {
    success: true,
    currency: 'GBP',
    config: {
      card_monthly_enabled: true,
      pricing_model: 'flat',
      dd_monthly_amount: 10,
      dd_instalment_count: 12,
      dd_invoicing_mode: 'per_instalment',
    },
  };
  const offer = resolveCardMonthlyOffer(sim);
  assert.equal(offer.invoicingMode, 'per_instalment');
  assert.equal(buildCardAgreementSnapshot({ offer, simResult: sim }).invoicing_mode, 'per_instalment');
  sim.config.dd_invoicing_mode = 'annual';
  assert.equal(resolveCardMonthlyOffer(sim).invoicingMode, 'annual');
});

// ---------------------------------------------------------------------------
// shouldSuppressAnnualInvoice
// ---------------------------------------------------------------------------

test('shouldSuppressAnnualInvoice: true only for per-instalment-linked rows', async () => {
  const db = fakeDb({
    membership_billing_agreements: () => ({ data: perInstalmentAgreement(), error: null }),
  });
  assert.equal(await shouldSuppressAnnualInvoice({ billing_agreement_id: 'ba_1' }, { db }), true);
  assert.equal(await shouldSuppressAnnualInvoice({ billing_agreement_id: null }, { db }), false);
  const annualDb = fakeDb({
    membership_billing_agreements: () => ({ data: { id: 'ba_2', metadata: { dd: { invoicing_mode: 'annual' } } }, error: null }),
  });
  assert.equal(await shouldSuppressAnnualInvoice({ billing_agreement_id: 'ba_2' }, { db: annualDb }), false);
});

test('shouldSuppressAnnualInvoice: FAIL CLOSED — lookup errors and missing agreements THROW (callers must withhold the annual invoice)', async () => {
  // Operational db error → throw, never false (false would raise an annual
  // invoice for a possibly per-instalment member).
  const errDb = fakeDb({
    membership_billing_agreements: () => ({ data: null, error: { code: '57014', message: 'boom' } }),
  });
  await assert.rejects(
    () => shouldSuppressAnnualInvoice({ billing_agreement_id: 'ba_x' }, { db: errDb }),
    /suppression check failed/,
  );
  // Linked agreement row missing → indeterminate → throw.
  const goneDb = fakeDb({
    membership_billing_agreements: () => ({ data: null, error: null }),
  });
  await assert.rejects(
    () => shouldSuppressAnnualInvoice({ billing_agreement_id: 'ba_gone' }, { db: goneDb }),
    /not found/,
  );
});

test('shouldSuppressAnnualInvoice: only explicit pre-migration schema errors preserve legacy behaviour (false)', async () => {
  for (const code of ['42P01', '42703']) {
    const db = fakeDb({
      membership_billing_agreements: () => ({ data: null, error: { code, message: 'relation/column missing' } }),
    });
    assert.equal(await shouldSuppressAnnualInvoice({ billing_agreement_id: 'ba_x' }, { db }), false);
  }
});

test('annualInvoiceSuppressionDecision (public fee path): per-instalment row suppresses; lookup failure suppresses indeterminately; annual row does not', async () => {
  // Linked per-instalment history row → the route must NOT mint an annual invoice.
  const perInstDb = fakeDb({
    membership_billing_agreements: () => ({ data: perInstalmentAgreement(), error: null }),
  });
  assert.deepEqual(
    await annualInvoiceSuppressionDecision({ billing_agreement_id: 'ba_1' }, { db: perInstDb }),
    { suppress: true },
  );
  // Lookup error → fail closed WITHOUT throwing (charge already succeeded).
  const errDb = fakeDb({
    membership_billing_agreements: () => ({ data: null, error: { code: '57014', message: 'boom' } }),
  });
  const failed = await annualInvoiceSuppressionDecision({ billing_agreement_id: 'ba_1' }, { db: errDb });
  assert.equal(failed.suppress, true);
  assert.equal(failed.indeterminate, true);
  assert.match(failed.error, /suppression check failed/);
  // Annual-mode row and unlinked row → invoice proceeds as today.
  const annualDb = fakeDb({
    membership_billing_agreements: () => ({ data: { id: 'ba_2', metadata: { card: { invoicing_mode: 'annual' } } }, error: null }),
  });
  assert.deepEqual(await annualInvoiceSuppressionDecision({ billing_agreement_id: 'ba_2' }, { db: annualDb }), { suppress: false });
  assert.deepEqual(await annualInvoiceSuppressionDecision({ billing_agreement_id: null }, { db: errDb }), { suppress: false });
});

// ---------------------------------------------------------------------------
// GC DD per-instalment posting
// ---------------------------------------------------------------------------

// gocardless_payments handler with CAS claim semantics over one row.
function gcPaymentStore(initial) {
  const store = { row: { ...initial } };
  store.handler = (state) => {
    if (state.op === 'update') {
      if (state.ors.length > 0) {
        // CAS claim: or() encodes null/in(...) — evaluate against the row.
        const status = store.row.accounting_sync_status;
        const expr = state.ors[0];
        const allowed = expr.includes('is.null') && (status == null)
          ? true
          : (expr.match(/in\.\(([^)]*)\)/)?.[1] || '').split(',').includes(status);
        if (!allowed) return { data: state.selectAfterWrite ? [] : null, error: null };
      }
      Object.assign(store.row, state.payload);
      return { data: state.selectAfterWrite ? [{ ...store.row }] : null, error: null };
    }
    return { data: { ...store.row }, error: null };
  };
  return store;
}

const gcAgreement = {
  id: 'ba_1', tenant_id: 't1', member_id: 'm1',
  metadata: { dd: { invoicing_mode: 'per_instalment', config_id: 'cfg1', tier_label: 'Standard', membership_year: '2026-27', currency: 'GBP' } },
};

test('postDdInstalmentToAccounting: per-instalment mode mints a paid invoice with a deterministic idempotency key', async () => {
  const providerCalls = [];
  const store = gcPaymentStore({ id: 'pay_1', accounting_sync_status: null });
  const db = fakeDb({ ...contextHandlers, gocardless_payments: store.handler });
  const outcome = await postDdInstalmentToAccounting({
    agreement: gcAgreement,
    paymentRow: { id: 'pay_1', amount_minor: 1000, gocardless_payment_id: 'PM123', accounting_sync_status: null },
  }, { db, getProvider: async () => fakeProvider(providerCalls) });

  assert.equal(outcome.status, 'posted');
  assert.equal(providerCalls.length, 1);
  const args = providerCalls[0];
  assert.equal(args.finalCost, 10);
  assert.equal(args.markAsPaid, true);
  assert.equal(args.vatRate, '20% (VAT on Income)');
  assert.equal(args.nominalCode, '4000');
  assert.equal(args.organizationName, 'Ada Lovelace');
  assert.equal(args.bankAccountSettingKey, 'xero_gocardless_bank_account_code');
  assert.equal(args.idempotencyKey, 'mii-gc-PM123', 'provider-side idempotency key derived from the payment id');
  assert.equal(args.paymentIdempotencyKey, 'mii-gc-PM123-pay', 'separate deterministic key for the payment request');
  assert.equal(args.strictBankAccount, true, 'GC rail must never fall back to the Stripe bank account');
  assert.equal(store.row.accounting_sync_status, 'posted');
  assert.equal(store.row.accounting_invoice_id, 'INV-ID-1');
  assert.equal(store.row.xero_invoice_number, 'INV-001');
});

test('postDdInstalmentToAccounting: posted row skipped; linked-but-unposted row re-applies payment only (never re-mints)', async () => {
  const createCalls = [];
  const applyCalls = [];
  const provider = fakeProvider(createCalls, { applyCalls });
  const skipped = await postDdInstalmentToAccounting({
    agreement: gcAgreement, paymentRow: { id: 'p1', accounting_sync_status: 'posted' },
  }, { db: fakeDb({}), getProvider: async () => provider });
  assert.equal(skipped.status, 'skipped');

  const store = gcPaymentStore({ id: 'p2', accounting_sync_status: 'invoice_unpaid', accounting_invoice_id: 'INV-OLD' });
  const db = fakeDb({ gocardless_payments: store.handler });
  const repaired = await postDdInstalmentToAccounting({
    agreement: gcAgreement,
    paymentRow: { id: 'p2', accounting_sync_status: 'invoice_unpaid', accounting_invoice_id: 'INV-OLD', amount_minor: 1000, gocardless_payment_id: 'PM1' },
  }, { db, getProvider: async () => provider });
  assert.equal(repaired.status, 'posted');
  assert.equal(createCalls.length, 0, 'no new invoice minted');
  assert.equal(applyCalls.length, 1, 'payment applied to the existing invoice');
  assert.equal(applyCalls[0].invoiceId, 'INV-OLD');
  assert.equal(applyCalls[0].idempotencyKey, 'mii-gc-PM1-pay', 'crash-after-payment retries replay via the same payment key');
  assert.equal(applyCalls[0].strictBankAccount, true);
  assert.equal(store.row.accounting_sync_status, 'posted');
});

test('postDdInstalmentToAccounting: invoice created but payment NOT recorded → invoice_unpaid with linkage (not posted)', async () => {
  const providerCalls = [];
  const store = gcPaymentStore({ id: 'p4', accounting_sync_status: 'failed' });
  const db = fakeDb({ ...contextHandlers, gocardless_payments: store.handler });
  const outcome = await postDdInstalmentToAccounting({
    agreement: gcAgreement,
    paymentRow: { id: 'p4', accounting_sync_status: 'failed', amount_minor: 1000, gocardless_payment_id: 'PM4' },
  }, { db, getProvider: async () => fakeProvider(providerCalls, { paymentRecorded: false }) });
  assert.equal(outcome.status, 'invoice_unpaid');
  assert.equal(store.row.accounting_sync_status, 'invoice_unpaid');
  assert.equal(store.row.accounting_invoice_id, 'INV-ID-1', 'linkage persisted for the payment-application retry');
  assert.match(store.row.accounting_sync_error, /payment not recorded/);
});

test('postDdInstalmentToAccounting: concurrent callers — only the CAS winner talks to the provider', async () => {
  const providerCalls = [];
  const store = gcPaymentStore({ id: 'p5', accounting_sync_status: null });
  const db = fakeDb({ ...contextHandlers, gocardless_payments: store.handler });
  const deps = { db, getProvider: async () => fakeProvider(providerCalls) };
  const paymentRow = { id: 'p5', amount_minor: 1000, gocardless_payment_id: 'PM5' };
  const [a, b] = await Promise.all([
    postDdInstalmentToAccounting({ agreement: gcAgreement, paymentRow }, deps),
    postDdInstalmentToAccounting({ agreement: gcAgreement, paymentRow }, deps),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['posted', 'skipped']);
  assert.equal(providerCalls.length, 1, 'exactly one provider invoice-create call');
});

test('postDdInstalmentToAccounting: stale posting claim only reclaimable with reclaimStale', async () => {
  const providerCalls = [];
  const store = gcPaymentStore({ id: 'p6', accounting_sync_status: 'posting' });
  const db = fakeDb({ ...contextHandlers, gocardless_payments: store.handler });
  const paymentRow = { id: 'p6', amount_minor: 1000, gocardless_payment_id: 'PM6', accounting_sync_status: 'posting' };
  const noReclaim = await postDdInstalmentToAccounting({ agreement: gcAgreement, paymentRow }, { db, getProvider: async () => fakeProvider(providerCalls) });
  assert.equal(noReclaim.status, 'skipped');
  assert.equal(providerCalls.length, 0);
  const reclaimed = await postDdInstalmentToAccounting({ agreement: gcAgreement, paymentRow }, { db, getProvider: async () => fakeProvider(providerCalls), reclaimStale: true });
  assert.equal(reclaimed.status, 'posted');
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].idempotencyKey, 'mii-gc-PM6', 'same key as the crashed attempt — provider dedupes');
  assert.equal(providerCalls[0].paymentIdempotencyKey, 'mii-gc-PM6-pay', 'payment key also replays — crash-after-payment cannot double-pay');
});

test('postDdInstalmentToAccounting: provider failure stamps failed status with error', async () => {
  const store = gcPaymentStore({ id: 'p3', accounting_sync_status: null });
  const db = fakeDb({ ...contextHandlers, gocardless_payments: store.handler });
  const outcome = await postDdInstalmentToAccounting({
    agreement: gcAgreement,
    paymentRow: { id: 'p3', amount_minor: 1000, gocardless_payment_id: 'PM9' },
  }, {
    db,
    getProvider: async () => ({ name: 'xero', async createMembershipInvoice() { throw new Error('xero down'); } }),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(store.row.accounting_sync_status, 'failed');
  assert.match(store.row.accounting_sync_error, /xero down/);
});

// ---------------------------------------------------------------------------
// Stripe per-instalment posting (idempotency store)
// ---------------------------------------------------------------------------

test('postStripeInstalmentInvoice: first attempt inserts claim row, mints invoice with idempotency key, stamps posted', async () => {
  const providerCalls = [];
  const store = instalmentStore();
  const db = fakeDb({ ...contextHandlers, membership_instalment_invoices: store.handler });

  const outcome = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(),
    plan: { id: 'plan1' },
    stripeInvoiceId: 'in_123',
    amountMinor: 1000,
    currency: 'GBP',
  }, { db, getProvider: async () => fakeProvider(providerCalls) });

  assert.equal(outcome.status, 'posted');
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].finalCost, 10);
  assert.equal(providerCalls[0].markAsPaid, true);
  assert.equal(providerCalls[0].idempotencyKey, 'mii-stripe-in_123');
  assert.equal(providerCalls[0].paymentIdempotencyKey, 'mii-stripe-in_123-pay');
  assert.equal(store.row.accounting_sync_status, 'posted');
  assert.equal(store.row.accounting_invoice_id, 'INV-ID-1');
  assert.equal(store.row.external_payment_id, 'in_123');
});

test('postStripeInstalmentInvoice: replay of a posted instalment never re-mints (webhook redelivery / reconcile safe)', async () => {
  const providerCalls = [];
  const store = instalmentStore();
  store.row = { id: 'row1', accounting_sync_status: 'posted', accounting_invoice_id: 'INV-ID-1' };
  const db = fakeDb({ membership_instalment_invoices: store.handler });
  const outcome = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(),
    stripeInvoiceId: 'in_123',
    amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(providerCalls) });
  assert.equal(outcome.status, 'skipped');
  assert.equal(providerCalls.length, 0);
});

test('postStripeInstalmentInvoice: concurrent duplicate deliveries — only one provider create', async () => {
  const providerCalls = [];
  const store = instalmentStore();
  const db = fakeDb({ ...contextHandlers, membership_instalment_invoices: store.handler });
  const deps = { db, getProvider: async () => fakeProvider(providerCalls) };
  const args = { agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_c1', amountMinor: 1000 };
  const [a, b] = await Promise.all([
    postStripeInstalmentInvoice(args, deps),
    postStripeInstalmentInvoice(args, deps),
  ]);
  // Loser hit either the unique-key insert conflict or the CAS (status is
  // 'posting' for the winner) — both surface as skipped, never a 2nd create.
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['posted', 'skipped']);
  assert.equal(providerCalls.length, 1);
});

test('postStripeInstalmentInvoice: failed attempt stamps failed; retry succeeds without duplicating', async () => {
  const store = instalmentStore();
  const db = fakeDb({ ...contextHandlers, membership_instalment_invoices: store.handler });

  const failing = { name: 'xero', async createMembershipInvoice() { throw new Error('provider down'); } };
  const first = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_9', amountMinor: 1000,
  }, { db, getProvider: async () => failing });
  assert.equal(first.status, 'failed');
  assert.equal(store.row.accounting_sync_status, 'failed');
  assert.match(store.row.accounting_sync_error, /provider down/);

  const calls = [];
  const second = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_9', amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(calls) });
  assert.equal(second.status, 'posted');
  assert.equal(calls.length, 1);
  assert.equal(store.row.accounting_sync_status, 'posted');
});

test('postStripeInstalmentInvoice: unpaid invoice → invoice_unpaid; retry applies payment only', async () => {
  const store = instalmentStore();
  const db = fakeDb({ ...contextHandlers, membership_instalment_invoices: store.handler });

  const createCalls = [];
  const first = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_u1', amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(createCalls, { paymentRecorded: false }) });
  assert.equal(first.status, 'invoice_unpaid');
  assert.equal(store.row.accounting_sync_status, 'invoice_unpaid');
  assert.equal(store.row.accounting_invoice_id, 'INV-ID-1');

  const applyCalls = [];
  const retryCreates = [];
  const second = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_u1', amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(retryCreates, { applyCalls }) });
  assert.equal(second.status, 'posted');
  assert.equal(retryCreates.length, 0, 'no second invoice created');
  assert.equal(applyCalls.length, 1, 'payment applied to the existing invoice');
  assert.equal(applyCalls[0].invoiceId, 'INV-ID-1');
  assert.equal(applyCalls[0].idempotencyKey, 'mii-stripe-in_u1-pay', 'payment retry carries the same deterministic key');
  assert.equal(store.row.accounting_sync_status, 'posted');
});

test('postStripeInstalmentInvoice: stale posting row reclaimable only with reclaimStale', async () => {
  const store = instalmentStore();
  store.row = { id: 'row1', accounting_sync_status: 'posting', external_payment_id: 'in_s1' };
  const db = fakeDb({ ...contextHandlers, membership_instalment_invoices: store.handler });
  const calls = [];
  const held = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_s1', amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(calls) });
  assert.equal(held.status, 'skipped');
  assert.equal(calls.length, 0);
  const reclaimed = await postStripeInstalmentInvoice({
    agreement: perInstalmentAgreement(), stripeInvoiceId: 'in_s1', amountMinor: 1000,
  }, { db, getProvider: async () => fakeProvider(calls), reclaimStale: true });
  assert.equal(reclaimed.status, 'posted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, 'mii-stripe-in_s1');
});

test('postStripeInstalmentInvoice: annual-mode agreement is skipped untouched', async () => {
  const outcome = await postStripeInstalmentInvoice({
    agreement: { id: 'ba', tenant_id: 't1', metadata: { card: { invoicing_mode: 'annual' } } },
    stripeInvoiceId: 'in_1',
    amountMinor: 1000,
  }, { db: fakeDb({}), getProvider: async () => { throw new Error('should not be called'); } });
  assert.equal(outcome.status, 'skipped');
});
