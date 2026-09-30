import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyBookingMatch } from './attendanceMatching.js';

test('legacy Zoom ledger stores a booking/member only for one email candidate', () => {
  const candidate = { booking_id: 'booking-1', member_id: 'member-1' };
  assert.deepEqual(legacyBookingMatch([candidate]), candidate);
  assert.equal(legacyBookingMatch([]), null);
  assert.equal(legacyBookingMatch([candidate, { booking_id: 'booking-2', member_id: 'member-2' }]), null);
});