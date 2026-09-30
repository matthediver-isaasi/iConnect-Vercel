import test from 'node:test';
import assert from 'node:assert/strict';
import { loadActiveSelfBadges } from './selfMemberBadges.js';

function databaseReturning(rows) {
  const filters = [];
  const query = {
    select() { return this; },
    eq(column, value) { filters.push(['eq', column, value]); return this; },
    is(column, value) { filters.push(['is', column, value]); return this; },
    then(resolve) { resolve({ data: rows, error: null }); },
  };
  return { database: { from: (table) => { filters.push(['from', table]); return query; } }, filters };
}

test('active self awards return badge display fields and scope by tenant and member', async () => {
  const { database, filters } = databaseReturning([
    { badge: { id: 'b1', name: 'Speaker', description: 'Spoke', image_url: '/speaker.png' } },
  ]);
  const result = await loadActiveSelfBadges(database, {
    isAuthenticated: true, tenantId: 'tenant-1', memberId: 'member-1',
  });
  assert.deepEqual(result.badges.map((badge) => badge.id), ['b1']);
  assert.deepEqual(filters, [
    ['from', 'member_badge'],
    ['eq', 'tenant_id', 'tenant-1'],
    ['eq', 'member_id', 'member-1'],
    ['is', 'revoked_at', null],
    ['eq', 'badge.is_active', true],
  ]);
});

test('self badge reads require an authenticated member context', async () => {
  const unused = { from() { throw new Error('database should not be queried'); } };
  assert.equal((await loadActiveSelfBadges(unused, null)).status, 401);
  assert.equal((await loadActiveSelfBadges(unused, { isAuthenticated: true, tenantId: 't1' })).status, 403);
});

test('missing and inactive joined badge definitions are not exposed', async () => {
  const { database } = databaseReturning([
    { badge: null },
    { badge: { id: 'inactive', is_active: false } },
    { badge: { id: 'active', name: 'Active' } },
  ]);
  const result = await loadActiveSelfBadges(database, {
    isAuthenticated: true, tenantId: 't1', memberId: 'm1',
  });
  assert.deepEqual(result.badges.map((badge) => badge.id), ['active']);
});