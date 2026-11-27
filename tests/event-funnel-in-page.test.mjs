import test from 'node:test';
import assert from 'node:assert/strict';
import { addonSelection, isTicketRoutedByEntry, restoreAddonChoices, sourceAttendeePool } from '../client/src/lib/eventFunnelInPage.mjs';

test('routed ticket list decides funnel versus normal checkout', () => {
  const entry = { active: true, routing: 'ticket', routedTicketIds: ['a', 'b'] };
  assert.equal(isTicketRoutedByEntry(entry, ['a']), true);
  assert.equal(isTicketRoutedByEntry(entry, ['c']), false);
  assert.equal(isTicketRoutedByEntry({ active: true, routing: 'ticket' }, ['c']), true, 'older responses keep submit-time routing');
  assert.equal(isTicketRoutedByEntry({ active: true, routing: 'legacy', versionId: 'v' }, ['c']), true);
});

const source = {
  purchaser: { first_name: 'Pat', last_name: 'Buyer', email: 'pat@example.org' },
  terms_accepted: true, terms_content: '<p>T</p>', code_of_conduct_accepted: true, code_of_conduct_content: 'C',
  attendeesByTicket: {
    t1: [{ first_name: 'Ann', last_name: 'A', email: 'ann@example.org' }, { first_name: 'Bob', last_name: 'B', email: 'BOB@example.org' }],
    t2: [{ first_name: 'Bob', last_name: 'B', email: 'bob@example.org' }],
  },
  attendees: [{ first_name: 'stale' }],
};

test('attendee pool lists each source attendee once', () => {
  assert.deepEqual(sourceAttendeePool(source).map(a => a.first_name), ['Ann', 'Bob']);
  assert.deepEqual(sourceAttendeePool({ attendees: [{ first_name: 'Solo', email: 's@example.org' }] }).map(a => a.first_name), ['Solo']);
});

test('add-on selection reuses source acceptance with the chosen attendees only', () => {
  const pool = sourceAttendeePool(source);
  const result = addonSelection(source, pool, { x: [1, 0, 1], y: [] });
  assert.deepEqual(result.tickets, [{ id: 'x', quantity: 2 }]);
  assert.equal(result.answers.terms_accepted, true);
  assert.equal(result.answers.code_of_conduct_content, 'C');
  assert.deepEqual(result.answers.purchaser, source.purchaser);
  assert.deepEqual(result.answers.attendeesByTicket.x.map(a => a.first_name), ['Ann', 'Bob']);
  assert.deepEqual(result.answers.attendees.map(a => a.first_name), ['Ann', 'Bob']);
  assert.equal(result.answers.attendeesByTicket.t1, undefined);
  assert.deepEqual(addonSelection(source, pool, {}).tickets, []);
});

test('saved add-on choices are restored by attendee', () => {
  const pool = sourceAttendeePool(source);
  const offer = { selectedTickets: [{ id: 'x', quantity: 1 }],
    draft: { answers: { attendeesByTicket: { x: [{ email: 'bob@example.org' }] } } } };
  assert.deepEqual(restoreAddonChoices(pool, offer), { x: [1] });
  assert.deepEqual(restoreAddonChoices(pool, { selectedTickets: [{ id: 'y', quantity: 1 }] }), { y: [0] });
});
