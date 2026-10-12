import test from 'node:test';
import assert from 'node:assert/strict';
import { readEventEmailSaveResponse } from '../../client/src/components/events/eventEmailSaveResponse.js';

const reminder = { id: 'r', email_type: 'reminder', timing_type: '1_day_before', subject: 'Reminder', body: 'Body', is_enabled: true };
test('preserves successful and partial failure JSON', async () => {
  for (const status of [200, 400, 500]) {
    const body = { savedEmails: [reminder], error: status === 200 ? null : 'Could not save' };
    assert.deepEqual(await readEventEmailSaveResponse(new Response(JSON.stringify(body), { status })), body);
  }
});
test('non-JSON hosting errors explain uncertain save without leaking body or parser errors', async () => {
  for (const status of [502, 503, 504, 500, 200]) {
    await assert.rejects(readEventEmailSaveResponse(new Response('Unexpected private upstream body', { status })), error => {
      assert.match(error.message, /may already have been saved/);
      assert.doesNotMatch(error.message, /private|JSON|token/);
      return true;
    });
  }
});
