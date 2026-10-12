import test from 'node:test';
import assert from 'node:assert/strict';
import { reminderConfigurationsChanged as changed } from './eventEmailChanges.js';
import { readEventEmailSaveResponse } from '../../client/src/components/events/eventEmailSaveResponse.js';

const reminder = { id: 'r', email_type: 'reminder', timing_type: '1_day_before', subject: 'Reminder', body: 'Body', is_enabled: true };
test('confirmation-only edits and timestamps/order do not reschedule reminders', () => {
  const confirmation = { id: 'c', email_type: 'booking_confirmation', body: 'Old' };
  assert.equal(changed([confirmation, reminder], [{ ...reminder, updated_at: 'later' }, { ...confirmation, body: 'New' }]), false);
  assert.equal(changed([], [confirmation]), false);
  assert.equal(changed([confirmation], []), false);
});
test('changed, inserted, deleted, disabled and retyped reminders retain scheduling', () => {
  for (const patch of [{ body: 'New' }, { subject: 'New' }, { cc: 'test@example.test' }, { timing_type: '1_hour_before' }, { is_enabled: false }, { is_complex_event: true }, { event_survey_assignment_id: 's' }]) {
    assert.equal(changed([reminder], [{ ...reminder, ...patch }]), true);
  }
  assert.equal(changed([], [reminder]), true);
  assert.equal(changed([reminder], []), true);
  assert.equal(changed([reminder], [{ ...reminder, email_type: 'booking_confirmation' }]), true);
});
test('equivalent database date/number representations compare equally', () => {
  assert.equal(changed([{ ...reminder, custom_hours_before: 24, custom_send_at: '2026-10-12T10:00:00Z' }],
    [{ ...reminder, custom_hours_before: '24', custom_send_at: '2026-10-12T10:00:00+00:00' }]), false);
});
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
