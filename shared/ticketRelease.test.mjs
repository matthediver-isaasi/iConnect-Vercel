import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTicketReleased, validateTicketRelease, ticketReleaseMessage } from './ticketRelease.js';

const ticket = { release_at: '2026-10-25T01:30:00.000Z', release_timezone: 'Europe/London' };
test('legacy tickets are immediately available; exact instant is inclusive', () => {
  assert.equal(isTicketReleased({}), true);
  assert.equal(isTicketReleased({ release_at: null, release_timezone: null }), true);
  const at = Date.parse(ticket.release_at);
  assert.equal(isTicketReleased(ticket, at - 1), false);
  assert.equal(isTicketReleased(ticket, at), true);
  assert.equal(isTicketReleased(ticket, at + 1), true);
});
test('settings require a complete valid pair, real calendar date and explicit offset', () => {
  for (const invalid of [
    { release_at: ticket.release_at },
    { release_timezone: 'Europe/London' },
    { ...ticket, release_timezone: 'Bad/Timezone' },
    { ...ticket, release_timezone: 'GMT' },
    { ...ticket, release_at: '2026-10-25T01:30' },
    { ...ticket, release_at: '2026-02-30T01:30:00Z' },
    { ...ticket, release_at: '2026-10-25T24:00:00Z' },
    { ...ticket, release_at: '' },
    { ...ticket, release_at: 1792891800000 },
  ]) {
    assert.ok(validateTicketRelease(invalid));
    assert.equal(isTicketReleased(invalid, Date.now() + 1e12), false);
  }
  assert.equal(validateTicketRelease(ticket), null);
  assert.equal(validateTicketRelease({ ...ticket, release_at: '2026-10-25T02:30:00+01:00' }), null);
});
test('display uses saved timezone, not browser timezone; DST repeated hours remain explicit instants', () => {
  assert.equal(ticketReleaseMessage(ticket), 'Tickets available from 25 October 2026 at 01:30 (Europe/London)');
  const firstOccurrence = { ...ticket, release_at: '2026-10-25T00:30:00Z' };
  assert.equal(isTicketReleased(firstOccurrence, Date.parse('2026-10-25T01:00:00Z')), true);
  assert.equal(isTicketReleased(ticket, Date.parse('2026-10-25T01:00:00Z')), false);
  assert.match(ticketReleaseMessage({ ...ticket, release_timezone: 'America/New_York' }), /24 October 2026 at 21:30/);
});