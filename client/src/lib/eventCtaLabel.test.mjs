import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEventCtaLabel,
  isEventRegistrationClosed,
  getTenantCtaLabel,
} from './eventCtaLabel.js';

test('per-event label wins over tenant default when active', () => {
  assert.equal(
    resolveEventCtaLabel({ perEventLabel: 'Book Now', defaultLabel: 'Register' }),
    'Book Now'
  );
});

test('blank/whitespace per-event label falls back to default', () => {
  assert.equal(resolveEventCtaLabel({ perEventLabel: '', defaultLabel: 'Register' }), 'Register');
  assert.equal(resolveEventCtaLabel({ perEventLabel: '   ', defaultLabel: 'View Details' }), 'View Details');
  assert.equal(resolveEventCtaLabel({ perEventLabel: null, defaultLabel: 'View Details' }), 'View Details');
  assert.equal(resolveEventCtaLabel({ defaultLabel: 'View Details' }), 'View Details');
});

test('registration-closed status beats any custom label', () => {
  assert.equal(
    resolveEventCtaLabel({ isRegistrationClosed: true, perEventLabel: 'Book Now', defaultLabel: 'Register' }),
    'Registration Closed'
  );
});

test('sold-out status beats any custom label', () => {
  assert.equal(
    resolveEventCtaLabel({ isSoldOut: true, perEventLabel: 'Book Now', defaultLabel: 'Register' }),
    'Sold Out'
  );
});

test('registration-closed beats sold-out', () => {
  assert.equal(
    resolveEventCtaLabel({ isRegistrationClosed: true, isSoldOut: true, perEventLabel: 'X', defaultLabel: 'Y' }),
    'Registration Closed'
  );
});

test('isEventRegistrationClosed handles event_state, legacy status, and deadline', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  assert.equal(isEventRegistrationClosed({ event_state: 'closed' }, now), true);
  assert.equal(isEventRegistrationClosed({ event_state: null, status: 'closed' }, now), true);
  // event_state set (non-closed) overrides legacy status
  assert.equal(isEventRegistrationClosed({ event_state: 'active', status: 'closed' }, now), false);
  assert.equal(
    isEventRegistrationClosed({ registration_closes_at: '2026-08-01T00:00:00Z' }, now),
    true
  );
  assert.equal(
    isEventRegistrationClosed({ registration_closes_at: '2026-09-01T00:00:00Z' }, now),
    false
  );
  assert.equal(isEventRegistrationClosed({}, now), false);
  assert.equal(isEventRegistrationClosed(null, now), false);
});

test('getTenantCtaLabel parses the event_cta_button setting', () => {
  const settings = [
    { setting_key: 'event_cta_button', setting_value: JSON.stringify({ style: 'solid', label: 'Sign Up' }) },
  ];
  assert.equal(getTenantCtaLabel(settings, 'Register'), 'Sign Up');
});

test('getTenantCtaLabel falls back when unset, empty-label, or malformed', () => {
  assert.equal(getTenantCtaLabel([], 'View Details'), 'View Details');
  assert.equal(getTenantCtaLabel(undefined, 'View Details'), 'View Details');
  assert.equal(
    getTenantCtaLabel([{ setting_key: 'event_cta_button', setting_value: '{bad json' }], 'Register'),
    'Register'
  );
  assert.equal(
    getTenantCtaLabel([{ setting_key: 'event_cta_button', setting_value: JSON.stringify({ style: 'solid' }) }], 'Register'),
    'Register'
  );
});
