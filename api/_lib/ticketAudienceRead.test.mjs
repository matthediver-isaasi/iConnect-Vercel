import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tenantId = '10000000-0000-0000-0000-000000000001';
const memberId = '20000000-0000-0000-0000-000000000001';
const otherMember = '20000000-0000-0000-0000-000000000002';
const eventId = '30000000-0000-0000-0000-000000000001';
const groupId = '40000000-0000-0000-0000-000000000001';
const source = (await readFile(new URL('./ticketAudienceRead.js', import.meta.url), 'utf8'))
  .replace("'../../shared/ticketAudience.js'", JSON.stringify(new URL('../../shared/ticketAudience.js', import.meta.url).href))
  .replaceAll("'../../shared/ticketAudienceProjection.js'", JSON.stringify(new URL('../../shared/ticketAudienceProjection.js', import.meta.url).href))
  .replace("import { loadPrivateTicketViewer } from './privateTicketAccess.js';", 'const loadPrivateTicketViewer = async req => req.viewer || null;')
  .replace("import { hasAdminAccess } from './tenantContext.js';", 'const hasAdminAccess = async ctx => ctx.admin === true;')
  .replace("import { getCallerGroupEventsAccess } from './memberGroupEventsAccess.js';", 'const getCallerGroupEventsAccess = async req => req.groupAccess || {groups: []};');
const { filterViewerTickets, projectSimpleTicketAudience, loadTicketAudienceReadContext,
  scopeTicketAudienceQuery, projectTicketAudienceRows, ticketAudienceProjectionError } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const viewer = { memberId, tenantId };
const legacy = { id: 'legacy', selected_member_ids: [otherMember], private_ticket_eligible: true };
const selected = { id: 'selected', audience_mode: 'selected_members', selected_member_ids: [memberId], tenant_id: tenantId };
const hidden = { ...selected, id: 'hidden', selected_member_ids: [otherMember] };
const context = overrides => ({ tenantId, viewer, admin: false, simpleGroups: new Set(), complexGroups: new Set(), managedComplexIds: new Set(), ...overrides });

test('read projection filters guest/nonselected/cross-tenant and strips all lists including legacy stale lists', () => {
  for (const person of [null, { memberId: otherMember, tenantId: 'foreign' }, { memberId, tenantId: 'foreign' }]) {
    assert.deepEqual(filterViewerTickets([legacy, selected], person, tenantId), [{ id: 'legacy', audience_mode: 'legacy' }]);
  }
  const rows = filterViewerTickets([legacy, selected, hidden], viewer, tenantId);
  assert.deepEqual(rows.map(row => row.id), ['legacy', 'selected']);
  assert.equal(rows[1].private_ticket_eligible, true);
  assert.equal(JSON.stringify(rows).includes('selected_member_ids'), false);
  assert.equal(legacy.private_ticket_eligible, true, 'does not mutate source');
});

test('simple and complex-event nested pricing projects parsed/string JSON without losing pricing fields', () => {
  for (const pricing_config of [{ currency: 'gbp', ticket_classes: [selected, hidden] },
    JSON.stringify({ currency: 'gbp', ticket_classes: [selected, hidden] })]) {
    const projected = projectSimpleTicketAudience({ id: eventId, pricing_config }, viewer, tenantId);
    assert.equal(projected.pricing_config.currency, 'gbp');
    assert.deepEqual(projected.pricing_config.ticket_classes.map(row => row.id), ['selected']);
    assert.equal(JSON.stringify(projected).includes('selected_member_ids'), false);
  }
  assert.throws(() => projectSimpleTicketAudience({ pricing_config: '{invalid' }, viewer, tenantId), /verify ticket audience/);
});

test('admin and event manager retain complete editable lists; ordinary members do not', () => {
  const row = { ...hidden, complex_event_id: eventId };
  assert.deepEqual(projectTicketAudienceRows([row], 'complexeventticketclass', context({ admin: true })), [row]);
  assert.deepEqual(projectTicketAudienceRows([row], 'complexeventticketclass', context({ managedComplexIds: new Set([eventId]) })), [row]);
  assert.deepEqual(projectTicketAudienceRows([row], 'complexeventticketclass', context()), []);
  const event = { id: eventId, tenant_id: tenantId, member_group_id: groupId, pricing_config: { ticket_classes: [hidden] } };
  for (const entity of ['event', 'complexevent']) {
    assert.deepEqual(projectTicketAudienceRows([event], entity, context({ simpleGroups: new Set([groupId]), complexGroups: new Set([groupId]) })), [event]);
    assert.deepEqual(projectTicketAudienceRows([event], entity, context())[0].pricing_config.ticket_classes, []);
  }
  assert.deepEqual(projectTicketAudienceRows([{ ...row, tenant_id: 'foreign' }], 'complexeventticketclass', context()), []);
});

test('database audience scope includes selected and managed rows before count/page, never untrusted IDs', () => {
  const calls = [];
  const query = { or(clause) { calls.push(clause); return this; } };
  assert.equal(scopeTicketAudienceQuery(query, 'complexeventticketclass', context()), query);
  assert.equal(calls.pop(), `audience_mode.is.null,audience_mode.eq.legacy,and(audience_mode.eq.selected_members,selected_member_ids.cs.{${memberId}})`);
  scopeTicketAudienceQuery(query, 'complexeventticketclass', context({ viewer: null, managedComplexIds: new Set([eventId, 'bad),id.neq.null']) }));
  assert.equal(calls.pop(), `audience_mode.is.null,audience_mode.eq.legacy,complex_event_id.in.(${eventId})`);
  scopeTicketAudienceQuery(query, 'complexeventticketclass', context({ admin: true }));
  scopeTicketAudienceQuery(query, 'event', context());
  assert.equal(calls.length, 0);
});

test('projection/aliases, JSON-path filters and sort cannot be used as audience oracles', () => {
  for (const entity of ['event', 'complexevent', 'complexeventticketclass']) {
    for (const expand of ['id,name', 'x:selected_member_ids', 'id,secret:pricing_config', '*']) {
      assert.match(ticketAudienceProjectionError(entity, { expand }), /projections/);
    }
    for (const filter of ['{"selected_member_ids":"x"}', '{"pricing_config->ticket_classes":"x"}', { audience_mode: 'selected_members' }]) {
      assert.match(ticketAudienceProjectionError(entity, { filter }), /cannot be searched/);
    }
    assert.match(ticketAudienceProjectionError(entity, { sort: 'selected_member_ids' }), /cannot be searched/);
    assert.equal(ticketAudienceProjectionError(entity, { filter: '{"id":"ticket"}', sort: 'name' }), null);
  }
  assert.match(ticketAudienceProjectionError('booking', { expand: 'id,x:event(pricing_config)' }), /projections/);
});

test('read context requires tenant-matched group authority; admin skips viewer lookup and group DB read', async () => {
  const queries = [];
  const db = { from(table) {
    queries.push(table);
    return { select() { return this; }, eq(key, value) { assert.equal(value, tenantId); return this; },
      async in(key, value) { assert.deepEqual(value, [groupId]); return { data: [{ id: eventId }], error: null }; } };
  } };
  const ctx = { isAuthenticated: true, tenantId, memberId };
  const req = { viewer, groupAccess: { groups: [{ groupId, simpleEnabled: true, complexEnabled: true }], tenantContext: { tenantId } } };
  const manager = await loadTicketAudienceReadContext({ req, ctx, db });
  assert.deepEqual([...manager.managedComplexIds], [eventId]);
  assert.deepEqual(manager.viewer, viewer);
  const outsider = await loadTicketAudienceReadContext({ req: { ...req, groupAccess: { ...req.groupAccess, tenantContext: { tenantId: 'other' } } }, ctx, db });
  assert.equal(outsider.simpleGroups.size, 0);
  assert.equal(outsider.complexGroups.size, 0);
  const admin = await loadTicketAudienceReadContext({ req, ctx: { ...ctx, admin: true }, db });
  assert.equal(admin.admin, true);
  assert.equal(admin.viewer, null);
  assert.deepEqual(queries, ['complex_event']);
});

for (const flags of [
  { simpleEnabled: true, complexEnabled: false },
  { simpleEnabled: false, complexEnabled: true },
  { simpleEnabled: false, complexEnabled: false },
  { simpleEnabled: 'true', complexEnabled: 'true' },
  {},
]) {
  test(`manager audience read authority matches strict event-type flags: ${JSON.stringify(flags)}`, async () => {
    const queries = [];
    const db = { from(table) {
      queries.push(table);
      return { select() { return this; }, eq() { return this; },
        async in(key, ids) { assert.deepEqual(ids, [groupId]); return { data: [{ id: eventId }] }; } };
    } };
    const result = await loadTicketAudienceReadContext({
      req: { viewer, groupAccess: { groups: [{ groupId, ...flags }], tenantContext: { tenantId } } },
      ctx: { isAuthenticated: true, tenantId, memberId }, db,
    });
    assert.equal(result.simpleGroups.has(groupId), flags.simpleEnabled === true);
    assert.equal(result.complexGroups.has(groupId), flags.complexEnabled === true);
    assert.equal(result.managedComplexIds.has(eventId), flags.complexEnabled === true);
    assert.deepEqual(queries, flags.complexEnabled === true ? ['complex_event'] : []);
    const row = { id: eventId, tenant_id: tenantId, member_group_id: groupId, pricing_config: { ticket_classes: [hidden] } };
    for (const [entity, enabled] of [['event', flags.simpleEnabled], ['complexevent', flags.complexEnabled]]) {
      const projected = projectTicketAudienceRows([row], entity, result);
      assert.equal(JSON.stringify(projected).includes('selected_member_ids'), enabled === true);
    }
    assert.equal(projectTicketAudienceRows([{ ...hidden, complex_event_id: eventId }], 'complexeventticketclass', result).length, flags.complexEnabled === true ? 1 : 0);
    let clause;
    scopeTicketAudienceQuery({ or(value) { clause = value; return this; } }, 'complexeventticketclass', result);
    assert.equal(clause.includes('complex_event_id.in.'), flags.complexEnabled === true);
  });
}
