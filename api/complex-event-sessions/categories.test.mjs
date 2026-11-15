import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as categories from '../_lib/sessionCategories.js';

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const C = '00000000-0000-0000-0000-000000000003';
function fixture() {
  const tables = {
    complex_event: [{ id: 'event', tenant_id: 'tenant', status: 'published' }],
    complex_event_session: [],
    complex_event_track: [{ id: 'track1', name: 'One', tenant_id: 'tenant', complex_event_id: 'event' }, { id: 'track2', name: 'Two', tenant_id: 'tenant', complex_event_id: 'event' }],
    complex_event_session_track: [],
    resource_category: [{ id: A, tenant_id: 'tenant', name: 'Practice', display_order: 2, is_active: true },
      { id: B, tenant_id: 'tenant', name: 'Research', display_order: 1, is_active: true, excluded_role_ids: ['excluded'] },
      { id: C, tenant_id: 'other', name: 'Other', is_active: true }],
  };
  const writes = [];
  const db = { from(table) {
    const filters = []; let single = false, operation, values;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      order() { return q; }, single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      insert(v) { operation = 'insert'; values = v; return q; }, update(v) { operation = 'update'; values = v; return q; },
      delete() { operation = 'delete'; return q; },
      then(resolve) {
        let rows = tables[table].filter(r => filters.every(f => f(r)));
        if (operation) writes.push({ table, operation, values });
        if (operation === 'insert') {
          rows = (Array.isArray(values) ? values : [values]).map(v => ({ id: `s${tables[table].length + 1}`, ...v }));
          tables[table].push(...rows);
        }
        if (operation === 'update') rows.forEach(r => Object.assign(r, values));
        if (operation === 'delete') tables[table] = tables[table].filter(r => !rows.includes(r));
        resolve({ data: structuredClone(single ? rows[0] || null : rows), error: null });
      },
    };
    return q;
  } };
  function handler(file) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g, '')
      .replace('export default async function handler', 'return async function handler');
    const deps = {
      ...categories, supabase: db,
      getTenantContext: async req => ({ isAuthenticated: req.auth !== false, tenantId: 'tenant', tenantUserId: req.roleId ? null : 'admin', roleId: req.roleId }),
      resolveTenantFromRequest: async () => ({ id: 'tenant' }),
      authorizeGroupAdminEventWrite: async ({ req, body }) => req.deny ? { ok: false, status: 403, error: 'Forbidden' } : { ok: true, body },
      authorizeGroupAdminEventAction: async ({ req }) => req.deny ? { ok: false, status: 403, error: 'Forbidden' } : { ok: true },
      sessionCategoryViewer: async ctx => ({ isPrivileged: !!ctx.tenantUserId, roleId: ctx.roleId }),
      recomputeComplexEventDates: async () => {},
      sendSessionUnavailable: () => false,
      fromZonedTime: value => new Date(value),
      formatInTimeZone: value => value,
    };
    return new Function(...Object.keys(deps), source)(...Object.values(deps));
  }
  const handlers = { list: handler('./index.js'), one: handler('./[id].js'), public: handler('./public.js') };
  async function request(route, method = 'GET', body = {}, options = {}) {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers[route]({ method, body, query: { event_id: 'event', id: 's1', skipOverlapCheck: 'true' }, ...options }, res);
    return res;
  }
  return { tables, writes, request, db };
}
test('real handlers create/edit/reload multiple assignments, preserve omitted and clear empty', async () => {
  const f = fixture();
  const created = await f.request('list', 'POST', { complex_event_id: 'event', title: 'Session', category_ids: [A, B, A], track_ids: ['track1', 'track2'] });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.body.session.category_ids, [A, B]);
  assert.deepEqual((await f.request('list')).body[0].category_ids, [A, B]);
  assert.deepEqual((await f.request('one')).body.categories.map(c => c.name), ['Research', 'Practice']);
  assert.deepEqual((await f.request('one', 'PATCH', { title: 'Edited' })).body.category_ids, [A, B]);
  f.tables.resource_category[0].name = 'Renamed';
  assert.equal((await f.request('one')).body.categories[1].name, 'Renamed');
  f.tables.resource_category[0].is_active = false;
  assert.deepEqual((await f.request('one')).body.categories.map(c => c.name), ['Research']);
  f.tables.resource_category.splice(1, 1);
  assert.deepEqual((await f.request('one')).body.categories, []);
  assert.deepEqual((await f.request('one', 'PATCH', { category_ids: [] })).body.category_ids, []);
  assert.deepEqual((await f.request('one')).body.category_ids, []);
});
test('validation and authorization fail before any session/track mutation', async () => {
  const f = fixture();
  for (const category_ids of [[C], ['invalid'], null]) {
    assert.equal((await f.request('list', 'POST', { complex_event_id: 'event', title: 'Invalid', category_ids })).statusCode, 400);
  }
  assert.equal(f.writes.length, 0);
  await f.request('list', 'POST', { complex_event_id: 'event', title: 'Legacy' });
  assert.deepEqual((await f.request('one')).body.category_ids, []);
  const count = f.writes.length;
  assert.equal((await f.request('one', 'PATCH', { category_ids: [C], track_ids: [] })).statusCode, 400);
  for (const [route, method] of [['list', 'POST'], ['one', 'PATCH'], ['one', 'DELETE'], ['one', 'GET'], ['list', 'GET']]) {
    assert.equal((await f.request(route, method, { category_ids: [A] }, { deny: true })).statusCode, 403);
  }
  assert.equal(f.writes.length, count);
  assert.equal((await f.request('list', 'POST', {}, { auth: false })).statusCode, 401);
});
test('group editor full-form saves preserve withheld assignments without exposing them', async () => {
  const f = fixture();
  await f.request('list', 'POST', {complex_event_id:'event',title:'Session',category_ids:[A,B]});
  const group = {roleId:'excluded'};
  const initial = (await f.request('list','GET',{},group)).body[0];
  assert.deepEqual(initial.category_ids,[A]);
  assert.ok(!JSON.stringify(initial).includes(B));
  // The active editor always submits its hydrated category_ids on event save,
  // even when only an unrelated session field changed.
  const saved = await f.request('one','PATCH',{title:'Unrelated edit',category_ids:initial.category_ids},group);
  assert.equal(saved.statusCode,200);
  assert.deepEqual(f.tables.complex_event_session[0].category_ids,[A,B]);
  assert.deepEqual(saved.body.category_ids,[A]);
  assert.ok(!JSON.stringify(saved.body).includes(B));
  assert.deepEqual((await f.request('one','GET',{},group)).body.category_ids,[A]);
  await f.request('one','PATCH',{category_ids:[]},group);
  assert.deepEqual(f.tables.complex_event_session[0].category_ids,[B]);
  assert.deepEqual((await f.request('one','GET',{},group)).body.categories,[]);
  await f.request('one','PATCH',{category_ids:[]});
  assert.deepEqual(f.tables.complex_event_session[0].category_ids,[]);
});
test('public response remains allowlisted and guest-safe for repeated tracks and legacy sessions', async () => {
  const f = fixture();
  await f.request('list', 'POST', { complex_event_id: 'event', title: 'Session', category_ids: [A, B], track_ids: ['track1', 'track2'], zoom_start_url: 'PRIVATE-HOST-URL' });
  const [row] = (await f.request('public')).body;
  assert.deepEqual(row.categories, [{ id: A, name: 'Practice' }]);
  assert.deepEqual(row.track_names, ['One', 'Two']);
  for (const secret of ['PRIVATE-HOST-URL', 'zoom_start_url', 'excluded_role_ids', 'category_ids', B]) assert.ok(!JSON.stringify(row).includes(secret), secret);
  delete f.tables.complex_event_session[0].category_ids;
  assert.deepEqual((await f.request('public')).body[0].categories, []);
});

test('real group-write guard uses the current event parent and rejects foreign targets', async () => {
  const f = fixture();
  f.tables.complex_event[0].member_group_id = 'group';
  f.tables.complex_event.push({id:'foreign',tenant_id:'other',member_group_id:'group'});
  const source = readFileSync(new URL('../_lib/groupAdminEventWrite.js', import.meta.url),'utf8')
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replaceAll('export ','');
  const authorize = new Function('supabase','hasAdminAccess','getCallerGroupEventsAccess',
    `${source}; return authorizeGroupAdminEventWrite;`)(f.db, async ctx=>!!ctx.tenantUserId,
    async()=>({groups:[{groupId:'group',complexEnabled:true}]}));
  const tenantCtx={tenantId:'tenant',isAuthenticated:true,memberId:'member'};
  assert.equal((await authorize({entity:'ComplexEventSession',op:'create',body:{complex_event_id:'event'},tenantCtx,req:{}})).ok,true);
  assert.equal((await authorize({entity:'ComplexEventSession',op:'update',body:{category_ids:[A]},
    existingRow:{complex_event_id:'event'},tenantCtx,req:{}})).ok,true);
  assert.equal((await authorize({entity:'ComplexEventSession',op:'update',body:{complex_event_id:'foreign'},
    existingRow:{complex_event_id:'event'},tenantCtx,req:{}})).status,403);
  assert.equal((await authorize({entity:'ComplexEventSession',op:'create',body:{complex_event_id:'foreign'},tenantCtx,req:{}})).status,403);
});
