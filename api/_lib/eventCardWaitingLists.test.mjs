import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { filterCountableEvents } from './eventAttendeeCountAccess.js';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = 'tenant-a';
async function loadHandler(path, deps) {
  const source = (await fs.readFile(new URL(path, import.meta.url), 'utf8'))
    .replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '')
    .replace('export default async function handler', 'async function handler');
  return new Function(...Object.keys(deps), `${source}; return handler;`)(...Object.values(deps));
}
function database(tables, failure) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, filters: [], fields: null };
    calls.push(call);
    let from = 0, to = Infinity, single = false;
    const query = {
      select(fields) { call.fields = fields; return this; },
      eq(key, value) { call.filters.push(row => row[key] === value); return this; },
      in(key, values) { call.filters.push(row => values.includes(row[key])); return this; },
      order() { return this; },
      range(a, b) { from = a; to = b; return this; },
      limit(n) { to = n - 1; return this; },
      maybeSingle() { single = true; return this; },
      then(resolve) {
        const rows = (tables[table] || []).filter(row => call.filters.every(fn => fn(row))).slice(from, to + 1);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: failure === table ? new Error('fixture unavailable') : null }).then(resolve);
      },
    };
    return query;
  }};
}
function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
}
const event = (n, props = {}) => ({ id: id(n), tenant_id: tenantId, ...props });
function dependencies(db, options = {}) {
  return {
    supabase: db, filterCountableEvents,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId, roleId: 'role', ...options.context }),
    hasAdminAccess: async () => options.admin ?? false,
    hasFeatureAccess: async () => options.global ?? false,
    getCallerGroupMembershipIds: async () => ({ groupIds: options.memberships || [] }),
    getCallerGroupEventsAccess: async () => ({ groups: (options.groups || []).map(groupId => ({ groupId })) }),
  };
}
test('counts active people, not registrations, across both event kinds and complete pages', async () => {
  const simple = [event(1, { waiting_list_enabled: true }), event(2)];
  const complex = [event(3, { waiting_list_enabled: true }), event(4), event(5, { waiting_list_enabled: true })];
  const entry = (event_id, event_kind, status = 'active', extra = {}) => ({ id: id(100), tenant_id: tenantId, event_id, event_kind, status, registration_id: 'one-registration', ...extra });
  const db = database({
    event: simple, complex_event: complex,
    booking: [{ event_id: id(1), tenant_id: tenantId, status: 'confirmed' }, ...['confirmed', 'cancelled', 'pending'].map(status => ({ event_id: id(2), tenant_id: tenantId, status }))],
    complex_event_booking: [{ event_id: id(4), tenant_id: tenantId, status: 'confirmed' }],
    event_waiting_entry: [
      ...Array.from({ length: 1101 }, (_, n) => entry(id(1), 'simple', 'active', { id: id(100 + n) })),
      entry(id(1), 'simple', 'withdrawn'), entry(id(1), 'complex'),
      entry(id(1), 'simple', 'active', { tenant_id: 'other' }),
      entry(id(3), 'complex'), entry(id(3), 'complex'), entry(id(3), 'complex', 'withdrawn'),
    ],
  });
  const handler = await loadHandler('../admin/events/attendee-counts.js', dependencies(db, { admin: true }));
  const res = response();
  await handler({ method: 'POST', body: { simpleEventIds: simple.map(e => e.id), complexEventIds: complex.map(e => e.id) } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.counts, { [id(1)]: 1101, [id(2)]: 2, [id(3)]: 2, [id(4)]: 1, [id(5)]: 0 });
  assert.ok(db.calls.filter(call => call.table === 'event_waiting_entry').every(call => call.fields === 'id,event_id,status'));
});
test('count failures are errors, not genuine zero', async () => {
  const db = database({ event: [event(1, { waiting_list_enabled: true })] }, 'event_waiting_entry');
  const handler = await loadHandler('../admin/events/attendee-counts.js', dependencies(db, { admin: true }));
  const res = response();
  await handler({ method: 'POST', body: { simpleEventIds: [id(1)] } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.data.counts, undefined);
});

test('waiting-list reader retrieves every active person across pages within event and tenant scope', async () => {
  const source = await fs.readFile(new URL('./eventWaitingList.js', import.meta.url), 'utf8');
  const readerSource = source.slice(source.indexOf('export async function listWaitingEntries')).replace('export ', '');
  const reader = new Function('WAITING_ENTRY_FIELDS', `${readerSource}; return listWaitingEntries;`)('id,event_id,event_kind,status');
  const entry = (n, extra = {}) => ({ id: id(n), tenant_id: tenantId, event_id: id(1), event_kind: 'simple', status: 'active', ...extra });
  const db = database({
    event: [event(1, { title: 'Current title' })],
    event_waiting_entry: [...Array.from({ length: 1001 }, (_, i) => entry(i + 10)),
      entry(2000, { status: 'withdrawn' }), entry(2001, { event_kind: 'complex' }),
      entry(2002, { tenant_id: 'other' }), entry(2003, { event_id: id(2) })],
  });
  const result = await reader(db, tenantId, { eventId: id(1), eventKind: 'simple' });
  assert.equal(result.length, 1001);
  assert.ok(result.every(row => row.event_title === 'Current title'));
  assert.equal(db.calls.filter(call => call.table === 'event_waiting_entry').length, 3);
});
for (const kind of ['simple', 'complex']) {
  for (const scenario of [
    { label: 'guest', context: { isAuthenticated: false }, status: 401 },
    { label: 'tenant admin', admin: true, status: 200 },
    { label: 'global viewer in private group', global: true, memberships: ['own'], status: 200 },
    { label: 'global viewer outside private group', global: true, status: 403 },
    { label: 'own group administrator', groups: ['own'], status: 200 },
    { label: 'unrelated group administrator', groups: ['other'], status: 403 },
    { label: 'ordinary member', status: 403 },
    { label: 'other tenant', admin: true, foreign: true, status: 403 },
  ]) {
    test(`${kind} waiting reader: ${scenario.label}`, async () => {
      const db = database({ [kind === 'simple' ? 'event' : 'complex_event']: [
        event(1, { member_group_id: 'own', tenant_id: scenario.foreign ? 'other' : tenantId }),
      ] });
      let reads = 0;
      const handler = await loadHandler('../admin/event-waiting-list.js', {
        ...dependencies(db, scenario),
        validWaitingId: value => value === id(1),
        listWaitingEntries: async (_, tenant, scope) => {
          reads++;
          assert.equal(tenant, tenantId);
          assert.deepEqual(scope, { eventId: id(1), eventKind: kind });
          return [{ id: 'entry' }];
        },
      });
      const res = response();
      await handler({ method: 'GET', query: { event_id: id(1), event_kind: kind } }, res);
      assert.equal(res.statusCode, scenario.status);
      assert.equal(reads, scenario.status === 200 ? 1 : 0);
    });
  }
}
