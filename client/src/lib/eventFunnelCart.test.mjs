import test from 'node:test';
import assert from 'node:assert/strict';
import { funnelCartRows, previewFunnelRemoval } from './eventFunnelCart.mjs';
import { readFunnelJourney } from '../../../shared/eventFunnelJourney.mjs';
import { journeyFixture } from '../../../shared/eventFunnelJourney.test.mjs';

const clientSnapshot = selection => {
  const snapshot = journeyFixture(selection);
  return { ...snapshot, route: readFunnelJourney(snapshot).route };
};
const lines = snapshot => snapshot.holds.map(hold => ({ nodeId: hold.node_id, ticketId: hold.ticket_id,
  quantity: hold.quantity, ticketName: `Ticket ${hold.ticket_id}`, eventTitle: hold.event_id, unitMinor: 1000, amountMinor: 1000 }));

test('cart nests a dependent add-on under the optional step it requires, never under the source', () => {
  const snapshot = clientSnapshot();
  snapshot.drafts.lunch = { attendeesByTicket: { L: [{ first_name: 'Ana', last_name: 'Ruiz' }] } };
  const rows = funnelCartRows(snapshot, lines(snapshot));
  assert.deepEqual(rows.map(row => [row.nodeId, row.depth]), [['source', 0], ['parking', 0], ['other', 0], ['lunch', 1]]);
  assert.deepEqual(rows.find(row => row.nodeId === 'lunch').requires, ['Ticket C']);
  assert.deepEqual(rows.find(row => row.nodeId === 'lunch').attendees, ['Ana Ruiz']);
  assert.equal(rows.find(row => row.nodeId === 'source').removable, false);
  assert.equal(rows.find(row => row.nodeId === 'parking').removable, true);
});

test('removal preview names the dependent selections the server would also release', () => {
  const snapshot = clientSnapshot();
  assert.deepEqual(previewFunnelRemoval(snapshot, 'other'), { alsoRemoved: ['lunch'], leavesCheckout: false });
  assert.deepEqual(previewFunnelRemoval(snapshot, 'parking'), { alsoRemoved: [], leavesCheckout: false });
});

test('removal preview never offers the source and fails closed to null', () => {
  const snapshot = clientSnapshot();
  assert.equal(previewFunnelRemoval(snapshot, 'source'), null);
  assert.equal(previewFunnelRemoval({ ...snapshot, graph: null }, 'other'), null);
});
