import test from 'node:test';
import assert from 'node:assert/strict';
import { isTicketReleased } from '../../shared/ticketRelease.js';
import { resolveTicketPrice, isTicketVisibleToUser } from './complexEventPricing.js';
import { getEffectiveTicketPrice } from '../../client/src/lib/ticketPricing.js';

const base = {
  id: 'ticket', price: 40, early_bird_enabled: true, early_bird_price: 25,
  early_bird_deadline: '2099-01-01T00:00:00Z', visibility_mode: 'members_and_public',
};

test('upcoming ticket retains early-bird and standard prices independently of release', () => {
  for (const deadline of ['2099-01-01T00:00:00Z', '2000-01-01T00:00:00Z']) {
    const legacy = { ...base, early_bird_deadline: deadline };
    const upcoming = { ...legacy, release_at: '2099-12-01T00:00:00Z', release_timezone: 'Europe/London' };
    assert.equal(isTicketReleased(upcoming, Date.parse('2026-10-01T00:00:00Z')), false);
    assert.deepEqual(getEffectiveTicketPrice(upcoming), getEffectiveTicketPrice(legacy));
    assert.deepEqual(resolveTicketPrice([upcoming], 'ticket'), resolveTicketPrice([legacy], 'ticket'));
    assert.equal(getEffectiveTicketPrice(upcoming).price, deadline.startsWith('2099') ? 25 : 40);
  }
});

test('released/unreleased schedules never alter audience visibility or free pricing', () => {
  for (const release_at of [null, '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    for (const visibility_mode of ['members_only', 'public_only', 'members_and_public']) {
      const ticket = { ...base, is_free: true, price: 0, visibility_mode, release_at, release_timezone: release_at ? 'UTC' : null };
      assert.equal(isTicketVisibleToUser(ticket, false), visibility_mode !== 'members_only');
      assert.equal(isTicketVisibleToUser(ticket, true), visibility_mode !== 'public_only');
      assert.equal(resolveTicketPrice([ticket], 'ticket').price, 0);
      assert.equal(getEffectiveTicketPrice(ticket).price, 0);
    }
  }
});