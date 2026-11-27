import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupResourcePinHandler } from './groupResourcePins.js';
import { authorizeGroupAdminResourceWrite } from './groupAdminResourceWrite.js';
import { guardGenericResourcePin } from './resourcePins.js';
import { groupPinnedResourcesFirst, pinnedResourcesFirst } from '../../shared/resourcePinOrder.mjs';

const member = { isAuthenticated: true, tenantId: 'tenant', memberId: 'member' };
const admin = { ...member, admin: true };
const assignment = { member_id: 'member', group_id: 'group', is_group_admin: true };
const original = { id: 'one', tenant_id: 'tenant', member_group_id: 'group',
  title: 'Original', release_date: '2026-01-01', created_date: '2025-01-01',
  is_public: false, subcategories: ['Linked'], tags: ['Tag'], is_pinned: true };
const checkAdmin = async ctx => ctx.admin === true;
const response = () => ({ setHeader() {}, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; } });
function database(rows, assignments = [assignment], options = {}) {
  return { from(table) {
    const source = table === 'resource' ? rows : table === 'member_group_assignment'
      ? assignments : [{ id: 'group', tenant_id: 'tenant', is_active: !options.inactive }];
    const filters = [];
    let patch;
    const q = {
      select() { return q; }, update(value) { patch = value; return q; },
      eq(k,v) { filters.push(row => row[k] === v); return q; },
      in(k,v) { filters.push(row => v.includes(row[k])); return q; },
      result() {
        if (options.failRead || (patch && options.failSave)) return { error: { code: '42703' } };
        const matches = source.filter(row => filters.every(fn => fn(row)));
        if (patch && matches[0]) Object.assign(matches[0], patch);
        return { data: matches.map(row => ({ ...row })) };
      },
      async maybeSingle() { const r = q.result(); return r.error ? r : { data: r.data[0] || null }; },
      then(resolve, reject) { return Promise.resolve(q.result()).then(resolve, reject); },
    };
    return q;
  }};
}
async function invoke(db, ctx = member, body = { id: 'one', is_group_pinned: true }, method = 'PATCH') {
  const res = response();
  await createGroupResourcePinHandler({ db, getTenantContext: async () => ctx, hasAdminAccess: checkAdmin })
    ({ method, body }, res);
  return res;
}
test('group admins and tenant admins share multiple persistent pins; unpin changes only group metadata', async () => {
  for (const ctx of [member, admin]) {
    const rows = [{ ...original }, { ...original, id: 'two', is_pinned: false }];
    const db = database(rows);
    for (const id of ['one', 'two']) assert.equal((await invoke(db, ctx, { id, is_group_pinned: true })).code, 200);
    // A new handler/viewer sees saved state; global metadata and content stay intact.
    assert.deepEqual(rows, [{ ...original, is_group_pinned: true },
      { ...original, id: 'two', is_pinned: false, is_group_pinned: true }]);
    assert.equal((await invoke(database(rows), ctx, { id: 'one', is_group_pinned: false })).code, 200);
    assert.deepEqual(rows[0], { ...original, is_group_pinned: false });
  }
});
test('guests, ordinary/expired/other-group admins and cross-tenant callers cannot pin', async () => {
  const cases = [
    [{}, [assignment], {}, 401],
    [member, [], {}, 403],
    [member, [{ ...assignment, is_group_admin: false }], {}, 403],
    [member, [{ ...assignment, expires_at: '2000-01-01' }], {}, 403],
    [member, [{ ...assignment, expires_at: 'invalid' }], {}, 403],
    [member, [{ ...assignment, group_id: 'other' }], {}, 403],
    [member, [assignment], { inactive: true }, 403],
    [{ ...member, tenantId: 'foreign' }, [assignment], {}, 404],
    [{ ...admin, tenantId: 'foreign' }, [assignment], {}, 404],
    [{ ...member, tenantMismatch: true }, [assignment], {}, 403],
    [{ ...member, tenantId: null }, [assignment], {}, 403],
  ];
  for (const [ctx, assignments, options, status] of cases) {
    const rows = [{ ...original }];
    assert.equal((await invoke(database(rows, assignments, options), ctx)).code, status);
    assert.deepEqual(rows, [original]);
  }
});
test('linked tenant cards, ownership escalation, global metadata, invalid requests and unavailable schema are rejected', async () => {
  for (const ctx of [member, admin]) {
    assert.equal((await invoke(database([{ ...original, member_group_id: null }]), ctx)).code, 403);
    for (const extra of [{ member_group_id: 'group' }, { is_pinned: false }, { title: 'Changed' }]) {
      const rows = [{ ...original }];
      assert.equal((await invoke(database(rows), ctx, { id: 'one', is_group_pinned: true, ...extra })).code, 400);
      assert.deepEqual(rows, [original]);
    }
  }
  assert.equal((await invoke(database([]), member)).code, 404);
  assert.equal((await invoke(database([original]), member, { id: 'one', is_group_pinned: 'true' })).code, 400);
  assert.equal((await invoke(database([original]), member, {}, 'POST')).code, 405);
  for (const options of [{ failRead: true }, { failSave: true }]) {
    const rows = [{ ...original }];
    assert.equal((await invoke(database(rows, [assignment], options))).code, 503);
    assert.deepEqual(rows, [original]);
  }
});
test('ordinary and bulk editor saves cannot overwrite either pin snapshot; group-only toggles do not need global authority', async () => {
  const access = { hasAdminAccess: checkAdmin, hasFeatureAccess: async () => false };
  const db = database([{ ...original }]);
  for (const body of [{ title: 'Edit', is_group_pinned: false }, { title: 'Edit', is_pinned: true, is_group_pinned: true }]) {
    const req = { method: 'PATCH', body };
    assert.equal(await guardGenericResourcePin({ entity: 'Resource', req, ctx: member, db, id: 'one', ...access }), false);
    assert.deepEqual(req.body, { title: 'Edit' });
  }
  const req = { method: 'POST', body: [{ title: 'New', is_group_pinned: true }] };
  assert.equal(await guardGenericResourcePin({ entity: 'resource', req, ctx: member, db, ...access }), false);
  assert.deepEqual(req.body, [{ title: 'New' }]);
  const globalChange = { method: 'PATCH', body: { is_pinned: false, is_group_pinned: true } };
  const res = response();
  assert.equal(await guardGenericResourcePin({ entity: 'Resource', req: globalChange, res, ctx: member, db, id: 'one', ...access }), true);
  assert.equal(res.code, 403);
  for (const member_group_id of [null, '', 'another']) {
    assert.equal((await authorizeGroupAdminResourceWrite({ op: 'update', existingRow: original,
      body: { member_group_id }, tenantCtx: member, db, checkAdmin })).ok, false);
  }
});
test('both surfaces preserve normal sorting and filtering; only the appropriate ownership-scoped pins move', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: i, title: String(i).padStart(2,'0'),
    created_date: i, member_group_id: i < 40 ? 'group' : null,
    is_group_pinned: [20,32,41].includes(i), is_pinned: [7,20,42].includes(i) }));
  for (const compare of [(a,b)=>a.created_date-b.created_date, (a,b)=>b.created_date-a.created_date,
    (a,b)=>a.title.localeCompare(b.title), (a,b)=>b.title.localeCompare(a.title)]) {
    const matches = rows.filter(r=>r.id !== 32).sort(compare);
    const untouched = [...matches];
    const group = groupPinnedResourcesFirst(matches, 'group');
    assert.equal(group[0].id, 20);
    assert.deepEqual(group.slice(1), matches.filter(r=>r.id !== 20));
    assert.equal(group.slice(0,12)[0].id, 20);
    assert.deepEqual(groupPinnedResourcesFirst(matches.map(r=>({...r,is_group_pinned:false})), 'group').map(r=>r.id), matches.map(r=>r.id));
    const main = pinnedResourcesFirst(matches);
    assert.equal(main[0].id, 42);
    assert.deepEqual(main.slice(1), matches.filter(r=>r.id !== 42));
    assert.deepEqual(matches, untouched);
    assert.equal(group.some(r=>r.id === 32), false);
  }
  assert.deepEqual(groupPinnedResourcesFirst([{ id: 1, member_group_id:'group' }, { id: 2, member_group_id:'group', is_group_pinned:'true' }], 'group').map(r=>r.id), [1,2]);
});
