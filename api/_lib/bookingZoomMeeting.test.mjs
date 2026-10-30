import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBookingZoomMeeting } from './bookingZoomMeeting.js';
const event = { id: 'event', tenant_id: 'tenant', zoom_meeting_id: 'meeting' };
const booking = { id: 'booking', event_id: 'event', tenant_id: 'tenant', status: 'confirmed',
  attendee_email: 'member@example.invalid' };
function fixture({ failure = false, writeError = false } = {}) {
  const writes = [];
  const db = { from(table) { const filters = []; return {
    select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
    single: async () => ({ data: { zoom_meeting_id: '123' } }),
    update(values) { writes.push({ table, values, filters }); return this; },
    then(resolve) { return Promise.resolve({ error: writeError ? { message: 'failed' } : null }).then(resolve); },
  }; } };
  const records = new Map();
  let creates = 0;
  const provider = {
    read: async () => ({ registration_required: true }),
    list: async () => { if (failure) throw new Error('offline'); return records; },
    register: async (_token, kind, id, attendee) => {
      assert.equal(kind, 'meetings'); assert.equal(id, '123');
      if (!records.has(attendee.email)) { creates++; records.set(attendee.email, { registrant_id: 'registrant' }); }
      return { success: true, join_url: 'https://zoom.us/j/123?token=fixture' };
    },
  };
  return { db, provider, writes, count: () => creates };
}
test('meeting registration persists identity and returns personalised link; replay adopts existing', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await registerBookingZoomMeeting(f.db, event, [booking], async () => 'token', f.provider);
    assert.equal(result[0].success, true);
    assert.ok(result[0].join_url);
  }
  assert.equal(f.count(), 1);
  assert.equal(f.writes[0].values.zoom_registrant_id, 'registrant');
  assert.deepEqual(f.writes[0].filters, [['tenant_id', 'tenant'], ['event_id', 'event'], ['id', 'booking'], ['status', 'confirmed']]);
});
test('unconfirmed and foreign bookings cannot cause provider writes', async () => {
  const f = fixture();
  await registerBookingZoomMeeting(f.db, event, [
    { ...booking, status: 'cancelled' }, { ...booking, tenant_id: 'other' }, { ...booking, event_id: 'other' },
  ], async () => { throw new Error('must not request token'); }, f.provider);
  assert.equal(f.count(), 0);
});
test('provider and persistence failures remain unsuccessful and never invent registration', async () => {
  for (const options of [{ failure: true }, { writeError: true }]) {
    const f = fixture(options);
    const result = await registerBookingZoomMeeting(f.db, event, [booking], async () => 'token', f.provider);
    assert.equal(result[0].success, false);
  }
});
