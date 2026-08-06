import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTbcBookingReplacement,
  isTbcReplacementDisplayActive,
  resolveTbcCtaLabel,
  resolveTbcSummaryTitle,
} from './tbcBookingReplacement.mjs';

test('non-TBC events are unaffected even with the flag on', () => {
  assert.equal(getTbcBookingReplacement({ status: 'published', replace_booking_elements: true }), null);
  assert.equal(getTbcBookingReplacement({ status: 'draft', replace_booking_elements: true }), null);
});

test('TBC events with the toggle off (or missing) are unaffected', () => {
  assert.equal(getTbcBookingReplacement({ status: 'tbc' }), null);
  assert.equal(getTbcBookingReplacement({ status: 'tbc', replace_booking_elements: false }), null);
  assert.equal(getTbcBookingReplacement({ status: 'tbc', replace_booking_elements: null }), null);
});

test('null/undefined event is unaffected', () => {
  assert.equal(getTbcBookingReplacement(null), null);
  assert.equal(getTbcBookingReplacement(undefined), null);
});

test('TBC event with the toggle on yields message and trimmed CTA label', () => {
  const r = getTbcBookingReplacement({
    status: 'tbc',
    replace_booking_elements: true,
    booking_replacement_message: 'Register your interest.',
    booking_replacement_cta_label: '  Register Interest  ',
    booking_replacement_title: '  Register Your Interest  ',
  });
  assert.deepEqual(r, {
    message: 'Register your interest.',
    ctaLabel: 'Register Interest',
    title: 'Register Your Interest',
  });
});

test('missing/blank title falls back to null', () => {
  const r = getTbcBookingReplacement({ status: 'tbc', replace_booking_elements: true });
  assert.equal(r.title, null);
  const r2 = getTbcBookingReplacement({
    status: 'tbc',
    replace_booking_elements: true,
    booking_replacement_title: '   ',
  });
  assert.equal(r2.title, null);
});

test('resolveTbcSummaryTitle overrides only while the display is active', () => {
  const r = { message: '', ctaLabel: null, title: 'Pre-registration' };
  assert.equal(resolveTbcSummaryTitle(r, 0), 'Pre-registration');
  // Money owed: replacement display suppressed, keep the standard heading.
  assert.equal(resolveTbcSummaryTitle(r, 25), 'Booking Summary');
  // No title set: standard heading.
  assert.equal(resolveTbcSummaryTitle({ message: '', ctaLabel: null, title: null }, 0), 'Booking Summary');
  assert.equal(resolveTbcSummaryTitle(null, 0), 'Booking Summary');
});

test('blank CTA label falls back to null (default button text used)', () => {
  const r = getTbcBookingReplacement({
    status: 'tbc',
    replace_booking_elements: true,
    booking_replacement_cta_label: '   ',
  });
  assert.equal(r.ctaLabel, null);
  assert.equal(r.message, '');
  assert.equal(resolveTbcCtaLabel(r), 'Confirm Booking');
});

test('display suppression is active only for free bookings', () => {
  const r = { message: 'm', ctaLabel: null };
  assert.equal(isTbcReplacementDisplayActive(r, 0), true);
  assert.equal(isTbcReplacementDisplayActive(r), true);
  // Paid tickets: pricing/payment UI must remain so the booking can be paid.
  assert.equal(isTbcReplacementDisplayActive(r, 25), false);
  assert.equal(isTbcReplacementDisplayActive(null, 0), false);
});

test('resolveTbcCtaLabel overrides only when a label is set', () => {
  assert.equal(resolveTbcCtaLabel({ ctaLabel: 'Pre-register' }), 'Pre-register');
  assert.equal(resolveTbcCtaLabel(null), 'Confirm Booking');
  assert.equal(resolveTbcCtaLabel(null, 'Book Now'), 'Book Now');
});
