import test from 'node:test';
import assert from 'node:assert/strict';
import { currentPersonalMembershipExpiry } from './aboutMeMembership.js';
import { normalizeCanvasMembershipSummary } from './canvasMembershipData.js';

const now = new Date('2030-06-15T12:00:00Z');
const ready = (membership = {}) => ({
  status: 'ready',
  data: { membership: {
    source: 'personal', state: 'active', expiryDate: '2030-09-30',
    termStartDate: '2030-01-01', ...membership,
  } },
});

test('shows friendly current personal expiry for active and paused terms', () => {
  for (const state of ['active', 'paused']) {
    assert.equal(currentPersonalMembershipExpiry(ready({ state }), now), '30 September 2030');
  }
  assert.equal(currentPersonalMembershipExpiry(ready({ expiryDate: '2030-06-15' }), now), '15 June 2030');
  assert.equal(currentPersonalMembershipExpiry(ready({ termEndDate: '2030-08-31' }), now), '31 August 2030');
  assert.equal(currentPersonalMembershipExpiry(ready({ termEndDate: '2030-08-31', expiryDate: null }), now), '31 August 2030');
});

test('never treats organisation, unknown-source, scheduled, grace or past terms as current', () => {
  for (const membership of [
    { source: 'organisation' }, { source: undefined }, { source: null },
    { state: 'pending' }, { state: 'scheduled' }, { state: 'expired' },
    { state: 'unavailable' }, { state: 'none' }, { state: 'failed' },
    { termStartDate: '2030-07-01' }, { termStartDate: 'not-a-date' },
    { expiryDate: '2030-06-14' }, { grace: { inGrace: true, graceEndDate: '2030-10-31' } },
    { expiryDate: null }, { expiryDate: '' }, { expiryDate: 'not-a-date' },
    { expiryDate: '2030-02-30' }, { expiryDate: undefined, renewalDate: '2030-09-30' },
    { termEndDate: '2030-06-14' }, { termEndDate: '2030-02-30' },
  ]) {
    assert.equal(currentPersonalMembershipExpiry(ready(membership), now), null, JSON.stringify(membership));
  }
});

test('quietly omits loading, denied, guest, errors and editor samples, even with retained data', () => {
  for (const status of ['loading', 'error', 'denied', 'guest']) {
    assert.equal(currentPersonalMembershipExpiry({ ...ready(), status }, now), null);
  }
  assert.equal(currentPersonalMembershipExpiry({ ...ready(), isSample: true }, now), null);
  assert.equal(currentPersonalMembershipExpiry(null, now), null);
  assert.equal(currentPersonalMembershipExpiry({ status: 'ready' }, now), null);
});

test('normalised API membership retains source and produces the displayed personal expiry', () => {
  const summary = { status: 'ready', data: normalizeCanvasMembershipSummary(ready().data) };
  assert.equal(summary.data.membership.source, 'personal');
  assert.equal(currentPersonalMembershipExpiry(summary, now), '30 September 2030');
});
