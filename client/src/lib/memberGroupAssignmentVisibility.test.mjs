import test from 'node:test';
import assert from 'node:assert/strict';
import { isGroupAssignmentExpired, visibleGroupAssignments } from './memberGroupAssignmentVisibility.js';
import { uniqueGroupPersonCount } from './memberGroupAutomaticSync.js';

const now = Date.parse('2026-09-24T00:00:00Z');

test('expiry uses the exact instant, including date-only UTC midnight and timezone offsets', () => {
  for (const expires_at of ['2026-09-23', '2026-09-24', '2026-09-24T00:00:00Z', '2026-09-24T01:00:00+01:00']) {
    assert.equal(isGroupAssignmentExpired({ expires_at }, now), true, expires_at);
  }
  for (const expires_at of ['2026-09-25', '2026-09-24T00:00:00.001Z', '2026-09-24T00:00:00-01:00', null, undefined, '', 'legacy-invalid']) {
    assert.equal(isGroupAssignmentExpired({ expires_at }, now), false, String(expires_at));
  }
});

test('filters assignments rather than people and preserves order and undated or malformed rows', () => {
  const rows = [
    { id: 'expired-member', member_id: 'm', expires_at: '2020-01-01' },
    { id: 'current-member', member_id: 'm', expires_at: '2030-01-01', term_end_date: '2020-01-01' },
    { id: 'expired-guest', guest_id: 'g', expires_at: '2020-01-01' },
    { id: 'current-guest', guest_id: 'g', expires_at: null },
    { id: 'legacy', member_id: 'legacy', expires_at: 'bad-date' },
    { id: 'another-role', member_id: 'm' },
  ];
  assert.equal(visibleGroupAssignments(rows), rows);
  const visible = visibleGroupAssignments(rows, false, now);
  assert.deepEqual(visible.map(a => a.id), ['current-member', 'current-guest', 'legacy', 'another-role']);
  assert.equal(uniqueGroupPersonCount(visible), 3);
  assert.equal(rows.length, 6);
  assert.deepEqual(visibleGroupAssignments(rows.slice(0, 1), false, now), []);
});