import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemberListFilters,
  memberFilterSelectJoins,
  applyMemberListFilters,
  stripFilterJoinAliases,
} from './memberListFilters.js';

// Chainable stub query that records every filter call so we can assert the
// list endpoint and the CSV export produce identical filtering.
function stubQuery() {
  const calls = [];
  const q = {};
  for (const m of ['eq', 'in', 'or', 'is', 'not', 'ilike']) {
    q[m] = (...args) => { calls.push([m, ...args]); return q; };
  }
  q.calls = calls;
  return q;
}

test('multi-role any_of filters with an IN list', () => {
  const ctx = parseMemberListFilters({ roleId: 'r1,r2, r3' });
  const q = stubQuery();
  applyMemberListFilters(q, ctx);
  assert.deepEqual(q.calls, [['in', 'role_id', ['r1', 'r2', 'r3']]]);
});

test('single legacy roleId still uses eq', () => {
  const ctx = parseMemberListFilters({ roleId: 'r1' });
  const q = stubQuery();
  applyMemberListFilters(q, ctx);
  assert.deepEqual(q.calls, [['eq', 'role_id', 'r1']]);
});

test('roleId=all / empty applies no role filter', () => {
  for (const roleId of ['all', '', undefined]) {
    const q = stubQuery();
    applyMemberListFilters(q, parseMemberListFilters({ roleId }));
    assert.deepEqual(q.calls, []);
  }
});

test('multi-role none_of via coreFilters excludes all selected roles (null-safe)', () => {
  const coreFilters = JSON.stringify({ role_id: { op: 'none_of', value: ['r1', 'r2'] } });
  const ctx = parseMemberListFilters({ coreFilters });
  const q = stubQuery();
  applyMemberListFilters(q, ctx);
  assert.deepEqual(q.calls, [['or', 'role_id.is.null,role_id.not.in.("r1","r2")']]);
});

test('list and export apply identical filters for the same params (any_of + none_of + status + search)', () => {
  const params = {
    search: 'jane',
    organizationId: 'o1',
    roleId: 'r1,r2',
    status: 'active',
    coreFilters: JSON.stringify({ job_title: { op: 'contains', value: 'dir' } }),
    customFilters: JSON.stringify({ f1: ['A', 'B'] }),
  };
  const listQ = stubQuery();
  const exportQ = stubQuery();
  applyMemberListFilters(listQ, parseMemberListFilters(params));
  applyMemberListFilters(exportQ, parseMemberListFilters(params));
  assert.ok(listQ.calls.length > 0);
  assert.deepEqual(listQ.calls, exportQ.calls);

  // none_of role variant (the operator path the export previously dropped).
  const noneParams = {
    ...params,
    roleId: 'all',
    coreFilters: JSON.stringify({ role_id: { op: 'none_of', value: ['r1', 'r2'] } }),
  };
  const listQ2 = stubQuery();
  const exportQ2 = stubQuery();
  applyMemberListFilters(listQ2, parseMemberListFilters(noneParams));
  applyMemberListFilters(exportQ2, parseMemberListFilters(noneParams));
  assert.deepEqual(listQ2.calls, exportQ2.calls);
  assert.ok(listQ2.calls.some(c => c[0] === 'or' && String(c[1]).includes('role_id.not.in.("r1","r2")')));
});

test('custom filter joins + anti-join exclusion + alias stripping', () => {
  const ctx = parseMemberListFilters({
    customFilters: JSON.stringify({
      f1: ['A'],
      f2: { op: 'none_of', value: ['B'] },
    }),
  });
  assert.equal(
    memberFilterSelectJoins(ctx),
    ',\n      cf0:member_preference_value!inner(field_id, value),\n      cf1:member_preference_value!left(field_id, value)'
  );
  const q = stubQuery();
  applyMemberListFilters(q, ctx);
  // The anti-join entry must be excluded via .is(alias, null).
  assert.ok(q.calls.some(c => c[0] === 'is' && c[1] === 'cf1' && c[2] === null));

  const row = { id: 'm1', cf0: [], cf1: null };
  stripFilterJoinAliases(row, ctx);
  assert.deepEqual(row, { id: 'm1' });
});

test('id lists are capped at 100 entries', () => {
  const roleId = Array.from({ length: 150 }, (_, i) => `r${i}`).join(',');
  const ctx = parseMemberListFilters({ roleId });
  assert.equal(ctx.roleIds.length, 100);
});
