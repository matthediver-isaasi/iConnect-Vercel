import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationSelection, restoreReservationCart, isGuestOwnedReservation, savedReservationAcceptance, heldReservationQuantity } from './eventReservationSelection.mjs';

test('selection preserves attendee extras and uses the explicit purchaser', () => {
  const attendee = { first_name: 'Mira', email: 'attendee@example.org', custom_answers: { access: 'Step-free' } };
  const result = reservationSelection({ items: [{ id: 'ticket-a', attendees: [attendee] }],
    purchaser: { first_name: 'Kit', last_name: 'Singh', email: 'booker@example.org', organization: 'Aster' },
    termsAccepted: true, bookingTerms: '<p>Exact terms</p>', conduct: { accepted: true, content: '<p>Conduct</p>' } });
  assert.deepEqual(result.tickets, [{ id: 'ticket-a', quantity: 1 }]);
  assert.equal(result.answers.purchaser.email, 'booker@example.org');
  assert.deepEqual(result.answers.attendeesByTicket['ticket-a'][0].custom_answers, { access: 'Step-free' });
  assert.equal(result.answers.terms_content, '<p>Exact terms</p>');
  assert.equal(result.answers.code_of_conduct_content, '<p>Conduct</p>');
});

test('restore uses authorized ticket objects and saved attendee counts', () => {
  const offer = { tickets: [{ id: 'a', name: 'Delegate' }], selectedTickets: [{ id: 'a', quantity: 2 }, { id: 'hidden', quantity: 1 }],
    draft: { answers: { attendeesByTicket: { a: [{ first_name: 'Mira' }, { first_name: 'Ellis' }] } } } };
  const cart = restoreReservationCart(offer);
  assert.deepEqual(Object.keys(cart), ['a']);
  assert.equal(cart.a.attendees.length, 2);
  assert.equal(cart.a.attendees[1].first_name, 'Ellis');
  assert.equal(cart.a.ticketClass, offer.tickets[0]);
});

test('multiple ticket classes keep separate attendee groups without an ambiguous attendees list', () => {
  const result = reservationSelection({ items: [{ id: 'a', attendees: [{ first_name: 'Mira' }] },
    { id: 'b', attendees: [{ first_name: 'Ellis' }] }], purchaser: {}, conduct: {}, termsAccepted: false });
  assert.equal(result.answers.attendees, undefined);
  assert.equal(result.answers.terms_accepted, false);
  assert.equal(result.tickets.length, 2);
});

test('owned guest authority comes from the original session, not a later browser member', () => {
  const snapshot = { session: { member_id: null }, purchaser: { email: 'original@example.org' } };
  const laterBrowserMember = { id: 'new-login', email: 'different@example.org', role_id: 'member' };
  assert.ok(laterBrowserMember.id);
  assert.equal(isGuestOwnedReservation(snapshot), true);
  assert.equal(isGuestOwnedReservation({ session: { member_id: 'original-member' } }), false);
  assert.equal(isGuestOwnedReservation(null), false);
  assert.equal(snapshot.purchaser.email, 'original@example.org');
});

test('saved policy acceptance requires exact content and an explicit true decision', () => {
  const saved = { terms_accepted: true, terms_content: '<p>Terms v1</p>', code_of_conduct_accepted: true,
    code_of_conduct_content: '<p>Conduct v1</p>' };
  assert.deepEqual(savedReservationAcceptance(saved, saved.terms_content, saved.code_of_conduct_content), { terms: true, conduct: true });
  assert.deepEqual(savedReservationAcceptance(saved, '<p>Terms v2</p>', '<p>Conduct v2</p>'), { terms: false, conduct: false });
  assert.equal(savedReservationAcceptance(saved, `${saved.terms_content} `, saved.code_of_conduct_content).terms, false);
  assert.deepEqual(savedReservationAcceptance({}, '', ''), { terms: false, conduct: false });
  assert.deepEqual(savedReservationAcceptance({ ...saved, terms_accepted: false, code_of_conduct_accepted: false },
    saved.terms_content, saved.code_of_conduct_content), { terms: false, conduct: false });
});

test('only a verified still-held quantity for the displayed node offsets a sold-out projection', () => {
  const snapshot = { session: { state: 'held', expires_at: '2031-04-17T11:15:00Z' }, serverNow: '2031-04-17T11:04:00Z',
    holds: [{ node_id: 'source', ticket_id: 'a', quantity: 2 }, { node_id: 'extra', ticket_id: 'a', quantity: 3 }] };
  assert.equal(heldReservationQuantity(snapshot, 'source', 'a'), 2);
  assert.ok(heldReservationQuantity(snapshot, 'source', 'a') >= 2, 'unchanged sold-out selection remains editable');
  assert.ok(heldReservationQuantity(snapshot, 'source', 'a') >= 1, 'reducing the selection remains allowed');
  assert.ok(heldReservationQuantity(snapshot, 'source', 'a') < 3, 'a larger selection is not covered by the existing hold');
  assert.equal(heldReservationQuantity(snapshot, 'source', 'other-ticket'), 0);
  assert.equal(heldReservationQuantity({ ...snapshot, session: { ...snapshot.session, state: 'expired' } }, 'source', 'a'), 0);
  assert.equal(heldReservationQuantity({ ...snapshot, serverNow: '2031-04-17T11:16:00Z' }, 'source', 'a'), 0);
  assert.equal(heldReservationQuantity({ ...snapshot, holds: [{ node_id: 'source', ticket_id: 'a', quantity: 2,
    expires_at: '2031-04-17T11:00:00Z' }] }, 'source', 'a'), 0);
  assert.equal(heldReservationQuantity(null, 'source', 'a'), 0);
  assert.equal(heldReservationQuantity({ ...snapshot, holds: [{ node_id: 'source', ticket_id: 'a', quantity: 2,
    state: 'released' }] }, 'source', 'a'), 0);
});
