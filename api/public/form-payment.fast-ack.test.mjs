import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './form-payment.js';
import {
  canFinalizeStripeMonthlySetupReplay,
  replayMissedStripeMonthlySetup,
} from '../_lib/formPaymentReconciliation.js';

process.env.SUPABASE_URL = 'https://example.supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const tenant = { id: 'tenant-1', slug: 'tenant' };
const form = { id: 'form-1', tenant_id: tenant.id, fields: [] };

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

function fakeDb(row, agreement) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      calls.push({ table, operation: 'select' });
      let operation = 'select';
      let updatePayload = null;
      const chain = {
        select() {
          operation = 'select';
          return chain;
        },
        update(payload) {
          operation = 'update';
          updatePayload = payload;
          calls.push({ table, operation, updatePayload });
          return chain;
        },
        eq() { return chain; },
        in() { return chain; },
        filter() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => {
          if (operation === 'update' && table === 'form_submission') {
            return { data: { ...row, ...updatePayload }, error: null };
          }
          if (table === 'form_submission') return { data: row, error: null };
          if (table === 'form') return { data: form, error: null };
          if (table === 'membership_billing_agreements') return { data: agreement, error: null };
          return { data: null, error: null };
        },
        single: async () => chain.maybeSingle(),
      };
      return chain;
    },
  };
  return db;
}

function request(provider, submissionId) {
  return {
    method: 'POST',
    headers: {},
    body: {
      action: 'confirm',
      submission_id: submissionId,
      acknowledge_setup: true,
    },
  };
}

function monthlyRow(provider) {
  return {
    id: `submission-${provider}`,
    tenant_id: tenant.id,
    form_id: form.id,
    payment_provider: provider,
    payment_status: 'pending',
    payment_meta: {
      access_authorized_at: '2027-01-01T00:00:00.000Z',
      ...(provider === 'gocardless_monthly_dd'
        ? { monthly_direct_debit: { agreement_id: 'agreement-1', billing_request_id: 'BR-1' } }
        : { monthly_card: { agreement_id: 'agreement-1', checkout_session_id: 'cs-1' } }),
    },
    payment_reference: provider === 'gocardless_monthly_dd' ? 'BR-1' : null,
  };
}

function agreement(provider) {
  return {
    id: 'agreement-1',
    tenant_id: tenant.id,
    provider: provider === 'gocardless_monthly_dd' ? 'gocardless' : 'stripe',
    environment: provider === 'gocardless_monthly_dd' ? 'sandbox' : 'test',
    stripe_checkout_session_id: provider === 'stripe_monthly_card' ? 'cs-1' : null,
    gocardless_billing_request_id: provider === 'gocardless_monthly_dd' ? 'BR-1' : null,
    metadata: {
      form_submission_id: provider === 'gocardless_monthly_dd'
        ? 'submission-gocardless_monthly_dd' : 'submission-stripe_monthly_card',
    },
  };
}

test('handler fast-ack acknowledges GoCardless submitted consent without processor or membership work', async () => {
  const row = monthlyRow('gocardless_monthly_dd');
  const db = fakeDb(row, agreement('gocardless_monthly_dd'));
  let processorCalls = 0;
  const response = responseRecorder();
  await handler(request(row.payment_provider, row.id), response, {
    supabase: db,
    tenantData: tenant,
    gocardlessForTenant: async () => ({
      isConfigured: () => true,
      getGocardlessEnvironment: () => 'sandbox',
      getBillingRequest: async () => ({
        id: 'BR-1',
        status: 'fulfilled',
        metadata: {
          type: 'form_monthly_direct_debit',
          form_submission_id: row.id,
          agreement_id: 'agreement-1',
        },
        links: { mandate_request_mandate: 'MD-1' },
      }),
      getMandate: async () => ({ id: 'MD-1', status: 'submitted' }),
    }),
    processGocardlessEvent: async () => {
      processorCalls += 1;
      return { handled: true };
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.provider, 'gocardless');
  assert.equal(response.body.paymentProvider, 'gocardless_monthly_dd');
  assert.equal(response.body.setupVerified, true);
  assert.equal(response.body.paymentSucceeded, false);
  assert.equal(response.body.status, 'finalizing');
  assert.equal(processorCalls, 0);
  assert.deepEqual([...new Set(db.calls.map((call) => call.table))], [
    'form_submission', 'form', 'membership_billing_agreements',
  ]);
});

test('handler fast-ack acknowledges Stripe setup and reports only actual first-charge evidence', async () => {
  const row = monthlyRow('stripe_monthly_card');
  const db = fakeDb(row, agreement('stripe_monthly_card'));
  let processorCalls = 0;
  const response = responseRecorder();
  class StripeMock {
    static session = {
      id: 'cs-1',
      status: 'complete',
      mode: 'subscription',
      livemode: false,
      metadata: {
        kind: 'monthly_card',
        tenant_id: tenant.id,
        agreement_id: 'agreement-1',
        form_submission_id: row.id,
      },
      subscription: {
        id: 'sub-1',
        status: 'active',
        latest_invoice: {
          id: 'in-1',
          status: 'paid',
          paid: true,
          amount_paid: 1200,
          amount_remaining: 0,
        },
      },
    };
    checkout = {
      sessions: {
        retrieve: async () => StripeMock.session,
      },
    };
  }
  await handler(request(row.payment_provider, row.id), response, {
    supabase: db,
    tenantData: tenant,
    getStripeIntegrationCredentials: async () => ({
      secret_key: 'test-key',
      test_secret_key: 'test-key',
    }),
    Stripe: StripeMock,
    processStripeCardPlanEvent: async () => {
      processorCalls += 1;
      return { handled: true };
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.provider, 'stripe');
  assert.equal(response.body.paymentProvider, 'stripe_monthly_card');
  assert.equal(response.body.setupVerified, true);
  assert.equal(response.body.paymentSucceeded, true);
  assert.equal(response.body.status, 'finalizing');
  assert.equal(processorCalls, 0);

  const noChargeRow = monthlyRow('stripe_monthly_card');
  const noChargeDb = fakeDb(noChargeRow, agreement('stripe_monthly_card'));
  const noChargeResponse = responseRecorder();
  StripeMock.session = {
    ...StripeMock.session,
    metadata: { ...StripeMock.session.metadata, form_submission_id: noChargeRow.id },
    subscription: {
      id: 'sub-1',
      status: 'active',
      latest_invoice: { id: 'in-2', status: 'open', paid: false, amount_paid: 0, amount_remaining: 1200 },
    },
  };
  await handler(request(noChargeRow.payment_provider, noChargeRow.id), noChargeResponse, {
    supabase: noChargeDb,
    tenantData: tenant,
    getStripeIntegrationCredentials: async () => ({
      secret_key: 'test-key',
      test_secret_key: 'test-key',
    }),
    Stripe: StripeMock,
    processStripeCardPlanEvent: async () => {
      processorCalls += 1;
      return { handled: true };
    },
  });
  assert.equal(noChargeResponse.body.setupVerified, true);
  assert.equal(noChargeResponse.body.paymentSucceeded, false);
  assert.equal(noChargeResponse.body.status, 'finalizing');
  assert.equal(processorCalls, 0);

  // A stale paid row must not take the one-off early return when the browser
  // explicitly requests the monthly setup acknowledgement.
  StripeMock.session = {
    ...StripeMock.session,
    metadata: { ...StripeMock.session.metadata, form_submission_id: row.id },
    subscription: {
      id: 'sub-1',
      status: 'active',
      latest_invoice: {
        id: 'in-1',
        status: 'paid',
        paid: true,
        amount_paid: 1200,
        amount_remaining: 0,
      },
    },
  };
  const paidRow = { ...row, payment_status: 'paid' };
  const paidDb = fakeDb(paidRow, agreement('stripe_monthly_card'));
  const paidResponse = responseRecorder();
  await handler(request(paidRow.payment_provider, paidRow.id), paidResponse, {
    supabase: paidDb,
    tenantData: tenant,
    getStripeIntegrationCredentials: async () => ({
      secret_key: 'test-key',
      test_secret_key: 'test-key',
    }),
    Stripe: StripeMock,
    processStripeCardPlanEvent: async () => {
      processorCalls += 1;
      return { handled: true };
    },
  });
  assert.equal(paidResponse.statusCode, 200);
  assert.equal(paidResponse.body.setupVerified, true);
  assert.equal(paidResponse.body.status, 'finalizing');
  assert.equal(processorCalls, 0);
});

test('Stripe setup-complete recovery never finalizes after identity mismatch or cancellation', async () => {
  const row = monthlyRow('stripe_monthly_card');
  const linkedAgreement = agreement('stripe_monthly_card');
  const baseSession = {
    id: 'cs-1',
    status: 'complete',
    mode: 'subscription',
    livemode: false,
    metadata: {
      kind: 'monthly_card',
      tenant_id: tenant.id,
      agreement_id: linkedAgreement.id,
      form_submission_id: row.id,
    },
    subscription: { id: 'sub-1', status: 'active' },
  };
  let processorCalls = 0;
  class StripeMock {
    static session = baseSession;
    checkout = {
      sessions: {
        retrieve: async () => StripeMock.session,
      },
    };
  }
  const deps = {
    db: {},
    row,
    agreement: linkedAgreement,
    baseUrl: '',
    deadlineAt: Date.now() + 30_000,
    getCredentials: async () => ({ test_secret_key: 'test-key' }),
    StripeClass: StripeMock,
    processEvent: async () => {
      processorCalls += 1;
      return { handled: true };
    },
  };

  StripeMock.session = {
    ...baseSession,
    metadata: { ...baseSession.metadata, agreement_id: 'other-agreement' },
  };
  const mismatched = await replayMissedStripeMonthlySetup(deps);
  assert.equal(mismatched.handled, false);
  assert.equal(canFinalizeStripeMonthlySetupReplay(mismatched), false);
  assert.equal(processorCalls, 0);

  StripeMock.session = {
    ...baseSession,
    subscription: { id: 'sub-1', status: 'canceled' },
  };
  const canceled = await replayMissedStripeMonthlySetup(deps);
  assert.equal(canceled.handled, false);
  assert.equal(canFinalizeStripeMonthlySetupReplay(canceled), false);
  assert.equal(processorCalls, 0);

  linkedAgreement.status = 'expired';
  StripeMock.session = baseSession;
  const inactiveAgreement = await replayMissedStripeMonthlySetup(deps);
  assert.equal(inactiveAgreement.handled, false);
  assert.equal(canFinalizeStripeMonthlySetupReplay(inactiveAgreement), false);
  assert.equal(processorCalls, 0);
  linkedAgreement.status = undefined;

  StripeMock.session = {
    ...baseSession,
    subscription: {
      id: 'sub-1',
      status: 'active',
      latest_invoice: { id: 'in-1', status: 'paid', refunded: true },
    },
  };
  const refunded = await replayMissedStripeMonthlySetup(deps);
  assert.equal(refunded.handled, false);
  assert.equal(canFinalizeStripeMonthlySetupReplay(refunded), false);
  assert.equal(processorCalls, 0);

  StripeMock.session = baseSession;
  const verified = await replayMissedStripeMonthlySetup(deps);
  assert.equal(verified.handled, true);
  assert.equal(canFinalizeStripeMonthlySetupReplay(verified), true);
  assert.equal(processorCalls, 1);
});