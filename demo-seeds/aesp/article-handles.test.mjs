// Tests for ensureAuthorHandles in demo-seeds/aesp/articles.mjs
// Run: node --test demo-seeds/aesp/article-handles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAuthorHandles } from './articles.mjs';

const TENANT_ID = 't-demo';

/** Chainable supabase mock over a member table; records UPDATE predicates. */
function mockSb(members, updates = []) {
  return {
    from: (table) => {
      assert.equal(table, 'member');
      const state = { filters: {}, nullFilters: {}, patch: null, op: 'select' };
      const chain = {
        select: () => chain,
        update: (patch) => { state.op = 'update'; state.patch = patch; return chain; },
        eq: (k, v) => { state.filters[k] = v; return chain; },
        is: (k, v) => { state.nullFilters[k] = v; return chain; },
        limit: () => chain,
        then: (res) => {
          const matched = members.filter((m) =>
            Object.entries(state.filters).every(([k, v]) => m[k] === v) &&
            Object.entries(state.nullFilters).every(([k, v]) => (v === null ? m[k] == null : m[k] != null)));
          if (state.op === 'update') {
            updates.push({ filters: { ...state.filters }, nullFilters: { ...state.nullFilters }, patch: state.patch });
            for (const m of matched) Object.assign(m, state.patch);
          }
          return Promise.resolve({ data: matched.map((m) => ({ id: m.id })), error: null }).then(res);
        },
      };
      return chain;
    },
  };
}

test('sets handle fill-null with tenant + id + null predicates on the UPDATE', async () => {
  const members = [{ id: 'm1', tenant_id: TENANT_ID, handle: null }];
  const updates = [];
  const set = await ensureAuthorHandles(mockSb(members, updates), TENANT_ID, [{ memberId: 'm1', handle: 'aisha-rahman' }]);
  assert.equal(set, 1);
  assert.equal(members[0].handle, 'aisha-rahman');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].filters.tenant_id, TENANT_ID);
  assert.equal(updates[0].filters.id, 'm1');
  assert.equal(updates[0].nullFilters.handle, null, 'UPDATE must require handle IS NULL');
});

test('never overwrites an existing handle', async () => {
  const members = [{ id: 'm1', tenant_id: TENANT_ID, handle: 'chosen-by-user' }];
  const updates = [];
  const set = await ensureAuthorHandles(mockSb(members, updates), TENANT_ID, [{ memberId: 'm1', handle: 'aisha-rahman' }]);
  assert.equal(set, 0);
  assert.equal(members[0].handle, 'chosen-by-user');
});

test('skips with warning when another member owns the handle', async () => {
  const members = [
    { id: 'other', tenant_id: TENANT_ID, handle: 'aisha-rahman' },
    { id: 'm1', tenant_id: TENANT_ID, handle: null },
  ];
  const updates = [];
  const logs = [];
  const set = await ensureAuthorHandles(mockSb(members, updates), TENANT_ID, [{ memberId: 'm1', handle: 'aisha-rahman' }], (m) => logs.push(m));
  assert.equal(set, 0);
  assert.equal(members[1].handle, null);
  assert.equal(updates.length, 0);
  assert.ok(logs.some((l) => /already used by another member/.test(l)));
});

test('idempotent: member already owning the desired handle is a silent no-op', async () => {
  const members = [{ id: 'm1', tenant_id: TENANT_ID, handle: 'aisha-rahman' }];
  const logs = [];
  const set = await ensureAuthorHandles(mockSb(members), TENANT_ID, [{ memberId: 'm1', handle: 'aisha-rahman' }], (m) => logs.push(m));
  assert.equal(set, 0);
  assert.equal(logs.length, 0);
});

test('missing member ids are skipped', async () => {
  const set = await ensureAuthorHandles(mockSb([]), TENANT_ID, [{ memberId: null, handle: 'x' }, { memberId: 'm9', handle: null }]);
  assert.equal(set, 0);
});
