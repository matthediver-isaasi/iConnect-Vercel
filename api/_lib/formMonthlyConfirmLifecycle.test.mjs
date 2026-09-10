import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyConfirmLifecycle,
  verifiedStripeMonthlyCollection,
} from './formMonthlyConfirmLifecycle.js';

const paidSession = {
  mode: 'subscription',
  livemode: false,
  subscription: { id: 'sub-1' },
  metadata: {
    kind: 'monthly_card',
    tenant_id: 'tenant-1',
    agreement_id: 'agreement-1',
    form_submission_id: 'submission-1',
  },
};

const collectionArgs = {
  session: paidSession,
  invoice: {
    id: 'invoice-1',
    status: 'paid',
    paid: true,
    amount_paid: 508,
    amount_remaining: 0,
  },
  tenantId: 'tenant-1',
  agreementId: 'agreement-1',
  submissionId: 'submission-1',
  environment: 'test',
};

test('Stripe setup completion never claims that payment succeeded', () => {
  const result = monthlyConfirmLifecycle({
    provider: 'stripe',
    stage: 'setup_complete',
    submissionId: 'sub-1',
  });
  assert.deepEqual(result, {
    success: true,
    pending: false,
    provider: 'stripe',
    submissionId: 'sub-1',
    status: 'setup_complete',
    paymentSucceeded: false,
  });
});

test('verified Stripe collection is distinct from setup and accounting pending remains actionable', () => {
  const result = monthlyConfirmLifecycle({
    provider: 'stripe',
    stage: 'accounting_pending',
    submissionId: 'sub-2',
    paymentVerified: true,
    detail: 'Invoice posting will retry.',
  });
  assert.equal(result.success, false);
  assert.equal(result.pending, true);
  assert.equal(result.status, 'accounting_pending');
  assert.equal(result.paymentSucceeded, true);
  assert.equal(result.retryable, true);
  assert.match(result.message, /accounting is still being completed/i);
});

test('provider and finalizing stage survive a monthly response without DD claims on Stripe', () => {
  const result = monthlyConfirmLifecycle({
    provider: 'stripe',
    stage: 'finalizing',
    submissionId: 'sub-3',
    paymentVerified: true,
    detail: 'Application processing is incomplete.',
  });
  assert.equal(result.provider, 'stripe');
  assert.equal(result.status, 'finalizing');
  assert.equal(result.paymentSucceeded, true);
  assert.equal(result.pending, true);
  assert.doesNotMatch(result.message, /application processing/i);
  assert.doesNotMatch(result.message, /direct debit/i);
});

test('blocked outcome is terminal and sanitizes unbounded internal detail', () => {
  const result = monthlyConfirmLifecycle({
    provider: 'gocardless',
    stage: 'blocked',
    submissionId: 'sub-4',
    detail: 'x'.repeat(301),
    code: 'MEMBERSHIP_CONFLICT',
  });
  assert.equal(result.success, false);
  assert.equal(result.pending, false);
  assert.equal(result.provider, 'gocardless');
  assert.equal(result.status, 'blocked');
  assert.equal(result.paymentSucceeded, false);
  assert.equal(result.code, 'MEMBERSHIP_CONFLICT');
  assert.match(result.error, /existing membership/i);
});

test('unknown lifecycle input fails closed without inventing a provider', () => {
  const result = monthlyConfirmLifecycle({
    provider: 'client-supplied-provider',
    stage: 'provider-private-state',
    submissionId: 'sub-5',
  });
  assert.equal(result.provider, null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.paymentSucceeded, false);
});

test('positive fully-settled invoice on the verified subscription checkout is collection evidence', () => {
  assert.equal(verifiedStripeMonthlyCollection(collectionArgs), true);
});

test('zero-value paid setup invoice is never collection evidence', () => {
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    invoice: { ...collectionArgs.invoice, amount_paid: 0 },
  }), false);
});

test('remaining balance and non-paid invoices are not collection evidence', () => {
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    invoice: { ...collectionArgs.invoice, amount_remaining: 1 },
  }), false);
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    invoice: { ...collectionArgs.invoice, status: 'open', paid: false },
  }), false);
});

test('collection evidence fails closed on subscription identity or mode mismatch', () => {
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    session: { ...paidSession, mode: 'payment' },
  }), false);
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    session: {
      ...paidSession,
      metadata: { ...paidSession.metadata, agreement_id: 'another-agreement' },
    },
  }), false);
  assert.equal(verifiedStripeMonthlyCollection({
    ...collectionArgs,
    session: { ...paidSession, livemode: true },
  }), false);
});