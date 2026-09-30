import test from 'node:test';
import assert from 'node:assert/strict';

import { determineCampaignSendOutcome } from './campaignService.js';

function mockedOutcome(statuses, campaignStatus = 'sending') {
  const sentStatuses = new Set(['sent', 'delivered', 'opened', 'clicked']);
  const failures = statuses
    .filter(row => row.status === 'failed' && row.error_message)
    .map(row => ({ email: row.email, error: row.error_message }));
  return determineCampaignSendOutcome({
    campaignStatus,
    sent: statuses.filter(row => sentStatuses.has(row.status)).length,
    failed: statuses.filter(row => row.status === 'failed').length,
    queued: statuses.filter(row => row.status === 'pending').length,
    processing: statuses.filter(row => row.status === 'processing').length,
    errors: failures,
  });
}

test('a completed all-failed campaign is failed and exposes the provider error', () => {
  const result = mockedOutcome([{
    email: 'recipient@example.com',
    status: 'failed',
    error_message: '400: Bad Request',
  }]);

  assert.equal(result.status, 'failed');
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.complete, true);
  assert.equal(result.error, 'No emails were sent; all 1 recipient delivery failed. First error: 400: Bad Request');
  assert.deepEqual(result.errors, [{
    email: 'recipient@example.com',
    error: '400: Bad Request',
  }]);
});

test('a completed partial-success campaign remains sent with honest totals', () => {
  const result = mockedOutcome([
    { email: 'sent@example.com', status: 'delivered' },
    { email: 'failed@example.com', status: 'failed', error_message: 'Mailbox rejected' },
  ]);

  assert.equal(result.status, 'sent');
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.complete, true);
});

test('queued and processing recipients remain distinct and prevent completion', () => {
  const result = mockedOutcome([
    { status: 'sent' },
    { status: 'pending' },
    { status: 'pending' },
    { status: 'processing' },
  ]);

  assert.equal(result.status, 'sending');
  assert.equal(result.sent, 1);
  assert.equal(result.queued, 2);
  assert.equal(result.processing, 1);
  assert.equal(result.pending, 3);
  assert.equal(result.complete, false);
});

test('operator cancellation and pause are preserved over batch outcomes', () => {
  const completed = [{ status: 'sent' }];
  assert.equal(mockedOutcome(completed, 'cancelled').status, 'cancelled');
  assert.equal(mockedOutcome(completed, 'paused').status, 'paused');

  const queued = [{ status: 'pending' }];
  assert.equal(mockedOutcome(queued, 'cancelled').status, 'cancelled');
  assert.equal(mockedOutcome(queued, 'paused').status, 'paused');
});