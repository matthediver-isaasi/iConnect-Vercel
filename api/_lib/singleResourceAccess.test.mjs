import test from 'node:test';
import assert from 'node:assert/strict';
import { readSingleResource, createSingleResourceHandler, canAccessResourceEvents } from './singleResourceAccess.js';

const id = '11111111-1111-4111-8111-111111111111';
const ctx = { tenantId: 'tenant', memberId: 'member', roleId: 'role', isAuthenticated: true };
const base = { id, tenant_id: 'tenant', status: 'active', is_public: false, target_url: 'secret', subcategories: [] };
function database(tables = {}, failTable) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      let data = tables[table] || [];
      const q = {
        select() { return q; },
        eq(k, v) { call.filters.push([k, v]); data = data.filter(r => r[k] === v); return q; },
        in(k, v) { data = data.filter(r => v.includes(r[k])); return q; },
        ilike(k, v) { data = data.filter(r => r[k]?.toLowerCase() === v.toLowerCase()); return q; },
        limit(n) { data = data.slice(0, n); return q; },
        order() { return q; },
        then(resolve) { return Promise.resolve({ data, error: table === failTable ? new Error('database failure') : null }).then(resolve); },
      };
      return q;
    },
  };
}
async function read(resource = {}, extra = {}, options = {}) {
  const db = database({ resource: [{ ...base, ...resource }], ...extra });
  const value = await readSingleResource({ db, ctx, id, isAdmin: false, categoryPrivileged: false, ...options });
  return { value, db };
}
test('one tenant-scoped resource; no group or booking queries without associations', async () => {
  const { value, db } = await read();
  assert.equal(value.target_url, 'secret');
  assert.equal('allowed_role_ids' in value, false);
  assert.deepEqual(db.calls.map(c => c.table), ['resource', 'resource_category']);
  assert.deepEqual(db.calls[0].filters, [['tenant_id', 'tenant'], ['id', id], ['status', 'active']]);
});
test('inactive, draft, foreign tenant and missing resources are unavailable', async () => {
  for (const resource of [{ status: 'draft' }, { status: 'inactive' }, { tenant_id: 'other' }, { id: 'other' }]) {
    assert.equal((await read(resource)).value, null);
  }
});
test('private role allowlist, roleless fail-closed, public and admin exceptions', async () => {
  assert.equal((await read({ allowed_role_ids: ['other'] })).value, null);
  assert.equal((await read({}, {}, { ctx: { ...ctx, roleId: null } })).value, null);
  assert.ok((await read({ allowed_role_ids: ['role'] })).value);
  assert.ok((await read({ is_public: true }, {}, { ctx: { ...ctx, roleId: null } })).value);
  assert.ok((await read({ allowed_role_ids: ['other'] }, {}, { isAdmin: true })).value);
  assert.equal((await read({ status: 'draft' }, {}, { isAdmin: true })).value, null);
});
test('category and subcategory exclusions; visible wins; hidden names trimmed', async () => {
  const category = { tenant_id: 'tenant', subcategories: ['Hidden'], excluded_role_ids: ['role'] };
  assert.equal((await read({ subcategories: ['Hidden'] }, { resource_category: [category] })).value, null);
  assert.equal((await read({ subcategories: ['Hidden'] }, { resource_category: [{
    ...category, excluded_role_ids: [], subcategory_excluded_role_ids: { Hidden: ['role'] },
  }] })).value, null);
  const { value } = await read({ subcategories: ['Hidden', 'Legacy'] }, { resource_category: [category] });
  assert.deepEqual(value.subcategories, ['Legacy']);
  assert.ok((await read({ subcategories: ['Hidden'] }, { resource_category: [
    category, { ...category, excluded_role_ids: [] },
  ] })).value);
  assert.ok((await read({ subcategories: ['Hidden'] }, { resource_category: [category] }, { categoryPrivileged: true })).value);
});
test('group resources require active own group sharing or unexpired membership', async () => {
  const resource = { member_group_id: 'group', subcategories: ['Shared'] };
  const group = { id: 'group', tenant_id: 'tenant', is_active: true, resource_subcategories: [] };
  assert.equal((await read(resource)).value, null);
  assert.equal((await read(resource, { member_group: [group] })).value, null);
  assert.ok((await read(resource, { member_group: [{ ...group, resource_subcategories: ['Shared'] }] })).value);
  assert.equal((await read(resource, { member_group: [{ ...group, tenant_id: 'other', resource_subcategories: ['Shared'] }] })).value, null);
  for (const [expires_at, allowed] of [[null, true], ['2999-01-01', true], ['2000-01-01', false], ['invalid', false]]) {
    const result = await read(resource, { member_group: [group], member_group_assignment: [
      { group_id: 'group', member_id: 'member', expires_at },
    ] });
    assert.equal(!!result.value, allowed);
  }
  assert.equal((await read(resource, { member_group: [{ ...group, is_active: false, resource_subcategories: ['Shared'] }] })).value, null);
});
test('narrow event-admin group entitlement is not a blanket admin or content bypass', async () => {
  const resource = { member_group_id: 'group' };
  const tables = { member_group: [{ id: 'group', tenant_id: 'tenant', is_active: true }] };
  assert.equal((await read(resource, tables, { isAdmin: true })).value, null);
  assert.ok((await read(resource, tables, { canAdministerGroupContent: true })).value);
  assert.equal((await read({ ...resource, allowed_role_ids: ['other'] }, tables, { canAdministerGroupContent: true })).value, null);
  assert.equal((await read(resource, tables, {
    canAdministerGroupContent: true, eventAccess: async () => false,
  })).value, null);
});
test('handler derives group-admin entitlement from role and member exclusions', async () => {
  for (const denied of [false, true]) {
    const featureCalls = [];
    const context = { ...ctx, memberExcludedFeatures: denied ? ['events.browse-events.create'] : [] };
    const handler = createSingleResourceHandler({
      db: database({ resource: [{ ...base, member_group_id: 'group' }],
        member_group: [{ id: 'group', tenant_id: 'tenant', is_active: true }] }),
      getContext: async () => context,
      hasAdminAccess: async () => false,
      hasFeatureAccess: async (role, feature, excluded = []) => {
        featureCalls.push([role, feature, excluded]);
        return feature === 'events.browse-events.create' && !excluded.includes(feature);
      },
    });
    const response = { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
    await handler({ method: 'GET', query: { id } }, response);
    assert.equal(response.code, denied ? 404 : 200);
    assert.deepEqual(featureCalls.find(c => c[1] === 'events.browse-events.create'),
      ['role', 'events.browse-events.create', context.memberExcludedFeatures]);
  }
});
test('linked event denial never exposes resource, admin bypasses event checks', async () => {
  assert.equal((await read({}, {}, { eventAccess: async () => false })).value, null);
  assert.ok((await read({}, {}, { isAdmin: true, eventAccess: async () => { throw Error('must not run'); } })).value);
});
test('event booking requires correct tenant, confirmed status, member or attendee identity', async () => {
  const resource = { linked_events: [{ event_id: 'event' }] };
  const member = [{ id: 'member', tenant_id: 'tenant', email: 'a@example.test' }];
  const booking = { tenant_id: 'tenant', event_id: 'event', status: 'confirmed', member_id: 'member' };
  for (const [changes, allowed] of [[{}, true], [{ tenant_id: 'other' }, false],
    [{ status: 'cancelled' }, false], [{ member_id: 'other' }, false],
    [{ member_id: 'other', attendee_email: 'A@EXAMPLE.TEST' }, true]]) {
    const db = database({ member, booking: [{ ...booking, ...changes }] });
    assert.equal(await canAccessResourceEvents(db, resource, ctx), allowed);
  }
});
test('session tracks checked against booked event and ticket class', async () => {
  const resource = { linked_events: [{ event_id: 'event', session_id: 'session' }] };
  const tables = {
    member: [{ id: 'member', tenant_id: 'tenant' }],
    complex_event_booking: [{ tenant_id: 'tenant', member_id: 'member', event_id: 'event', status: 'confirmed', ticket_class_id: 'ticket' }],
    complex_event_session: [{ tenant_id: 'tenant', id: 'session', complex_event_id: 'event' }],
    complex_event_session_track: [{ tenant_id: 'tenant', complex_event_session_id: 'session', complex_event_track_id: 'track' }],
    complex_event_ticket_class: [{ tenant_id: 'tenant', id: 'ticket', complex_event_id: 'event', linked_track_ids: ['track'] }],
  };
  assert.equal(await canAccessResourceEvents(database(tables), resource, ctx), true);
  tables.complex_event_ticket_class[0].linked_track_ids = [];
  assert.equal(await canAccessResourceEvents(database(tables), resource, ctx), false);
  tables.complex_event_ticket_class[0].all_tracks = true;
  assert.equal(await canAccessResourceEvents(database(tables), resource, ctx), true);
  tables.complex_event_session[0].complex_event_id = 'other';
  assert.equal(await canAccessResourceEvents(database(tables), resource, ctx), false);
});
test('ticketless-only complex bookings preserve existing session access gate', async () => {
  const tables = {
    member: [{ id: 'member', tenant_id: 'tenant' }],
    complex_event_booking: [{ tenant_id: 'tenant', member_id: 'member', event_id: 'event', status: 'confirmed', ticket_class_id: null }],
    complex_event_session: [{ tenant_id: 'tenant', id: 'session', complex_event_id: 'event' }],
  };
  const sessionResource = { linked_events: [{ event_id: 'event', session_id: 'session' }] };
  assert.equal(await canAccessResourceEvents(database(tables), sessionResource, ctx), false);
  // Whole-event eligibility remains unaffected by the session-specific gate.
  assert.equal(await canAccessResourceEvents(database(tables), { linked_events: [{ event_id: 'event' }] }, ctx), true);
  tables.complex_event_booking.push({ ...tables.complex_event_booking[0], ticket_class_id: 'ticket' });
  tables.complex_event_ticket_class = [{ id: 'ticket', tenant_id: 'tenant', complex_event_id: 'event', all_tracks: true }];
  assert.equal(await canAccessResourceEvents(database(tables), sessionResource, ctx), true);
});
test('handler rejects guests/mismatched sessions, malformed IDs; denies without targets and fails closed on errors', async () => {
  for (const [context, identifier, tables, failTable, expected] of [
    [{}, id, {}, null, 401], [{ ...ctx, tenantMismatch: true }, id, {}, null, 401],
    [ctx, 'invalid', {}, null, 404], [ctx, id, {}, null, 404],
    [ctx, id, { resource: [base] }, 'resource_category', 500],
    [ctx, id, { resource: [base] }, null, 200],
  ]) {
    const db = database(tables, failTable);
    const handler = createSingleResourceHandler({ db, getContext: async () => context,
      hasAdminAccess: async () => false, hasFeatureAccess: async () => false });
    const response = { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { id: identifier } }, response);
    assert.equal(response.code, expected);
    if (expected !== 200) assert.equal(JSON.stringify(response.body).includes('secret'), false);
    if (expected === 401 || identifier === 'invalid') assert.equal(db.calls.length, 0);
  }
});