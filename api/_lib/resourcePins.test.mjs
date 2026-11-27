import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResourcePinHandler, guardGenericResourcePin, canManageResourcePins } from './resourcePins.js';
import { pinnedResourcesFirst } from '../../shared/resourcePinOrder.mjs';
import { createPublicResourcesHandler } from '../public/resources.js';

const manager = { isAuthenticated: true, tenantId: 'tenant', roleId: 'manager' };
const admin = { ...manager, roleId: 'admin' };
const member = { ...manager, roleId: 'member' };
const access = {
  hasAdminAccess: async ctx => ctx.roleId === 'admin',
  hasFeatureAccess: async (id, feature, excluded) =>
    id === 'manager' && feature === 'content.resource-management' && !excluded?.includes(feature),
};
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}
function database(rows, fail = false) {
  return { from(table) {
    assert.equal(table, 'resource');
    const filters = [];
    let patch;
    const query = {
      select() { return query; }, update(value) { patch = value; return query; },
      eq(k, v) { filters.push(row => row[k] === v); return query; },
      is(k, v) { filters.push(row => (row[k] ?? null) === v); return query; },
      async maybeSingle() {
        if (fail) return { error: { code: '42703' } };
        const row = rows.find(r => filters.every(f => f(r)));
        if (row && patch) Object.assign(row, patch);
        return { data: row ? { ...row } : null };
      },
    };
    return query;
  } };
}
test('only authenticated tenant-scoped resource managers and admins can pin', async () => {
  for (const ctx of [manager, admin, member, {}, { ...manager, tenantMismatch: true },
    { ...manager, tenantId: null }, { ...manager, memberExcludedFeatures: ['content.resource-management'] }]) {
    const rows = [{ id: 'one', tenant_id: 'tenant', release_date: 'unchanged', title: 'Original' }];
    const handler = createResourcePinHandler({ db: database(rows), getTenantContext: async () => ctx, ...access });
    const res = response();
    await handler({ method: 'PATCH', body: { id: 'one', is_pinned: true, title: 'Forbidden', tenant_id: 'other' } }, res);
    assert.equal(res.code, ctx === manager || ctx === admin ? 200 : ctx.isAuthenticated ? 403 : 401);
    assert.equal(rows[0].is_pinned === true, ctx === manager || ctx === admin);
    assert.equal(rows[0].title, 'Original');
    assert.equal(rows[0].release_date, 'unchanged');
  }
});
test('pin action isolates tenants and group resources, supports multiple pins and unpin', async () => {
  const rows = ['one', 'two'].map(id => ({ id, tenant_id: 'tenant', is_pinned: false }));
  rows.push({ id: 'foreign', tenant_id: 'other' }, { id: 'group', tenant_id: 'tenant', member_group_id: 'group' });
  const handler = createResourcePinHandler({ db: database(rows), getTenantContext: async () => manager, ...access });
  for (const [id, is_pinned, code] of [['one', true, 200], ['two', true, 200], ['foreign', true, 404], ['group', true, 404], ['one', false, 200]]) {
    const res = response();
    await handler({ method: 'PATCH', body: { id, is_pinned } }, res);
    assert.equal(res.code, code);
  }
  assert.deepEqual(rows.map(r => r.is_pinned), [false, true, undefined, undefined]);
});
test('invalid types, unsupported verbs and unapplied schema fail explicitly', async () => {
  for (const [method, body, status] of [['GET', {}, 405], ['PATCH', { id: 'one', is_pinned: 'true' }, 400],
    ['PATCH', { id: 'one', is_pinned: true }, 503]]) {
    const res = response();
    await createResourcePinHandler({ db: database([], true), getTenantContext: async () => manager, ...access })({ method, body }, res);
    assert.equal(res.code, status);
  }
});
test('generic writes never change pins; ordinary round trips retain server state', async () => {
  for (const method of ['POST', 'PUT', 'PATCH']) {
    for (const ctx of [admin, manager, member]) {
      for (const requested of [false, true]) {
        const req = { method, body: { title: 'Edited', is_pinned: requested } };
        const res = response();
        const denied = await guardGenericResourcePin({ entity: 'Resource', req, res, ctx,
          id: method === 'POST' ? undefined : 'one', db: database([{ id: 'one', tenant_id: 'tenant', is_pinned: true }]), ...access });
        const expectedDenied = ctx === member && requested !== (method !== 'POST');
        assert.equal(denied, expectedDenied);
        if (!denied) assert.deepEqual(req.body, { title: 'Edited' });
      }
    }
  }
  const req = { method: 'PATCH', body: { title: 'Edited without pin metadata' } };
  assert.equal(await guardGenericResourcePin({ entity: 'resource', req, ctx: member }), false);
  assert.equal(await canManageResourcePins({ ...manager, isAuthenticated: false }, access), false);
  for (const file of ['index.js', '[id].js']) {
    assert.match(readFileSync(new URL(`../entities/[entity]/${file}`, import.meta.url), 'utf8'), /await guardGenericResourcePin\(/);
  }
  for (const ctx of [member, manager, admin]) {
    const req = { method: 'POST', body: [{title:'One',is_pinned:false},{title:'Two',is_pinned:true}] };
    const res = response();
    assert.equal(await guardGenericResourcePin({entity:'Resource',req,res,ctx,db:database([]),...access}), ctx === member);
    if (ctx !== member) assert.deepEqual(req.body,[{title:'One'},{title:'Two'}]);
    else assert.equal(res.code,403);
  }
});
test('stable partition precedes pagination and preserves every normal sort within each group', () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({
    id: i, title: String(i).padStart(2, '0'), release_date: i,
    is_pinned: [17, 29, 32].includes(i), folder: i === 32 ? 'other' : 'current',
  }));
  for (const comparator of [(a,b) => b.release_date-a.release_date, (a,b) => a.release_date-b.release_date,
    (a,b) => a.title.localeCompare(b.title), (a,b) => b.title.localeCompare(a.title)]) {
    const allSorted = [...rows].sort(comparator);
    const allPrioritized = pinnedResourcesFirst(allSorted);
    assert.deepEqual(allPrioritized.slice(0, 3), allSorted.filter(r => r.is_pinned));
    assert.deepEqual(pinnedResourcesFirst(allSorted.map(r => ({ ...r, is_pinned: false }))).map(r => r.id),
      allSorted.map(r => r.id));
    const matches = rows.filter(r => r.folder === 'current' && r.id !== 29).sort(comparator);
    const original = [...matches];
    const result = pinnedResourcesFirst(matches);
    assert.equal(result[0].id, 17);
    assert.equal(result.slice(0, 9)[0].id, 17);
    assert.deepEqual(result.filter(r => !r.is_pinned), matches.filter(r => !r.is_pinned));
    assert.deepEqual(matches, original);
    assert.equal(result.some(r => [29,32].includes(r.id)), false);
  }
  assert.deepEqual(pinnedResourcesFirst([{id:1,is_pinned:'true'},{id:2,is_pinned:true},{id:3}]).map(r=>r.id), [2,1,3]);
});
test('guest projection carries pins without changing release/group/event/category filtering or locked targets', async () => {
  const rows = [
    { id: 'public', is_public: true, is_pinned: true, target_url: 'public-target' },
    { id: 'locked', is_public: false, is_pinned: true, target_url: 'secret-target' },
    { id: 'future', is_pinned: true, release_date: '2099-01-01' },
    { id: 'draft', is_pinned: true, status: 'draft' },
    { id: 'private-group', is_pinned: true, member_group_id: 'group' },
    { id: 'event', is_pinned: true, linked_events: [{event_id:'event'}] },
  ];
  let projection;
  const db = { from(table) {
    let status;
    const q = { select(columns) { if (table === 'resource') projection = columns; return q; },
      eq(key, value) { if (key === 'status') status = value; return q; }, is() { return q; }, order() { return q; },
      range() { return Promise.resolve({ data: rows.filter(row => !row.status || row.status === status) }); },
      then(resolve) { resolve({data:[]}); } };
    return q;
  }};
  const res = response();
  await createPublicResourcesHandler({ db, resolveTenant: async()=>({ id:'tenant',slug:'tenant' }) })({method:'GET'}, res);
  assert.match(projection, /\bis_pinned\b/);
  assert.deepEqual(res.body.map(r=>r.id), ['public','locked']);
  assert.equal(res.body[1].is_pinned, true);
  assert.equal(res.body[1].target_url, null);
  assert.equal(res.body[1].is_locked, true);
});
