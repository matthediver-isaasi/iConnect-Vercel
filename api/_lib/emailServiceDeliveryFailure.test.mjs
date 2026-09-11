import test from 'node:test';
import assert from 'node:assert/strict';
import { isAmbiguousDeliveryFailure } from './emailService.js';

test('Mailgun-wrapped transport uncertainty must not be retried as rejection', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ERR_NETWORK']) {
    for (const key of ['code', 'message', 'statusText', 'details']) {
      assert.equal(isAmbiguousDeliveryFailure({
        type: 'MailgunAPIError', status: 400, [key]: code,
      }), true, `${key}: ${code}`);
    }
  }
});

test('preconnection failures and explicit provider rejections remain retryable', () => {
  for (const message of ['EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'Unauthorized', 'Invalid recipient']) {
    assert.equal(isAmbiguousDeliveryFailure({
      type: 'MailgunAPIError', status: 400, message,
    }), false, message);
  }
});