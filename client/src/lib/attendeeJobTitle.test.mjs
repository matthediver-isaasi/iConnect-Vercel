import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttendeeJobTitle } from './attendeeJobTitle.js';

const booker = {
  id: 'm1',
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  job_title: 'Director',
};

test('stored attendee_job_title always wins', () => {
  const booking = {
    attendee_job_title: 'Engineer',
    member_id: 'm1',
    attendee_email: 'jane@example.com',
    attendee_first_name: 'Jane',
    attendee_last_name: 'Doe',
  };
  assert.equal(resolveAttendeeJobTitle(booking, booker), 'Engineer');
});

test('legacy fallback: booker email match uses member profile title', () => {
  const booking = {
    member_id: 'm1',
    attendee_email: 'JANE@example.com ',
    attendee_first_name: 'J.',
    attendee_last_name: 'D.',
  };
  assert.equal(resolveAttendeeJobTitle(booking, booker), 'Director');
});

test('legacy fallback: booker full-name match uses member profile title', () => {
  const booking = {
    member_id: 'm1',
    attendee_email: 'other@example.com',
    attendee_first_name: 'jane',
    attendee_last_name: 'DOE',
  };
  assert.equal(resolveAttendeeJobTitle(booking, booker), 'Director');
});

test('non-booker attendee never inherits the booker title', () => {
  const booking = {
    member_id: 'm1',
    attendee_email: 'guest@example.com',
    attendee_first_name: 'Guest',
    attendee_last_name: 'Person',
  };
  assert.equal(resolveAttendeeJobTitle(booking, booker), '');
});

test('no member_id and no stored title yields blank', () => {
  const booking = {
    attendee_email: 'jane@example.com',
    attendee_first_name: 'Jane',
    attendee_last_name: 'Doe',
  };
  assert.equal(resolveAttendeeJobTitle(booking, undefined), '');
});

test('missing member info yields blank', () => {
  const booking = { member_id: 'm2', attendee_email: 'x@example.com' };
  assert.equal(resolveAttendeeJobTitle(booking, undefined), '');
});

test('whitespace-only stored title falls through to fallback rules', () => {
  const booking = {
    attendee_job_title: '   ',
    member_id: 'm1',
    attendee_email: 'jane@example.com',
  };
  assert.equal(resolveAttendeeJobTitle(booking, booker), 'Director');
});
