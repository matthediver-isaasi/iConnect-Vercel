import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFormSubmissionPaymentReview,
  getSafeProcessingNoteDetails,
  isConfirmedUnpaidInvoiceSubmission,
  isVisibleFormSubmission,
} from './formSubmissionPaymentReview.js';

test('review metadata makes pending and failed submissions visible with safe reasons', () => {
  const pending = {
    payment_status: 'pending',
    payment_meta: {
      gc_reconciliation: {
        status: 'blocked',
        requires_review: true,
        reason: 'origin_account_mismatch',
        account_fingerprint: 'must-not-leak',
        provider_body: { access_token: 'must-not-leak' },
      },
    },
  };
  const failed = {
    payment_status: 'failed',
    payment_meta: {
      membership_result: {
        status: 'blocked',
        integrity_state: 'blocked',
        integrity_error_code: 'MEMBERSHIP_PROCESSOR_TARGET_MISSING',
      },
    },
  };

  assert.equal(isVisibleFormSubmission(pending), true);
  assert.equal(isVisibleFormSubmission(failed), true);
  assert.deepEqual(getFormSubmissionPaymentReview(pending), {
    source: 'gocardless',
    reason: 'The Direct Debit belongs to a different provider account and cannot be verified safely.',
    blocksRerun: true,
  });
  assert.equal(getFormSubmissionPaymentReview(failed).reason,
    'The membership record expected from processing could not be found.');
  assert.doesNotMatch(JSON.stringify(getFormSubmissionPaymentReview(pending)), /fingerprint|provider_body|access_token/);
});

test('normal unpaid submissions remain hidden', () => {
  assert.equal(isVisibleFormSubmission({ payment_status: 'pending' }), false);
  assert.equal(isVisibleFormSubmission({ payment_status: 'failed', payment_meta: {} }), false);
});

test('accepted invoice orders are visible before accounting or payment completes', () => {
  const order = {
    payment_provider: 'invoice', payment_status: 'unpaid', status: 'new',
    payment_meta: { invoice_order: { version: 1 } },
    submission_data: { __cart_receipt: { lines: [] } },
  };
  const before = structuredClone(order);
  assert.equal(isConfirmedUnpaidInvoiceSubmission(order), true);
  assert.equal(isVisibleFormSubmission(order), true);
  // Ordinary invoice forms share the same accepted-order contract.
  assert.equal(isVisibleFormSubmission({ ...order, submission_data: {} }), true);
  assert.deepEqual(order, before);
  assert.equal(isVisibleFormSubmission({ ...order, payment_status: 'paid' }), true);
  assert.equal(isConfirmedUnpaidInvoiceSubmission({ ...order, payment_status: 'paid' }), false);
});

test('invoice visibility requires server acceptance and does not expose unfinished card attempts', () => {
  for (const submission of [
    { payment_provider: 'invoice', payment_status: 'unpaid' },
    { payment_provider: 'invoice', payment_status: 'unpaid', payment_meta: { invoice_order: { version: 2 } } },
    ...['pending', 'failed', 'cancelled', 'setup_complete'].map(payment_status => ({
      payment_provider: 'invoice', payment_status, payment_meta: { invoice_order: { version: 1 } },
    })),
    ...['pending', 'failed', 'unpaid'].map(payment_status => ({
      payment_provider: 'stripe', payment_status, payment_meta: { invoice_order: { version: 1 } },
    })),
  ]) {
    assert.equal(isConfirmedUnpaidInvoiceSubmission(submission), false);
    assert.equal(isVisibleFormSubmission(submission), false);
  }
});

test('review state does not fabricate payment status and paid remains paid', () => {
  const paid = {
    payment_status: 'paid',
    payment_meta: {
      membership_result: {
        settlement_state: 'blocked',
        integrity_error_code: 'MEMBERSHIP_ENTITY_TENANT_INVALID',
      },
    },
  };
  const failed = {
    payment_status: 'failed',
    payment_meta: {
      gc_reconciliation: { status: 'blocked', reason: 'provider_lookup_unavailable' },
    },
  };

  assert.equal(isVisibleFormSubmission(paid), true);
  assert.equal(isVisibleFormSubmission(failed), true);
  assert.equal(paid.payment_status, 'paid');
  assert.equal(failed.payment_status, 'failed');
  assert.equal(getFormSubmissionPaymentReview(paid).blocksRerun, true);
});

test('processing-note projection preserves useful diagnostics and recursively removes secrets', () => {
  const details = getSafeProcessingNoteDetails({
    level: 'warn',
    kind: 'relationship',
    message: 'A safe explanation',
    action: 'link_existing',
    relationship: {
      source_id: 'member-1',
      account_fingerprint: 'must-not-leak',
      nested: {
        provider_payload: { customer: 'must-not-leak' },
        result: 'not_linked',
      },
    },
    credentials: { access_token: 'must-not-leak' },
    payment_meta: { gc_provider_context: { account_fingerprint: 'must-not-leak' } },
  });

  assert.deepEqual(details, {
    action: 'link_existing',
    relationship: {
      source_id: 'member-1',
      nested: { result: 'not_linked' },
    },
  });
  assert.doesNotMatch(JSON.stringify(details), /must-not-leak|fingerprint|credential|provider_payload|payment_meta/);
});

test('blocked membership states explain representative link, processor, accounting, and payment failures', () => {
  const reasonFor = (integrity_error_code) => getFormSubmissionPaymentReview({
    payment_status: 'paid',
    payment_meta: {
      membership_result: { status: 'blocked', integrity_state: 'blocked', integrity_error_code },
    },
  }).reason;

  assert.equal(
    reasonFor('MEMBERSHIP_AUTHORITATIVE_LINK_MISSING'),
    'The member or organisation created by this submission could not be linked safely.',
  );
  assert.equal(
    reasonFor('MEMBERSHIP_PROCESSOR_LINK_MISMATCH'),
    'The application processor returned a different member or organisation from the one linked to this submission.',
  );
  assert.equal(
    reasonFor('MEMBERSHIP_ACCOUNTING_CONTEXT_MISMATCH'),
    'The membership invoice belongs to a different accounting account.',
  );
  assert.equal(
    reasonFor('MEMBERSHIP_PAYMENT_AMOUNT_MISMATCH'),
    'The confirmed payment amount does not match the membership amount.',
  );
});