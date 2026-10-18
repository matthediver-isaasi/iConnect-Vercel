import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

Error.stackTraceLimit = 0;
const slot = '__ticketAudienceEntityFixture';
const tenantId = '10000000-0000-0000-0000-000000000001';
const memberId = '20000000-0000-0000-0000-000000000001';
const otherId = '20000000-0000-0000-0000-000000000002';
const eventId = '30000000-0000-0000-0000-000000000001';
const groupId = '40000000-0000-0000-0000-000000000001';
const handlers = {};

async function loadHandler(record) {
  if (handlers[record]) return handlers[record];
  const entry = resolve(`api/entities/[entity]/${record ? '[id].js' : 'index.js'}`);
  const source = await readFile(entry, 'utf8');
  const sideEffects = new Map();
  for (const [, names, specifier] of source.matchAll(/import\s+(\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g)) {
    if (/\/(workflows|zohoCrmSync|memberContentReindexHook|searchTextBuilder|wpWebhook|emailService|memberGroupActivity|memberGroupProjectsAccess|memberGroupForumAccess|memberGroupFilesAccess)\.js$/.test(specifier)) {
      sideEffects.set(specifier, names.replace(/[{}]/g, '').split(',').filter(name => name.trim())
        .map(name => `export async function ${name.trim()}() { return null; }`).join('\n'));
    }
  }
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{
      name: 'ticket-audience-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (/\/(database|tenantContext|session|memberGroupEventsAccess|planQuota|publicBaseUrl)\.js$/.test(args.path)
            || sideEffects.has(args.path)) return { path: args.path, namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          let contents = sideEffects.get(path);
          if (path.endsWith('/database.js')) contents = `export const supabase = {from: (...args) => globalThis.${slot}.db.from(...args), rpc: (...args) => globalThis.${slot}.db.rpc(...args)};`;
          if (path.endsWith('/tenantContext.js')) contents = `
            export const TENANT_SCOPE = {GLOBAL:'global',TENANT:'tenant',ORGANIZATION:'organization',MEMBER:'member'};
            export const getTenantContext = async () => globalThis.${slot}.ctx;
            export const getEntityTenantScope = () => TENANT_SCOPE.TENANT;
            export const getTenantColumn = () => 'tenant_id';
            export const hasAdminAccess = async ctx => ctx.admin === true;
            export const hasFeatureAccess = async () => false;
            export const checkCrossOrgPermissions = async () => ({hasCrossOrgAccess:false});
            export const checkCrossMemberPermissions = async () => ({hasCrossMemberAccess:false});`;
          if (path.endsWith('/session.js')) contents = `
            export const getSession = async () => globalThis.${slot}.session;
            export const getSessionMember = async () => globalThis.${slot}.member;
            export const invalidateMemberSessions = async () => {};
            export const invalidateOrganizationMemberSessions = async () => {};
            export const revokeBlockedOrganisationMemberSessionsForTenant = async () => {};`;
          if (path.endsWith('/memberGroupEventsAccess.js')) contents = `export const getCallerGroupEventsAccess = async () => ({groups:globalThis.${slot}.groups,tenantContext:globalThis.${slot}.ctx});`;
          if (path.endsWith('/planQuota.js')) contents = 'export const checkMemberQuota = async () => ({ok:true}); export const checkEventQuota = async () => ({ok:true});';
          if (path.endsWith('/publicBaseUrl.js')) contents = "export const getTrustedBaseUrlForTenant = async () => 'https://fixture.invalid'; export const getTenantTrustedBaseUrl = getTrustedBaseUrlForTenant; export const getPublicBaseUrl = getTrustedBaseUrlForTenant;";
          if (!contents) throw new Error(`Unconfigured boundary ${path}`);
          return { contents, loader: 'js' };
        });
      },
    }],
  });
  await mkdir('.cache', { recursive: true });
  const output = resolve(`.cache/ticket-audience-entity-${record ? 'record' : 'list'}.mjs`);
  await writeFile(output, result.outputFiles[0].text);
  handlers[record] = (await import(pathToFileURL(output).href)).default;
  return handlers[record];
}

function fixture({ actor = 'selected', manager = false } = {}) {
  const tickets = [
    { id: 'hidden', audience_mode: 'selected_members', selected_member_ids: [otherId] },
    { id: 'selected', audience_mode: 'selected_members', selected_member_ids: [memberId] },
    { id: 'legacy', audience_mode: null, selected_member_ids: [] },
  ].map(row => ({ ...row, tenant_id: tenantId, complex_event_id: eventId, name: row.id, visibility_mode: 'members_only', is_free: true, price: 0 }));
  const member = actor === 'guest' ? null : { id: actor === 'other' ? otherId : memberId,
    tenant_id: actor === 'foreign' ? 'foreign' : tenantId, email: 'person@example.test', login_enabled: true };
  const ctx = { isAuthenticated: actor !== 'guest', tenantId, effectiveTenantId: tenantId,
    memberId: member?.id, tenantUserId: actor === 'admin' ? 'admin' : null, admin: actor === 'admin' };
  const rows = {
    member: member ? [member, ...(actor === 'admin' || manager ? [{ id: otherId, tenant_id: tenantId }] : [])] : [],
    complex_event_ticket_class: tickets,
    event: [{ id: eventId, tenant_id: tenantId, title: 'Event', member_group_id: groupId, pricing_config: { ticket_classes: tickets } }],
    complex_event: [{ id: eventId, tenant_id: tenantId, title: 'Event', member_group_id: groupId }],
  };
  const queries = [], writes = [];
  const db = { from(table) {
    const trace = { table, calls: [] }; queries.push(trace);
    const filters = [];
    let singular = false, start = 0, end = Infinity, mutation = null;
    const query = {
      select(...args) { trace.calls.push(['select', ...args]); return this; },
      eq(key, value) { trace.calls.push(['eq', key, value]); filters.push(row => row[key] === value); return this; },
      neq(key, value) { filters.push(row => row[key] !== value); return this; },
      in(key, values) { trace.calls.push(['in', key, values]); filters.push(row => values.includes(row[key])); return this; },
      is(key, value) { filters.push(row => row[key] === value || (value === null && row[key] == null)); return this; },
      or(clause) {
        trace.calls.push(['or', clause]);
        if (clause.includes('audience_mode')) {
          const selectedMember = clause.match(/selected_member_ids\.cs\.\{([^}]+)\}/)?.[1];
          const managedIds = clause.match(/complex_event_id\.in\.\(([^)]+)\)/)?.[1]?.split(',') || [];
          filters.push(row => row.audience_mode == null || row.audience_mode === 'legacy'
            || (row.audience_mode === 'selected_members' && selectedMember && row.selected_member_ids?.includes(selectedMember))
            || managedIds.includes(row.complex_event_id));
        } else throw new Error(`Unexpected OR scope: ${clause}`);
        return this;
      },
      not() { return this; },
      order(...args) { trace.calls.push(['order', ...args]); return this; },
      range(from, to) { trace.calls.push(['range', from, to]); start = from; end = to; return this; },
      limit(value) { trace.calls.push(['limit', value]); end = Number(value) - 1; return this; },
      single() { singular = true; return this; },
      maybeSingle() { singular = true; return this; },
      insert(body) { mutation = ['insert', body]; return this; },
      update(body) { mutation = ['update', body]; return this; },
      then(ok, fail) {
        let matches = (rows[table] || []).filter(row => filters.every(filter => filter(row)));
        if (mutation) {
          writes.push([table, ...mutation]);
          if (mutation[0] === 'insert') {
            matches = [{ id: 'created', ...mutation[1] }]; (rows[table] ||= []).push(...matches);
          } else matches.forEach(row => Object.assign(row, mutation[1]));
        }
        const count = matches.length;
        const result = structuredClone(matches.slice(start, end + 1));
        return Promise.resolve({ data: singular ? result[0] || null : result,
          error: singular && !result.length ? { code: 'PGRST116', message: 'No rows' } : null, count }).then(ok, fail);
      },
    };
    return query;
  }, rpc(name) { throw new Error(`Unexpected RPC ${name}`); } };
  return { db, rows, queries, writes, ctx, member, session: member ? { data: { memberId: member.id } } : null,
    groups: manager ? [{ groupId, simpleEnabled: true, complexEnabled: true }] : [] };
}

async function invoke(state, { entity = 'ComplexEventTicketClass', id, method = 'GET', query = {}, body = {} } = {}) {
  globalThis[slot] = state;
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
  await (await loadHandler(!!id))({ method, headers: {}, query: { entity, ...(id ? { id } : {}), ...query }, body }, res);
  return res;
}

for (const actor of ['selected', 'other', 'guest', 'foreign']) {
  test(`real list: ${actor} scope/count occurs before range and no selected-member lists escape`, async () => {
    const state = fixture({ actor });
    const result = await invoke(state, { query: { count: 'exact', limit: '1', offset: '0' } });
    if (actor === 'guest') {
      assert.equal(result.statusCode, 401);
      assert.equal(JSON.stringify(result.body).includes('selected_member_ids'), false);
      return;
    }
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    const expected = actor === 'selected' ? 'selected' : actor === 'other' ? 'hidden' : 'legacy';
    assert.equal(result.body.data[0].id, expected);
    assert.equal(result.body.count, ['selected', 'other'].includes(actor) ? 2 : 1);
    assert.equal(JSON.stringify(result.body).includes('selected_member_ids'), false);
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
    const calls = state.queries.find(query => query.table === 'complex_event_ticket_class').calls;
    assert.ok(calls.findIndex(call => call[0] === 'or') < calls.findIndex(call => ['range', 'limit'].includes(call[0])));
  });
}

for (const actor of ['selected', 'other', 'guest', 'foreign']) {
  test(`real by-ID ${actor}: private row follows viewer; simple pricing is redacted`, async () => {
    const state = fixture({ actor });
    const result = await invoke(state, { id: 'selected' });
    assert.equal(result.statusCode, actor === 'guest' ? 401 : actor === 'selected' ? 200 : 404, JSON.stringify(result.body));
    assert.equal(JSON.stringify(result.body).includes('selected_member_ids'), false);
    const simple = await invoke(state, { entity: 'Event', id: eventId });
    if (actor === 'guest') {
      assert.equal(simple.statusCode, 401);
      assert.equal(JSON.stringify(simple.body).includes('selected_member_ids'), false);
      return;
    }
    assert.equal(simple.statusCode, 200, JSON.stringify(simple.body));
    assert.equal(JSON.stringify(simple.body).includes('selected_member_ids'), false);
    assert.equal(simple.body.pricing_config.ticket_classes.some(ticket => ticket.id === 'selected'), actor === 'selected');
  });
}

for (const config of [{ actor: 'admin' }, { actor: 'selected', manager: true }]) {
  test(`real administrator/manager reads retain full lists: ${JSON.stringify(config)}`, async () => {
    const state = fixture(config);
    const result = await invoke(state, { query: { count: 'exact' } });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.count, 3);
    assert.deepEqual(result.body.data.find(row => row.id === 'hidden').selected_member_ids, [otherId]);
    const direct = await invoke(state, { id: 'hidden' });
    assert.equal(direct.statusCode, 200, JSON.stringify(direct.body));
    assert.deepEqual(direct.body.selected_member_ids, [otherId]);
    const event = await invoke(state, { entity: 'Event', id: eventId });
    assert.deepEqual(event.body.pricing_config.ticket_classes[0].selected_member_ids, [otherId]);
  });
}

test('real list and by-ID reject projections, aliases, policy filters and sort before querying', async () => {
  for (const entity of ['Event', 'ComplexEvent', 'ComplexEventTicketClass']) {
    for (const id of [undefined, entity === 'ComplexEventTicketClass' ? 'selected' : eventId]) {
      for (const query of [{ expand: 'id,name' }, { expand: 'x:selected_member_ids' },
        { expand: 'x:pricing_config' }, { filter: JSON.stringify({ selected_member_ids: memberId }) },
        { filter: JSON.stringify({ 'pricing_config->ticket_classes': memberId }) }, { sort: 'audience_mode' }]) {
        const state = fixture();
        const result = await invoke(state, { entity, id, query });
        assert.equal(result.statusCode, 400, JSON.stringify({ entity, id, query, response: result.body }));
        assert.equal(state.queries.length, 0);
      }
    }
  }
});

test('ordinary ticket mutation is denied without returning its audience; admin mutation response remains editable', async () => {
  const deniedState = fixture();
  const denied = await invoke(deniedState, { id: 'hidden', method: 'PATCH', body: { name: 'Renamed' } });
  assert.equal(denied.statusCode, 403, JSON.stringify(denied.body));
  assert.equal(JSON.stringify(denied.body).includes('selected_member_ids'), false);
  assert.deepEqual(deniedState.writes, []);
  const state = fixture({ actor: 'admin' });
  const result = await invoke(state, { id: 'hidden', method: 'PATCH', body: { name: 'Renamed' } });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.selected_member_ids, [otherId]);
});

test('safe ID filtering cannot recover hidden tickets or inflate their exact count', async () => {
  const state = fixture();
  const denied = await invoke(state, { query: { filter: JSON.stringify({ id: 'hidden' }), count: 'exact' } });
  assert.equal(denied.statusCode, 200, JSON.stringify(denied.body));
  assert.deepEqual(denied.body, { data: [], count: 0 });
  const allowed = await invoke(state, { query: { filter: JSON.stringify({ id: 'selected' }), count: 'exact' } });
  assert.equal(allowed.body.count, 1);
  assert.equal(allowed.body.data[0].private_ticket_eligible, true);
  assert.equal(JSON.stringify(allowed.body).includes('selected_member_ids'), false);
});

test('manager authority is limited to managed event and tenant, not all private rows', async () => {
  const state = fixture({ manager: true });
  state.rows.complex_event_ticket_class.push({
    ...state.rows.complex_event_ticket_class[0], id: 'unmanaged',
    complex_event_id: '30000000-0000-0000-0000-000000000002',
  }, { ...state.rows.complex_event_ticket_class[0], id: 'foreign', tenant_id: 'foreign' });
  const result = await invoke(state, { query: { count: 'exact' } });
  assert.equal(result.body.count, 3);
  assert.equal(result.body.data.some(row => ['unmanaged', 'foreign'].includes(row.id)), false);
  assert.equal((await invoke(state, { id: 'unmanaged' })).statusCode, 404);
  assert.equal((await invoke(state, { id: 'foreign' })).statusCode, 404);
});

test('group manager ticket mutation response retains the full editable audience', async () => {
  const state = fixture({ manager: true });
  const result = await invoke(state, { id: 'hidden', method: 'PATCH', body: { name: 'Manager renamed' } });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.selected_member_ids, [otherId]);
});

for (const flags of [
  { simpleEnabled: true, complexEnabled: false },
  { simpleEnabled: false, complexEnabled: true },
]) {
  test(`real list/by-ID/count isolate group admin authority by event type: ${JSON.stringify(flags)}`, async () => {
    const state = fixture({ manager: true });
    state.groups = [{ groupId, ...flags }];
    // Exercise the parent complex-event projection too, even if a historical
    // pricing JSON also contains audience configuration.
    state.rows.complex_event[0].pricing_config = structuredClone(state.rows.event[0].pricing_config);
    const tickets = await invoke(state, { query: { count: 'exact', limit: '1', offset: '0' } });
    assert.equal(tickets.statusCode, 200);
    assert.equal(tickets.body.count, flags.complexEnabled ? 3 : 2);
    assert.equal(JSON.stringify(tickets.body).includes('selected_member_ids'), flags.complexEnabled);
    const privateTicket = await invoke(state, { id: 'hidden' });
    assert.equal(privateTicket.statusCode, flags.complexEnabled ? 200 : 404);
    for (const [entity, enabled] of [['Event', flags.simpleEnabled], ['ComplexEvent', flags.complexEnabled]]) {
      for (const id of [undefined, eventId]) {
        const result = await invoke(state, { entity, id });
        assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        const row = id ? result.body : result.body[0];
        assert.equal(JSON.stringify(row).includes('selected_member_ids'), enabled);
        assert.equal(row.pricing_config.ticket_classes.some(ticket => ticket.id === 'hidden'), enabled);
        if (!enabled) assert.equal(row.pricing_config.ticket_classes.find(ticket => ticket.id === 'selected').private_ticket_eligible, true);
      }
    }
    const ticketQueries = state.queries.filter(query => query.table === 'complex_event_ticket_class');
    for (const query of ticketQueries) {
      assert.equal(query.calls.find(call => call[0] === 'or')[1].includes('complex_event_id.in.'), flags.complexEnabled);
    }
  });
}

test('ordinary create mutation cannot return private policies; admin create retains editable list', async () => {
  const deniedState = fixture();
  const body = { ...deniedState.rows.complex_event_ticket_class[0], id: 'created-ticket' };
  const denied = await invoke(deniedState, { method: 'POST', body });
  assert.equal(denied.statusCode, 403, JSON.stringify(denied.body));
  assert.equal(JSON.stringify(denied.body).includes('selected_member_ids'), false);
  assert.deepEqual(deniedState.writes, []);
  const state = fixture({ actor: 'admin' });
  const created = await invoke(state, { method: 'POST', body });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.selected_member_ids, [otherId]);
});

for (const entity of ['Booking', 'ComplexEventBooking']) {
  test(`generic ${entity} rejects private target on insert, mixed bulk and PATCH before mutation`, async () => {
    const table = entity === 'Booking' ? 'booking' : 'complex_event_booking';
    for (const bulk of [false, true]) {
      const state = fixture();
      const privateTarget = { event_id: eventId, tenant_id: tenantId, ticket_class_id: 'hidden' };
      const body = bulk ? [{ ...privateTarget, ticket_class_id: 'legacy' }, privateTarget] : privateTarget;
      const result = await invoke(state, { entity, method: 'POST', body });
      assert.equal(result.statusCode, 403, JSON.stringify(result.body));
      assert.equal(JSON.stringify(result.body).includes('selected_member_ids'), false);
      assert.deepEqual(state.writes, []);
    }
    const state = fixture();
    state.rows[table] = [{ id: 'existing-booking', tenant_id: tenantId, event_id: eventId, ticket_class_id: 'legacy', member_id: memberId }];
    const result = await invoke(state, { entity, id: 'existing-booking', method: 'PATCH', body: { ticket_class_id: 'hidden' } });
    assert.equal(result.statusCode, 403, JSON.stringify(result.body));
    assert.deepEqual(state.writes, []);
    assert.equal(state.rows[table][0].ticket_class_id, 'legacy');
  });
}
