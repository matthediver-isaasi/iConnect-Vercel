import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createMonthlyMembershipRecoveryService,
  MAX_LIST,
} from './monthlyMembershipRecovery.js';
import { processGocardlessEvent } from './gocardlessWebhookProcessor.js';

function fakeDb(seed) {
  const writes = [];
  return {
    writes,
    from(table) {
      let rows = [...(seed[table] || [])];
      let countMode = false;
      const query = {
        select(_fields, options = {}) { countMode = options.count === 'exact'; return query; },
        eq(field, value) { rows = rows.filter((row) => row[field] === value); return query; },
        in(field, values) { rows = rows.filter((row) => values.includes(row[field])); return query; },
        not(field) {
          if (field === 'metadata->>form_submission_id') {
            rows = rows.filter((row) => row.metadata?.form_submission_id != null);
          }
          return query;
        },
        or() {
          rows = rows.filter((row) => (
            (row.provider === 'stripe' && row.metadata?.card?.kind === 'monthly_card')
            || (row.provider === 'gocardless' && row.metadata?.dd?.kind === 'monthly_direct_debit')
          ));
          return query;
        },
        order() { return query; },
        limit(value) { rows = rows.slice(0, value); return query; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        update(value) { writes.push({ table, type: 'update', value }); return query; },
        insert(value) { writes.push({ table, type: 'insert', value }); return query; },
        upsert(value) { writes.push({ table, type: 'upsert', value }); return query; },
        then(resolve) {
          resolve(countMode
            ? { data: null, count: rows.length, error: null }
            : { data: rows, error: null });
        },
      };
      return query;
    },
  };
}

function lifecycleDb(initial) {
  const tables = Object.fromEntries(
    Object.entries(initial).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.op = 'select'; this.payload = null; this.opts = {};
    }
    select() { return this; }
    insert(value) { this.op = 'insert'; this.payload = value; return this; }
    update(value) { this.op = 'update'; this.payload = value; return this; }
    upsert(value, opts) { this.op = 'upsert'; this.payload = value; this.opts = opts || {}; return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    is(key, value) { this.filters.push((row) => row[key] === value); return this; }
    not() { return this; }
    filter() { return this; }
    order() { return this; }
    limit() { return this; }
    rows() { return (tables[this.table] ||= []).filter((row) => this.filters.every((fn) => fn(row))); }
    run() {
      const target = tables[this.table] ||= [];
      if (this.op === 'insert') {
        const values = (Array.isArray(this.payload) ? this.payload : [this.payload])
          .map((row) => ({ id: row.id || crypto.randomUUID(), ...row }));
        target.push(...values); return { data: values, error: null };
      }
      if (this.op === 'update') {
        const values = this.rows(); values.forEach((row) => Object.assign(row, this.payload));
        return { data: values, error: null };
      }
      if (this.op === 'upsert') {
        const keys = String(this.opts.onConflict || '').split(',').filter(Boolean);
        const values = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const value of values) {
          const found = target.find((row) => keys.length && keys.every((key) => row[key] === value[key]));
          if (found) Object.assign(found, value);
          else target.push({ id: value.id || crypto.randomUUID(), ...value });
        }
        return { data: values, error: null };
      }
      return { data: this.rows(), error: null };
    }
    maybeSingle() { const result = this.run(); return Promise.resolve({ ...result, data: result.data[0] || null }); }
    single() { return this.maybeSingle(); }
    then(resolve, reject) { try { resolve(this.run()); } catch (error) { reject(error); } }
  }
  return {
    tables,
    from(table) { return new Query(table); },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

const gcAgreement = {
  id: 'agreement-1',
  tenant_id: 'tenant-a',
  member_id: 'member-1',
  agreement_type: 'member',
  provider: 'gocardless',
  status: 'mandate_pending',
  environment: 'sandbox',
  created_at: '2026-01-01T00:00:00Z',
  gocardless_billing_request_id: 'BRQ_1',
  gocardless_mandate_id: null,
  metadata: {
    form_submission_id: 'submission-1',
    dd: {
      kind: 'monthly_direct_debit',
      activation_rule: 'first_payment',
      invoicing_mode: 'per_instalment',
    },
  },
};
const gcSubmission = {
  id: 'submission-1',
  tenant_id: 'tenant-a',
  payment_provider: 'gocardless_monthly_dd',
  payment_reference: 'BRQ_1',
  payment_meta: {
    monthly_direct_debit: { agreement_id: 'agreement-1', billing_request_id: 'BRQ_1' },
  },
};

test('bounded tenant list excludes provider metadata and member identity', async () => {
  const db = fakeDb({
    membership_billing_agreements: [
      gcAgreement,
      { ...gcAgreement, id: 'other', tenant_id: 'tenant-b' },
    ],
  });
  const service = createMonthlyMembershipRecoveryService({ db });
  const result = await service.list('tenant-a', 5000);
  assert.equal(result.limit, MAX_LIST);
  assert.equal(result.agreements.length, 1);
  assert.equal(result.agreements[0].id, 'agreement-1');
  assert.equal('metadata' in result.agreements[0], false);
  assert.equal('member_id' in result.agreements[0], false);
  assert.equal(db.writes.length, 0);
});

test('list filters unrelated rows before applying its bound and direct preview still resolves active history', async () => {
  const unrelated = Array.from({ length: 60 }, (_, index) => ({
    ...gcAgreement,
    id: `unrelated-${index}`,
    metadata: { form_submission_id: `other-${index}`, dd: { kind: 'one_off' } },
  }));
  const active = { ...gcAgreement, id: 'historical-active', status: 'active' };
  const db = fakeDb({
    membership_billing_agreements: [...unrelated, gcAgreement, active],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [gcSubmission],
  });
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({
      client: {
        getBillingRequest: async () => ({
          id: 'BRQ_1',
          status: 'fulfilled',
          metadata: {
            type: 'form_monthly_direct_debit',
            agreement_id: 'historical-active',
            form_submission_id: 'submission-1',
          },
          links: { mandate_request_mandate: 'MD_1' },
        }),
        getMandate: async () => ({ status: 'reinstated' }),
      },
    }),
  });
  const listed = await service.list('tenant-a', 25);
  assert.equal(listed.agreements.length, 1);
  assert.equal(listed.agreements[0].id, 'agreement-1');

  // Direct-ID lookup is intentionally independent of the pending-list filter.
  db.from = fakeDb({
    membership_billing_agreements: [active],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [{
      ...gcSubmission,
      payment_meta: { monthly_direct_debit: { agreement_id: 'historical-active', billing_request_id: 'BRQ_1' } },
    }],
  }).from;
  const preview = await service.preview('tenant-a', 'historical-active');
  assert.equal(preview.provider.mandateStatus, 'reinstated');
  assert.equal(preview.canResume, true);
  assert.match(preview.confirmationDisclosure, /active or reinstated/);
});

test('posted per-instalment accounting and partial active progress are healthy', async () => {
  const agreement = { ...gcAgreement, status: 'active', gocardless_mandate_id: 'MD_1' };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', amount_minor: 508, currency: 'GBP',
      gocardless_subscription_id: 'SB_1', last_payment_id: 'PM_1', last_payment_status: 'confirmed',
    }],
    member_membership_history: [{
      id: 'history-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', payment_status: 'partial',
    }],
    form_submission: [gcSubmission],
    gocardless_payments: [{
      id: 'mirror-1', plan_id: 'plan-1', status: 'confirmed', accounting_sync_status: 'posted',
    }],
  });
  let processorCalls = 0;
  const client = {
    getBillingRequest: async () => ({
      id: 'BRQ_1', status: 'fulfilled',
      metadata: {
        type: 'form_monthly_direct_debit',
        agreement_id: 'agreement-1',
        form_submission_id: 'submission-1',
      },
      links: { mandate_request_mandate: 'MD_1' },
    }),
    getMandate: async () => ({ status: 'active' }),
    listPayments: async () => [{
      id: 'PM_1', status: 'confirmed', amount: 508, currency: 'GBP',
      links: { mandate: 'MD_1', subscription: 'SB_1' },
    }],
  };
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({ client }),
    processGc: async () => { processorCalls += 1; return { handled: true }; },
  });
  const preview = await service.preview('tenant-a', 'agreement-1');
  assert.equal(preview.local.accountingIncomplete, false);
  assert.equal(preview.canResume, false);
  const result = await service.resume('tenant-a', 'agreement-1', true);
  assert.equal(result.alreadyComplete, true);
  assert.equal(processorCalls, 0);
});

test('missing expected Stripe per-instalment row is an incomplete obligation', async () => {
  const agreement = {
    ...gcAgreement,
    provider: 'stripe',
    status: 'active',
    environment: 'test',
    stripe_checkout_session_id: 'cs_test_1',
    metadata: {
      form_submission_id: 'submission-1',
      card: { kind: 'monthly_card', invoicing_mode: 'per_instalment' },
    },
  };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', instalments_paid: 1,
    }],
    member_membership_history: [{
      id: 'history-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', payment_status: 'partial',
    }],
    form_submission: [{
      id: 'submission-1', tenant_id: 'tenant-a', payment_provider: 'stripe_monthly_card',
      payment_reference: 'cs_test_1',
      payment_meta: { monthly_card: { agreement_id: 'agreement-1', checkout_session_id: 'cs_test_1' } },
    }],
    membership_instalment_invoices: [],
  });
  const service = createMonthlyMembershipRecoveryService({
    db,
    stripeConnection: async () => ({
      client: { checkout: { sessions: { retrieve: async () => ({
        id: 'cs_test_1', status: 'complete', livemode: false, mode: 'subscription',
        subscription: { id: 'sub_1' },
        metadata: {
          kind: 'monthly_card', tenant_id: 'tenant-a',
          agreement_id: 'agreement-1', form_submission_id: 'submission-1',
        },
      }) } } },
      hasMatchingWebhookSecret: true,
    }),
  });
  const preview = await service.preview('tenant-a', 'agreement-1');
  assert.equal(preview.local.accountingIncomplete, true);
  assert.equal(preview.canResume, true);
});

test('GET preview reads provider and local evidence without writes', async () => {
  const db = fakeDb({
    membership_billing_agreements: [gcAgreement],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [gcSubmission],
  });
  let reads = 0;
  const client = {
    getBillingRequest: async () => {
      reads += 1;
      return {
        id: 'BRQ_1',
        status: 'pending_submission',
        metadata: {
          type: 'form_monthly_direct_debit',
          tenant_id: 'tenant-a',
          agreement_id: 'agreement-1',
          form_submission_id: 'submission-1',
        },
        links: {},
      };
    },
  };
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({ client }),
  });
  const result = await service.preview('tenant-a', 'agreement-1');
  assert.equal(reads, 1);
  assert.equal(result.canResume, false);
  assert.equal(result.provider.setupStatus, 'pending_submission');
  assert.equal(db.writes.length, 0);
});

test('POST waiting GoCardless request does not invoke either processor', async () => {
  const db = fakeDb({
    membership_billing_agreements: [gcAgreement],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [gcSubmission],
  });
  let mutations = 0;
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({
      client: {
        getBillingRequest: async () => ({
          id: 'BRQ_1',
          status: 'pending_customer_approval',
          metadata: {
            type: 'form_monthly_direct_debit',
            tenant_id: 'tenant-a',
            agreement_id: 'agreement-1',
            form_submission_id: 'submission-1',
          },
          links: {},
        }),
      },
    }),
    processGc: async () => { mutations += 1; },
  });
  const result = await service.resume('tenant-a', 'agreement-1', true);
  assert.deepEqual(result, {
    resumed: false,
    waiting: true,
    providerStatus: 'pending_customer_approval',
  });
  assert.equal(mutations, 0);
  assert.equal(db.writes.length, 0);
});

test('fulfilled GoCardless request with a waiting mandate remains read-only', async () => {
  const agreement = { ...gcAgreement, gocardless_mandate_id: 'MD_1' };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [gcSubmission],
  });
  let mutations = 0;
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({
      client: {
        getBillingRequest: async () => ({
          id: 'BRQ_1',
          status: 'fulfilled',
          metadata: {
            type: 'form_monthly_direct_debit',
            tenant_id: 'tenant-a',
            agreement_id: 'agreement-1',
            form_submission_id: 'submission-1',
          },
          links: { mandate_request_mandate: 'MD_1' },
        }),
        getMandate: async () => ({ id: 'MD_1', status: 'pending_submission' }),
      },
    }),
    processGc: async () => { mutations += 1; },
  });
  const result = await service.resume('tenant-a', 'agreement-1', true);
  assert.equal(result.waiting, true);
  assert.equal(mutations, 0);
  assert.equal(db.writes.length, 0);
});

test('confirmed Stripe resume re-fetches and invokes existing checkout processor', async () => {
  const agreement = {
    ...gcAgreement,
    provider: 'stripe',
    status: 'payment_setup_required',
    environment: 'test',
    stripe_checkout_session_id: 'cs_test_1',
    metadata: {
      form_submission_id: 'submission-1',
      card: { kind: 'monthly_card', activation_rule: 'first_payment', invoicing_mode: 'annual' },
    },
  };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [{
      id: 'submission-1',
      tenant_id: 'tenant-a',
      payment_provider: 'stripe_monthly_card',
      payment_reference: 'cs_test_1',
      payment_meta: { monthly_card: { agreement_id: 'agreement-1', checkout_session_id: 'cs_test_1' } },
    }],
  });
  let retrieves = 0;
  let event = null;
  let processorBaseUrl = null;
  const session = {
    id: 'cs_test_1',
    status: 'complete',
    livemode: false,
    mode: 'subscription',
    subscription: { id: 'sub_1', status: 'active', latest_invoice: { status: 'paid', paid: true } },
    metadata: {
      kind: 'monthly_card',
      tenant_id: 'tenant-a',
      agreement_id: 'agreement-1',
      form_submission_id: 'submission-1',
    },
  };
  const service = createMonthlyMembershipRecoveryService({
    db,
    stripeConnection: async () => ({
      client: { checkout: { sessions: { retrieve: async () => { retrieves += 1; return session; } } } },
      hasMatchingWebhookSecret: false,
    }),
    resolveTrustedBaseUrl: async () => 'https://tenant.example.org',
    processStripe: async (received, deps) => {
      event = received;
      processorBaseUrl = deps.baseUrl;
      return { handled: true, detail: 'replayed' };
    },
  });
  await service.preview('tenant-a', 'agreement-1');
  const paidPreview = await service.preview('tenant-a', 'agreement-1');
  const result = await service.resume('tenant-a', 'agreement-1', true);
  assert.equal(paidPreview.provider.latestInvoicePaid, true);
  assert.equal(retrieves, 3);
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.data.object.id, 'cs_test_1');
  assert.equal(processorBaseUrl, 'https://tenant.example.org');
  assert.equal(result.resumed, true);
});

test('resume fails closed before processor when trusted tenant URL cannot resolve', async () => {
  const agreement = {
    ...gcAgreement,
    provider: 'stripe',
    status: 'payment_setup_required',
    environment: 'test',
    stripe_checkout_session_id: 'cs_test_1',
    metadata: { form_submission_id: 'submission-1', card: { kind: 'monthly_card' } },
  };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [],
    member_membership_history: [],
    form_submission: [{
      id: 'submission-1', tenant_id: 'tenant-a', payment_provider: 'stripe_monthly_card',
      payment_reference: 'cs_test_1',
      payment_meta: { monthly_card: { agreement_id: 'agreement-1', checkout_session_id: 'cs_test_1' } },
    }],
  });
  let calls = 0;
  const service = createMonthlyMembershipRecoveryService({
    db,
    resolveTrustedBaseUrl: async () => '',
    stripeConnection: async () => ({
      client: { checkout: { sessions: { retrieve: async () => ({
        id: 'cs_test_1', status: 'complete', livemode: false, mode: 'subscription',
        subscription: { id: 'sub_1' },
        metadata: {
          kind: 'monthly_card', tenant_id: 'tenant-a',
          agreement_id: 'agreement-1', form_submission_id: 'submission-1',
        },
      }) } } },
      hasMatchingWebhookSecret: true,
    }),
    processStripe: async () => { calls += 1; return { handled: true }; },
  });
  await assert.rejects(
    service.resume('tenant-a', 'agreement-1', true),
    /trusted canonical tenant URL/,
  );
  assert.equal(calls, 0);
});

test('processor conflict, blocked, retryable, and unhandled outcomes are not reported as success', async () => {
  const agreement = {
    ...gcAgreement,
    provider: 'stripe',
    status: 'payment_setup_required',
    environment: 'test',
    stripe_checkout_session_id: 'cs_test_1',
    metadata: {
      form_submission_id: 'submission-1',
      card: { kind: 'monthly_card' },
    },
  };
  const session = {
    id: 'cs_test_1',
    status: 'complete',
    livemode: false,
    mode: 'subscription',
    subscription: { id: 'sub_1' },
    metadata: {
      kind: 'monthly_card',
      tenant_id: 'tenant-a',
      agreement_id: 'agreement-1',
      form_submission_id: 'submission-1',
    },
  };
  const cases = [
    [{ handled: true, conflict: true, detail: 'membership year already claimed' }, /membership conflict/],
    [{ handled: true, blocked: true, detail: 'form finalization blocked' }, /was blocked/],
    [{ handled: false, retryable: true, detail: 'member pipeline pending' }, /not complete yet/],
    [{ handled: false, retryable: false, detail: 'unsupported final state' }, /was not applied/],
  ];
  for (const [outcome, expected] of cases) {
    const db = fakeDb({
      membership_billing_agreements: [agreement],
      membership_payment_plans: [],
      member_membership_history: [],
      form_submission: [{
        id: 'submission-1',
        tenant_id: 'tenant-a',
        payment_provider: 'stripe_monthly_card',
        payment_reference: 'cs_test_1',
        payment_meta: { monthly_card: { agreement_id: 'agreement-1', checkout_session_id: 'cs_test_1' } },
      }],
    });
    const service = createMonthlyMembershipRecoveryService({
      db,
      stripeConnection: async () => ({
        client: { checkout: { sessions: { retrieve: async () => session } } },
        hasMatchingWebhookSecret: true,
      }),
      processStripe: async () => outcome,
    });
    await assert.rejects(service.resume('tenant-a', 'agreement-1', true), expected);
  }
});

test('active GoCardless agreement replays a verified confirmed plan payment', async () => {
  const agreement = { ...gcAgreement, status: 'first_payment_pending', gocardless_mandate_id: 'MD_1' };
  const plan = {
    id: 'plan-1',
    tenant_id: 'tenant-a',
    billing_agreement_id: 'agreement-1',
    status: 'first_payment_pending',
    amount_minor: 508,
    currency: 'GBP',
    gocardless_subscription_id: 'SB_1',
    last_payment_id: null,
    last_payment_status: null,
  };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [plan],
    member_membership_history: [],
    form_submission: [gcSubmission],
    gocardless_payments: [],
  });
  const events = [];
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({
      client: {
        getBillingRequest: async () => ({
          id: 'BRQ_1',
          status: 'fulfilled',
          metadata: {
            type: 'form_monthly_direct_debit',
            agreement_id: 'agreement-1',
            form_submission_id: 'submission-1',
          },
          links: { mandate_request_mandate: 'MD_1' },
        }),
        getMandate: async () => ({ id: 'MD_1', status: 'active' }),
        listPayments: async () => [{
          id: 'PM_1',
          status: 'confirmed',
          amount: 508,
          currency: 'GBP',
          links: { mandate: 'MD_1', subscription: 'SB_1' },
        }],
      },
    }),
    processGc: async (event) => {
      events.push(event);
      return { handled: true, detail: 'replayed' };
    },
  });
  const result = await service.resume('tenant-a', 'agreement-1', true);
  assert.equal(result.resumed, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].resource_type, 'payments');
  assert.equal(events[1].action, 'confirmed');
  assert.equal(events[1].links.payment, 'PM_1');
});

test('confirmed GC mirror is replayed when membership history obligation is still pending', async () => {
  const agreement = { ...gcAgreement, status: 'first_payment_pending', gocardless_mandate_id: 'MD_1' };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [{
      id: 'plan-1',
      tenant_id: 'tenant-a',
      billing_agreement_id: 'agreement-1',
      status: 'first_payment_pending',
      amount_minor: 508,
      currency: 'GBP',
      gocardless_subscription_id: 'SB_1',
      last_payment_id: 'PM_1',
      last_payment_status: 'confirmed',
    }],
    member_membership_history: [{
      id: 'history-1',
      tenant_id: 'tenant-a',
      billing_agreement_id: 'agreement-1',
      status: 'pending_payment',
      payment_status: 'unpaid',
    }],
    form_submission: [gcSubmission],
    gocardless_payments: [{
      id: 'mirror-1',
      plan_id: 'plan-1',
      status: 'confirmed',
    }],
  });
  const events = [];
  const client = {
    getBillingRequest: async () => ({
      id: 'BRQ_1',
      status: 'fulfilled',
      metadata: {
        type: 'form_monthly_direct_debit',
        agreement_id: 'agreement-1',
        form_submission_id: 'submission-1',
      },
      links: { mandate_request_mandate: 'MD_1' },
    }),
    getMandate: async () => ({ id: 'MD_1', status: 'active' }),
    listPayments: async () => [{
      id: 'PM_1',
      status: 'confirmed',
      amount: 508,
      currency: 'GBP',
      links: { mandate: 'MD_1', subscription: 'SB_1' },
    }],
  };
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({ client }),
    processGc: async (event) => {
      events.push(event);
      return { handled: true };
    },
  });
  await service.resume('tenant-a', 'agreement-1', true);
  assert.equal(events.filter((event) => event.resource_type === 'payments').length, 1);
  assert.equal(events.at(-1).links.payment, 'PM_1');
});

test('paid-out GC evidence replays confirmed before paid-out accounting recovery', async () => {
  const agreement = { ...gcAgreement, status: 'active', gocardless_mandate_id: 'MD_1' };
  const db = fakeDb({
    membership_billing_agreements: [agreement],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', amount_minor: 508, currency: 'GBP',
      gocardless_subscription_id: 'SB_1', last_payment_id: 'PM_1', last_payment_status: 'paid_out',
    }],
    member_membership_history: [{
      id: 'history-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'active', payment_status: 'paid',
    }],
    form_submission: [gcSubmission],
    gocardless_payments: [{
      id: 'mirror-1', plan_id: 'plan-1', status: 'paid_out', accounting_sync_status: null,
    }],
  });
  const client = {
    getBillingRequest: async () => ({
      id: 'BRQ_1', status: 'fulfilled',
      metadata: {
        type: 'form_monthly_direct_debit',
        agreement_id: 'agreement-1',
        form_submission_id: 'submission-1',
      },
      links: { mandate_request_mandate: 'MD_1' },
    }),
    getMandate: async () => ({ status: 'active' }),
    listPayments: async () => [{
      id: 'PM_1', status: 'paid_out', amount: 508, currency: 'GBP',
      links: { mandate: 'MD_1', subscription: 'SB_1' },
    }],
  };
  const actions = [];
  const service = createMonthlyMembershipRecoveryService({
    db,
    gcConnection: async () => ({ client }),
    processGc: async (event) => {
      if (event.resource_type === 'payments') actions.push(event.action);
      return { handled: true };
    },
  });
  await service.resume('tenant-a', 'agreement-1', true);
  assert.deepEqual(actions, ['confirmed', 'paid_out']);
});

test('shared GC lifecycle processor is idempotent when recovery replays confirmed evidence', async () => {
  const db = lifecycleDb({
    membership_billing_agreements: [{
      id: 'agreement-1', tenant_id: 'tenant-a', status: 'first_payment_pending',
    }],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: 'tenant-a', billing_agreement_id: 'agreement-1',
      status: 'first_payment_pending', gocardless_subscription_id: 'SB_1',
      amount_minor: 508, currency: 'GBP', retry_count: 0,
    }],
    gocardless_payments: [{
      id: 'mirror-1', tenant_id: 'tenant-a', plan_id: 'plan-1',
      gocardless_payment_id: 'PM_1', gocardless_subscription_id: 'SB_1',
      amount_minor: 508, currency: 'GBP', status: 'confirmed',
    }],
    membership_payment_status_history: [],
  });
  const gc = {
    getPayment: async () => ({
      id: 'PM_1', status: 'confirmed', amount: 508, currency: 'GBP',
      charge_date: '2026-09-17', links: { subscription: 'SB_1' },
    }),
  };
  const event = {
    id: 'admin-recovery-payment-PM_1',
    resource_type: 'payments',
    action: 'confirmed',
    links: { payment: 'PM_1', subscription: 'SB_1' },
  };
  await processGocardlessEvent(event, { db, gc });
  await processGocardlessEvent(event, { db, gc });
  assert.equal(db.tables.membership_payment_plans.length, 1);
  assert.equal(db.tables.gocardless_payments.length, 1);
  assert.equal(db.tables.membership_payment_plans[0].status, 'active');
  assert.equal(db.tables.membership_payment_status_history.filter(
    (row) => row.entity_type === 'payment_plan' && row.to_status === 'active',
  ).length, 1);
});

test('terminal agreements cannot be resumed', async () => {
  const db = fakeDb({
    membership_billing_agreements: [{ ...gcAgreement, status: 'payment_plan_cancelled' }],
  });
  const service = createMonthlyMembershipRecoveryService({ db });
  await assert.rejects(
    service.resume('tenant-a', 'agreement-1', true),
    /Terminal monthly agreements cannot be resumed/,
  );
});

test('resume requires explicit confirmation and tenant ownership', async () => {
  const db = fakeDb({ membership_billing_agreements: [gcAgreement] });
  const service = createMonthlyMembershipRecoveryService({ db });
  await assert.rejects(service.resume('tenant-a', 'agreement-1', false), /confirmed must be true/);
  await assert.rejects(service.preview('tenant-b', 'agreement-1'), /not found/);
});