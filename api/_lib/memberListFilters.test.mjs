import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemberListFilters,
  validateOrganizationFilterEntries,
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

test('member and organisation fields with the same id remain separate', () => {
  const ctx = parseMemberListFilters({
    customFilters: JSON.stringify({ shared: ['Member value'] }),
    organizationFilters: JSON.stringify({ shared: ['Organisation value'] }),
  });
  assert.equal(ctx.customFilterEntries[0][0], 'shared');
  assert.equal(ctx.organizationFilterEntries[0][0], 'shared');
  assert.match(memberFilterSelectJoins(ctx), /cf0:member_preference_value!inner/);
  assert.match(memberFilterSelectJoins(ctx), /orgf0:organization!inner/);
  assert.match(memberFilterSelectJoins(ctx), /opv0:organization_preference_value!inner/);
});

test('organisation filters are tenant-scoped and preserve anti-join semantics', () => {
  const ctx = parseMemberListFilters({
    organizationFilters: JSON.stringify({
      positive: ['A', 'B'],
      negative: { op: 'none_of', value: ['C'] },
      empty: { op: 'empty' },
      present: { op: 'not_empty' },
    }),
  });
  const joins = memberFilterSelectJoins(ctx);
  assert.match(joins, /orgf0:organization!inner/);
  assert.match(joins, /orgf1:organization!left/);
  assert.match(joins, /orgf2:organization!left/);
  const q = stubQuery();
  applyMemberListFilters(q, ctx, { tenantId: 'tenant-1' });
  assert.ok(q.calls.some(c => c[0] === 'eq' && c[1] === 'orgf0.tenant_id' && c[2] === 'tenant-1'));
  assert.ok(q.calls.some(c => c[0] === 'is' && c[1] === 'orgf1.opv1' && c[2] === null));
  assert.ok(q.calls.some(c => c[0] === 'is' && c[1] === 'orgf2.opv2' && c[2] === null));
  assert.ok(!q.calls.some(c => c[0] === 'is' && c[1] === 'orgf3.opv3'));
  const row = { id: 'm1', orgf0: {}, orgf1: null };
  stripFilterJoinAliases(row, ctx);
  assert.deepEqual(row, { id: 'm1' });
});

test('malformed organisation filters are ignored and accepted filters are capped', () => {
  assert.deepEqual(parseMemberListFilters({ organizationFilters: '{bad' }).organizationFilterEntries, []);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, ['x']]));
  assert.equal(parseMemberListFilters({ organizationFilters: JSON.stringify(many) }).organizationFilterEntries.length, 20);
});

test('list and export share identical organisation filter calls', () => {
  const params = {
    customFilters: JSON.stringify({ memberField: { op: 'not_contains', value: 'x' } }),
    organizationFilters: JSON.stringify({ orgField: { op: 'empty' } }),
  };
  const listQ = stubQuery();
  const exportQ = stubQuery();
  applyMemberListFilters(listQ, parseMemberListFilters(params), { tenantId: 't1' });
  applyMemberListFilters(exportQ, parseMemberListFilters(params), { tenantId: 't1' });
  assert.deepEqual(listQ.calls, exportQ.calls);
});

test('organisation filter validation enforces tenant, scope, active and visibility query', async () => {
  const calls = [];
  const db = {
    from(table) {
      calls.push(['from', table]);
      return this;
    },
    select(cols) { calls.push(['select', cols]); return this; },
    eq(col, value) { calls.push(['eq', col, value]); return this; },
    in(col, values) {
      calls.push(['in', col, values]);
      return Promise.resolve({
        data: [
          { id: 'allowed-new', show_in_admin_filter: true, show_in_admin_list: false },
          { id: 'allowed-legacy', show_in_admin_filter: null, show_in_admin_list: true },
          { id: 'hidden', show_in_admin_filter: false, show_in_admin_list: true },
        ],
        error: null,
      });
    },
  };
  const ctx = parseMemberListFilters({
    organizationFilters: JSON.stringify({
      'allowed-new': ['A'],
      'allowed-legacy': { op: 'not_empty' },
      hidden: ['B'],
      foreign: ['C'],
    }),
  });
  await validateOrganizationFilterEntries(db, 'tenant-1', ctx);
  assert.deepEqual(ctx.organizationFilterEntries.map(([id]) => id), ['allowed-new', 'allowed-legacy']);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 'tenant-1'));
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'entity_scope' && c[2] === 'organization'));
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'is_active' && c[2] === true));
});
