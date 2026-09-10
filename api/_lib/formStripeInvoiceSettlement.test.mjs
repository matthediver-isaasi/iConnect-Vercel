import test from 'node:test';
import assert from 'node:assert/strict';

import { settleFormStripeInvoice } from './formStripeInvoiceSettlement.js';
import fs from 'node:fs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const submissionId = '22222222-2222-2222-2222-222222222222';

function fixture(overrides = {}) {
  const submission = {
    id: submissionId,
    tenant_id: tenantId,
    form_id: 'form-1',
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_paid_at: '2027-01-15T12:00:00.000Z',
    payment_reference: 'pi_form_1',
    created_member_id: 'member-1',
    payment_meta: {
      stripe_feature: 'membership',
      membership: { quote: { target: 'member', total_with_vat: 12.34, currency: 'GBP' } },
      membership_result: {
        status: 'created',
        history_id: 'history-1',
        entity_id: 'member-1',
        table: 'member_membership_history',
        invoice_state: 'done',
        settlement_state: 'pending',
        payment_state: 'pending',
        annotation_state: 'pending',
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
      },
    },
    ...overrides,
  };
  const history = {
    id: 'history-1',
    tenant_id: tenantId,
    accounting_provider: 'xero',
    accounting_invoice_id: 'invoice-1',
    accounting_invoice_number: 'INV-1',
    member_id: 'member-1',
    stripe_payment_intent_id: 'pi_form_1',
    billing_agreement_id: null,
    payment_method: 'stripe',
    payment_status: 'paid',
  };
  return { submission, history };
}

function makeDb({ submission, history }) {
  const rpcCalls = [];
  const updateCalls = [];
  return {
    rpcCalls,
    updateCalls,
    from(table) {
      const state = { payload: null };
      const q = {
        select() { return q; },
        update(payload) { state.payload = payload; return q; },
        eq() { return q; },
        maybeSingle() {
          return Promise.resolve({
            data: table === 'form_submission' ? submission : history,
            error: null,
          });
        },
        then(resolve) {
          if (state.payload) updateCalls.push({ table, payload: state.payload });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return q;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === 'link_recovered_form_membership_invoice') {
        history.accounting_invoice_id = args.p_invoice_id;
        history.accounting_invoice_number = args.p_invoice_number;
        history.accounting_provider = args.p_provider;
        submission.payment_meta.membership_result.invoice_state = 'done';
        submission.payment_meta.membership_result.settlement_state = 'pending';
        return { data: { ok: true }, error: null };
      }
      Object.assign(submission.payment_meta.membership_result, args.p_patch);
      return {
        data: { ok: true, membership_result: { ...submission.payment_meta.membership_result } },
        error: null,
      };
    },
  };
}

function succeededIntent(overrides = {}) {
  return {
    paymentIntent: {
      id: 'pi_form_1',
      status: 'succeeded',
      amount_received: 1234,
      currency: 'gbp',
      created: 1_800_000_000,
      metadata: {
        type: 'form_payment',
        tenant_id: tenantId,
        form_id: 'form-1',
        form_submission_id: submissionId,
      },
      ...overrides,
    },
  };
}

test('dry run verifies immutable identity, uses pinned provider, and returns stable plan fields', async () => {
  const rows = fixture();
  const db = makeDb(rows);
  let providerLookup;
  let providerArgs;
  const result = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    expectedAccount: 'Stripe Clearing',
    expectedProviderContext: { xero_tenant_id: 'xero-tenant-1' },
    annotationOnly: true,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async (...args) => {
      providerLookup = args;
      return {
        settleFormStripeInvoice: async (args) => {
          providerArgs = args;
          return {
            settlement_state: 'done',
            payment_recorded: false,
            annotation_recorded: false,
            invoice_id: 'invoice-1',
            invoice_number: 'INV-1',
            balance: 12.34,
            account: 'Stripe Clearing',
          };
        },
      };
    },
  });

  assert.deepEqual(providerLookup, [tenantId, 'xero']);
  assert.equal(providerArgs.dryRun, true);
  assert.equal(providerArgs.expectedAccount, 'Stripe Clearing');
  assert.deepEqual(providerArgs.expectedProviderContext, { xero_tenant_id: 'xero-tenant-1' });
  assert.equal(providerArgs.annotationOnly, true);
  assert.equal(providerArgs.amount, 12.34);
  assert.equal(providerArgs.currency, 'GBP');
  assert.match(providerArgs.operationKey, /invoice-1:pi_form_1$/);
  assert.equal(db.rpcCalls.length, 0, 'dry run must not persist progress');
  assert.deepEqual({
    invoice_id: result.invoice_id,
    invoice_number: result.invoice_number,
    account: result.account,
    balance: result.balance,
  }, {
    invoice_id: 'invoice-1',
    invoice_number: 'INV-1',
    account: 'Stripe Clearing',
    balance: 12.34,
  });
  assert.equal(result.payment.stripe_payment_intent_id, 'pi_form_1');
});

test('metadata and immutable quote mismatch block provider calls', async () => {
  const rows = fixture();
  const db = makeDb(rows);
  let calls = 0;
  await assert.rejects(() => settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    retrievePaymentIntent: async () => succeededIntent({
      metadata: {
        type: 'form_payment',
        tenant_id: tenantId,
        form_id: 'another-form',
        form_submission_id: submissionId,
      },
    }),
    getProvider: async () => {
      calls += 1;
      return {};
    },
  }), /metadata does not match/);
  assert.equal(calls, 0);

  await assert.rejects(() => settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    retrievePaymentIntent: async () => succeededIntent({ amount_received: 1235 }),
    getProvider: async () => {
      calls += 1;
      return {};
    },
  }), /amount\/currency/);
  assert.equal(calls, 0);
});

test('live settlement claims once and persists payment and annotation independently', async () => {
  const rows = fixture();
  const db = makeDb(rows);
  const result = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async () => ({
        settlement_state: 'retry',
        payment_recorded: true,
        annotation_recorded: false,
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
        invoice_id: 'invoice-1',
        balance: 0,
        account: 'Stripe',
        error: 'annotation unavailable',
      }),
    }),
  });

  assert.equal(result.payment_recorded, true);
  assert.equal(result.annotation_recorded, false);
  assert.equal(db.rpcCalls.length, 2);
  assert.equal(db.rpcCalls[0].args.p_patch.settlement_state, 'processing');
  assert.equal(db.rpcCalls[1].args.p_patch.payment_state, 'done');
  assert.equal(db.rpcCalls[1].args.p_patch.annotation_state, 'pending');
  assert.equal(db.rpcCalls[1].args.p_patch.settlement_state, 'retry');
  assert.ok(db.updateCalls.some((call) => call.table === 'member_membership_history'
    && call.payload.accounting_sync_status === 'failed'));
  assert.ok(db.updateCalls.some((call) => call.table === 'form_submission'
    && call.payload.processing_notes.includes('remains paid')));
});

test('default provider resolution is pinned by recorded provider name', () => {
  const source = fs.readFileSync(new URL('./formStripeInvoiceSettlement.js', import.meta.url), 'utf8');
  assert.match(source, /getProvider = \(_tenantId, pinnedProvider\) => getAccountingProviderByName\(pinnedProvider\)/);
});

test('annotation-only repair never schedules a later automatic payment', async () => {
  const rows = fixture();
  delete rows.submission.payment_meta.membership_result.settlement_state;
  const db = makeDb(rows);
  const result = await settleFormStripeInvoice({
    supabase: db, tenantId, submissionId, dryRun: false, annotationOnly: true,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async (args) => {
        assert.equal(args.annotationOnly, true);
        return {
          settlement_state: 'retry', payment_recorded: false, annotation_recorded: true,
          provider_context: { xero_tenant_id: 'xero-tenant-1' }, balance: 12.34,
        };
      },
    }),
  });
  assert.equal(result.annotation_recorded, true);
  assert.equal(result.payment_recorded, false);
  assert.equal(result.settlement_state, 'blocked');
  assert.equal(rows.submission.payment_meta.membership_result.settlement_state, 'blocked');
});

test('legacy missing provider context previews it but execute requires signed confirmation', async () => {
  const rows = fixture();
  delete rows.submission.payment_meta.membership_result.provider_context;
  const db = makeDb(rows);
  const preview = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async () => ({
        settlement_state: 'retry',
        invoice_id: 'invoice-1',
        provider_context: { xero_tenant_id: 'preview-tenant' },
      }),
    }),
  });
  assert.deepEqual(preview.provider_context, { xero_tenant_id: 'preview-tenant' });
  await assert.rejects(() => settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => { throw new Error('must not resolve provider'); },
  }), /requires explicit confirmed provider context/);
});

test('legacy absent state claims against SQL null and stale processing CAS includes claimed_at', async () => {
  const legacyRows = fixture();
  delete legacyRows.submission.payment_meta.membership_result.settlement_state;
  const legacyDb = makeDb(legacyRows);
  await settleFormStripeInvoice({
    supabase: legacyDb,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async () => ({
        settlement_state: 'done', payment_recorded: true, annotation_recorded: true,
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
      }),
    }),
  });
  assert.deepEqual(legacyDb.rpcCalls[0].args.p_expected, { settlement_state: null });

  const staleRows = fixture();
  staleRows.submission.payment_meta.membership_result.settlement_state = 'processing';
  staleRows.submission.payment_meta.membership_result.settlement_claimed_at = '2020-01-01T00:00:00.000Z';
  const staleDb = makeDb(staleRows);
  await settleFormStripeInvoice({
    supabase: staleDb,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async () => ({
        settlement_state: 'done', payment_recorded: true, annotation_recorded: true,
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
      }),
    }),
  });
  assert.deepEqual(staleDb.rpcCalls[0].args.p_expected, {
    settlement_state: 'processing',
    settlement_claimed_at: '2020-01-01T00:00:00.000Z',
  });
});

test('fails closed on mismatched history linkage and monthly agreements', async () => {
  const mutations = [
    (rows) => { rows.submission.payment_meta.membership_result.table = 'organisation_membership_history'; },
    (rows) => { rows.history.stripe_payment_intent_id = 'pi_other'; },
    (rows) => { rows.history.member_id = 'member-other'; },
    (rows) => { rows.history.billing_agreement_id = 'agreement-1'; },
  ];
  for (const mutate of mutations) {
    const rows = fixture();
    mutate(rows);
    let providerCalls = 0;
    await assert.rejects(() => settleFormStripeInvoice({
      supabase: makeDb(rows),
      tenantId,
      submissionId,
      retrievePaymentIntent: async () => succeededIntent(),
      getProvider: async () => {
        providerCalls += 1;
        return {};
      },
    }));
    assert.equal(providerCalls, 0);
  }
});

test('cannot report done when the final progress CAS loses', async () => {
  const rows = fixture();
  const db = makeDb(rows);
  const baseRpc = db.rpc.bind(db);
  let calls = 0;
  db.rpc = async (...args) => {
    calls += 1;
    if (calls === 2) {
      return {
        data: { ok: false, code: 'PROGRESS_CHANGED', membership_result: {} },
        error: null,
      };
    }
    return baseRpc(...args);
  };
  await assert.rejects(() => settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      settleFormStripeInvoice: async () => ({
        settlement_state: 'done', payment_recorded: true, annotation_recorded: true,
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
      }),
    }),
  }), /completed but progress was not persisted/);
});

test('stale ambiguous creation discovers, atomically links, then settles without recreating', async () => {
  const rows = fixture();
  rows.history.accounting_invoice_id = null;
  rows.history.accounting_invoice_number = null;
  rows.submission.payment_meta.membership_result.invoice_state = 'processing';
  rows.submission.payment_meta.membership_result.invoice_claimed_at = '2027-01-15T12:00:01.000Z';
  rows.submission.payment_meta.membership_result.settlement_state = 'waiting_invoice';
  const db = makeDb(rows);
  let discoveries = 0;
  let settlements = 0;
  const result = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      findFormStripeInvoice: async (args) => {
        discoveries += 1;
        assert.equal(args.stripePaymentIntentId, 'pi_form_1');
        return {
          found: true,
          invoice_id: 'recovered-invoice',
          invoice_number: 'INV-RECOVERED',
          provider_context: { xero_tenant_id: 'xero-tenant-1' },
          stripe_payment_intent_id: 'pi_form_1',
          form_submission_id: submissionId,
          member_id: 'member-1',
          amount: 12.34,
          currency: 'GBP',
        };
      },
      settleFormStripeInvoice: async () => {
        settlements += 1;
        return {
          settlement_state: 'done',
          payment_recorded: true,
          annotation_recorded: true,
          provider_context: { xero_tenant_id: 'xero-tenant-1' },
        };
      },
    }),
  });
  assert.equal(discoveries, 1);
  assert.equal(settlements, 1);
  assert.equal(result.invoice_id, 'recovered-invoice');
  assert.ok(db.rpcCalls.some((call) => call.name === 'link_recovered_form_membership_invoice'));
});

test('ambiguous discovery is blocked and never settles or links', async () => {
  const rows = fixture();
  rows.history.accounting_invoice_id = null;
  rows.submission.payment_meta.membership_result.invoice_state = 'processing';
  rows.submission.payment_meta.membership_result.invoice_claimed_at = '2027-01-15T12:00:01.000Z';
  let settlements = 0;
  const db = makeDb(rows);
  const result = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    dryRun: false,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      findFormStripeInvoice: async () => ({ matches: [{}, {}] }),
      settleFormStripeInvoice: async () => { settlements += 1; },
    }),
  });
  assert.equal(result.settlement_state, 'blocked');
  assert.equal(settlements, 0);
  assert.ok(!db.rpcCalls.some((call) => call.name === 'link_recovered_form_membership_invoice'));
});

test('dry-run discovery inspects the found invoice for real account evidence without linking', async () => {
  const rows = fixture();
  rows.history.accounting_invoice_id = null;
  rows.submission.payment_meta.membership_result.invoice_state = 'processing';
  rows.submission.payment_meta.membership_result.invoice_claimed_at = '2027-01-15T12:00:01.000Z';
  const db = makeDb(rows);
  let inspectedInvoice;
  const preview = await settleFormStripeInvoice({
    supabase: db,
    tenantId,
    submissionId,
    retrievePaymentIntent: async () => succeededIntent(),
    getProvider: async () => ({
      findFormStripeInvoice: async () => ({
        invoice_id: 'found-invoice',
        invoice_number: 'INV-FOUND',
        total: 12.34,
        balance: 12.34,
        currency: 'GBP',
        provider_context: { xero_tenant_id: 'xero-tenant-1' },
      }),
      settleFormStripeInvoice: async (args) => {
        inspectedInvoice = args.invoiceId;
        return {
          settlement_state: 'retry',
          invoice_id: args.invoiceId,
          invoice_number: 'INV-FOUND',
          balance: 12.34,
          account: 'Stripe Clearing',
          provider_context: { xero_tenant_id: 'xero-tenant-1' },
        };
      },
    }),
  });
  assert.equal(inspectedInvoice, 'found-invoice');
  assert.equal(preview.account, 'Stripe Clearing');
  assert.equal(preview.balance, 12.34);
  assert.ok(!db.rpcCalls.some((call) => call.name === 'link_recovered_form_membership_invoice'));
});