import assert from 'node:assert/strict';
import test from 'node:test';

import { getCampaignSendFeedback } from './campaignSendFeedback.js';

test('does not treat a recipient total as successful provider acceptance', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'sent', totalRecipients: 12, sent: 0 }),
    {
      type: 'error',
      message: 'No emails were accepted by the provider. Check the campaign audience and try again.',
    },
  );
});

test('reports provider acceptance without claiming delivery', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'sent', totalRecipients: 4, sent: 4, failed: 0 }),
    {
      type: 'success',
      message: '4 emails accepted by the provider. Delivery is not yet confirmed.',
    },
  );
});

test('reports ongoing sends as progress rather than completion', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'sending', sent: 10, failed: 0, remaining: 15 }),
    {
      type: 'info',
      message: 'Campaign sending continues. 10 emails accepted by the provider. 15 emails still queued.',
    },
  );
});

test('reports preparing and queued responses with zero acceptance truthfully', () => {
  assert.equal(
    getCampaignSendFeedback({ status: 'preparing', totalRecipients: 8 }).message,
    'Campaign is preparing. No emails have been accepted yet.',
  );
  assert.equal(
    getCampaignSendFeedback({ status: 'queued', pendingCount: 8 }).message,
    'Campaign queued. No emails have been accepted yet. 8 emails still queued.',
  );
  assert.equal(
    getCampaignSendFeedback({ status: 'pending', pending: 5 }).message,
    'Campaign queued. No emails have been accepted yet. 5 emails still queued.',
  );
  assert.equal(
    getCampaignSendFeedback({ status: 'processing', sent: 2, pending: 3 }).message,
    'Campaign sending continues. 2 emails accepted by the provider. 3 emails still queued.',
  );
  assert.equal(
    getCampaignSendFeedback({ status: 'processing', queued: 2, processing: 1 }).message,
    'Campaign sending has started; no emails have been accepted by the provider yet. 3 emails still queued.',
  );
});

test('reports paused campaigns without implying completion', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'paused', sent: 4, pending: 6 }),
    {
      type: 'info',
      message: 'Campaign paused. 4 emails accepted by the provider. 6 emails remain queued.',
    },
  );
});

test('reports cancellation separately from send success', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'cancelled', sent: 2, failed: 1 }),
    {
      type: 'warning',
      message: 'Campaign cancelled. 2 emails accepted by the provider. 1 email failed.',
    },
  );
});

test('shows partial failure counts and actionable recipient errors', () => {
  assert.deepEqual(
    getCampaignSendFeedback({
      status: 'sent',
      sent: 2,
      failed: 1,
      failures: [{ email: 'person@example.com', error: 'Address rejected' }],
    }),
    {
      type: 'warning',
      message: '2 emails accepted by the provider. Delivery is not yet confirmed. 1 email failed: person@example.com: Address rejected',
    },
  );
});

test('uses errors returned by campaign sends as failure details and count', () => {
  assert.deepEqual(
    getCampaignSendFeedback({
      status: 'failed',
      sent: 0,
      errors: [{ email: 'person@example.com', error: 'Address rejected' }],
    }),
    {
      type: 'error',
      message: 'No emails were accepted by the provider. 1 email failed: person@example.com: Address rejected',
    },
  );
});

test('only calls an email delivered when delivery is explicitly reported', () => {
  assert.deepEqual(
    getCampaignSendFeedback({ status: 'delivered', deliveredCount: 3 }),
    {
      type: 'success',
      message: '3 emails confirmed delivered.',
    },
  );
});