import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionCheckoutText } from './formSubmissionCheckout.js';

test('checkout uses recorded method and status even with absent field answers', () => {
  const submission = { payment_provider: 'invoice', payment_status: 'unpaid', submission_data: {} };
  assert.equal(submissionCheckoutText({ type: 'payment' }, submission),
    'Payment method: Pay by invoice\nPayment status: Unpaid');
  assert.deepEqual(submission.submission_data, {});
  for (const [provider, label] of [['stripe', 'Card'], ['gocardless', 'Direct Debit'],
    ['stripe_monthly_card', 'Monthly card payments']]) {
    assert.equal(submissionCheckoutText({ type: 'payment' }, { payment_provider: provider }),
      `Payment method: ${label}`);
  }
});
test('confirmation is intentionally display-only, not an unanswered question', () => {
  const text = submissionCheckoutText({ type: 'sales_cart_view' }, {});
  assert.match(text, /No data is deliberately shown here/);
  assert.match(text, /cart receipt/);
  assert.doesNotMatch(text, /Not provided/);
});
test('missing and unknown methods are not silently labelled card', () => {
  assert.equal(submissionCheckoutText({ type: 'payment' }, {}), 'No payment method was recorded.');
  assert.equal(submissionCheckoutText({ type: 'payment' }, { payment_provider: 'other' }), 'Payment method: other');
  assert.equal(submissionCheckoutText({ type: 'text' }, {}), null);
});
