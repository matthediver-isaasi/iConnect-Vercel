import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFunnelTicket, funnelChosenTicketId, funnelAttendee, memberSelfAttendee, updateFunnelAttendee,
  guestAttendeeIssues, emptyGuestAttendee } from './complexFunnelSelection.mjs';

const monday = { id: 11, name: 'Monday' };
const tuesday = { id: 'tue', name: 'Tuesday' };
const member = { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com', job_title: 'Physicist' };

test('choosing a ticket keeps exactly one ticket and one attendee', () => {
  let cart = chooseFunnelTicket(monday, memberSelfAttendee(member, { name: 'Org' }));
  assert.deepEqual(Object.keys(cart), ['11']);
  cart = chooseFunnelTicket(tuesday, funnelAttendee(cart));
  assert.deepEqual(Object.keys(cart), ['tue']);
  assert.equal(cart.tue.attendees.length, 1);
  assert.equal(funnelChosenTicketId(cart), 'tue');
  assert.equal(cart.tue.attendees[0].organization, 'Org');
  assert.equal(cart.tue.discountInfo, undefined);
});

test('member attendee keeps earlier answers when the ticket changes', () => {
  const first = memberSelfAttendee(member, null);
  assert.equal(first.job_title, 'Physicist');
  const edited = { ...first, job_title: 'Lead', dietary_selections: ['Vegan'] };
  const again = memberSelfAttendee(member, null, edited);
  assert.equal(again.job_title, 'Lead');
  assert.deepEqual(again.dietary_selections, ['Vegan']);
  assert.equal(again.isSelf, true);
});

test('updating the attendee leaves the chosen ticket in place', () => {
  const cart = updateFunnelAttendee(chooseFunnelTicket(monday, emptyGuestAttendee()), { first_name: 'Bo' });
  assert.equal(cart['11'].attendees[0].first_name, 'Bo');
  assert.deepEqual(updateFunnelAttendee({}, { first_name: 'x' }), {});
  assert.equal(funnelChosenTicketId({}), null);
});

test('guest attendee validation', () => {
  assert.equal(guestAttendeeIssues(emptyGuestAttendee()).length, 2);
  const ok = { first_name: 'A', last_name: 'B', email: 'a@b.co', organization: '', job_title: '' };
  assert.deepEqual(guestAttendeeIssues(ok), []);
  assert.deepEqual(guestAttendeeIssues(ok, { requireOrganization: true, requireJobTitle: true }),
    ['Enter your organisation.', 'Enter your job title.']);
});
