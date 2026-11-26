import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesActivity, loadSalesDashboardActivity } from './salesDashboardActivity.js';
import { createSalesReportsHandler } from '../sales/reports/index.js';

const at = day => `2026-11-${String(day).padStart(2, '0')}T12:00:00Z`;
const base = () => ({
  opportunities: [{ id: 'o', name: 'Conference sponsorship', organization_id: 'org', stage_id: 'new',
    owner_kind: 'member', owner_id: 'owner' }],
  quotes: [{ id: 'q', quote_number: 'P-10', opportunity_id: 'o' }],
  versions: [{ id: 'v', quote_id: 'q', status: 'declined', version_number: 2 }],
  organisations: [{ id: 'org', name: 'Example Ltd' }],
  stages: [{ id: 'new', name: 'New' }, { id: 'negotiating', name: 'Negotiating' },
    { id: 'won', name: 'Won', is_won: true }, { id: 'lost', name: 'Lost', is_lost: true }],
});
const move = (id, day, from = 'new', to = 'negotiating') => ({
  id, opportunity_id: 'o', from_stage_id: from, to_stage_id: to, created_at: at(day),
  actor_kind: 'member', actor_id: 'owner',
});
const outcome = (id, day, status) => ({ id, quote_id: 'q', quote_version_id: 'v', created_at: at(day),
  from_status: 'sent', to_status: status, actor_type: 'customer', actor_id: 'customer' });
const delivery = (id, day, type = 'sent') => ({ id, quote_id: 'q', quote_version_id: 'v',
  token_id: id, created_at: at(day), event_type: type, actor_id: 'user',
  request_metadata: { actor_type: 'tenant_user' } });
const sale = { id: 'sale', quote_id: 'q', quote_version_id: 'v', opportunity_id: 'o',
  created_at: at(18), confirmed_by_kind: 'customer', confirmed_by_id: 'token' };

test('all recorded milestone sources retain historical meaning, dates and safe context', () => {
  const data = { ...base(),
    stageHistory: [move('move', 10), move('lost', 11, 'negotiating', 'lost'), move('won', 12, 'lost', 'won'),
      move('initial', 1, null, 'new')],
    deliveries: [delivery('sent', 13), delivery('attempt', 20, 'send_attempt'),
      delivery('failed', 21, 'send_failed'), delivery('transition-failed', 22, 'send_transition_failed')],
    quoteHistory: [outcome('accepted', 14, 'accepted'), outcome('rejected', 15, 'declined')],
    sales: [sale],
    activities: Array.from({ length: 80 }, (_, i) => ({ id: `noise-${i}`, action: 'project.created', created_at: at(26) })),
    actorNames: { 'member:owner': 'Sam Sales' },
  };
  const rows = buildSalesActivity(data);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(row => row.description), [
    'Commercial sale confirmed', 'Proposal rejected', 'Proposal accepted', 'Proposal sent',
    'Stage moved: Lost → Won', 'Stage moved: Negotiating → Lost', 'Stage moved: New → Negotiating',
  ]);
  assert.equal(rows.at(-1).date, at(10));
  assert.equal(rows.at(-1).actorName, 'Sam Sales');
  assert.equal(rows[0].actorName, 'Customer');
  assert.equal(rows[3].actorName, 'Name unavailable');
  assert.ok(rows.every(row => row.opportunityName === 'Conference sponsorship' && row.organizationName === 'Example Ltd'));
});

test('newest eight milestones are stable despite noise and genuine repeated actions survive', () => {
  const data = { ...base(), deliveries: Array.from({ length: 12 }, (_, i) => delivery(`send-${i}`, i + 1)),
    activities: Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}`, action: 'updated', created_at: at(26) })) };
  data.deliveries.push(delivery('z', 20), delivery('a', 20));
  const rows = buildSalesActivity(data);
  assert.deepEqual(rows.map(row => row.id), ['send:a', 'send:z', 'send:send-11', 'send:send-10',
    'send:send-9', 'send:send-8', 'send:send-7', 'send:send-6']);
  assert.deepEqual(buildSalesActivity({ ...data, deliveries: data.deliveries.slice().reverse() }), rows);
});

test('paired transaction evidence is deduplicated, not unrelated sends or moves', () => {
  const stage = move('stage', 10);
  const won = { ...move('auto-won', 18, 'negotiating', 'won'), note: 'Commercial sale confirmed' };
  const send = delivery('send', 11);
  const accepted = outcome('accepted', 12, 'accepted');
  const data = { ...base(), stageHistory: [stage, won],
    activities: [{ id: 'mirror', opportunity_id: 'o', action: 'stage.changed', created_at: at(10),
      metadata: { fromStageId: 'new', toStageId: 'negotiating' } },
    { id: 'old-only', opportunity_id: 'o', action: 'stage.changed', created_at: at(9),
      metadata: { fromStageId: 'negotiating', toStageId: 'lost' } }],
    deliveries: [send, { ...send, id: 'duplicate-audit' }, delivery('resend', 13),
      { ...delivery('accepted-audit', 12, 'accepted'), actor_id: null }],
    decisions: [{ id: 'decision', quote_id: 'q', quote_version_id: 'v', created_at: at(12), decision: 'accepted' }],
    quoteHistory: [accepted, outcome('converted', 18, 'converted')], sales: [sale] };
  const rows = buildSalesActivity(data);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(row => row.kind === 'sent').length, 2);
  assert.equal(rows.filter(row => row.kind === 'accepted').length, 1);
  assert.equal(rows.filter(row => row.kind === 'confirmed').length, 1);
  assert.equal(rows.filter(row => row.kind === 'stage').length, 2);
});

test('unknown stages and identities are honest, cancellation is not rejection and current statuses create no events', () => {
  const data = { ...base(), stageHistory: [{ ...move('missing', 1, 'deleted', 'unavailable'), actor_id: null }],
    quoteHistory: [{ ...outcome('cancel', 2, 'declined'), actor_type: 'system',
      note: 'Cancelled by staff; unsold exhibition reservations released' }],
  };
  const rows = buildSalesActivity(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'Stage moved: Previous stage unavailable → Stage unavailable');
  assert.equal(rows[0].actorName, 'Actor not recorded');
  assert.deepEqual(buildSalesActivity(base()), []);
});

test('decision and audit-only outcomes work without inventing customer names', () => {
  const data = { ...base(), decisions: [{ id: 'd', quote_id: 'q', quote_version_id: 'v',
    decision: 'accepted', created_at: at(10), customer_name: 'Never expose' }],
  deliveries: [delivery('decline', 11, 'declined')] };
  assert.deepEqual(buildSalesActivity(data).map(row => [row.description, row.actorName]),
    [['Proposal rejected', 'Customer'], ['Proposal accepted', 'Customer']]);
  assert.doesNotMatch(JSON.stringify(buildSalesActivity(data)), /Never expose/);
});

function database(tables) {
  const calls = [];
  return { calls, from(table) {
    const filters = [];
    const call = { table, columns: null, filters, ranges: [] };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      or() { return this; }, order(column) {
        if (table === 'opportunity_collaborator') assert.equal(column, 'opportunity_id', 'collaborator has a composite key, not an id column');
        return this;
      }, limit() { return this; },
      async range(from, to) { call.ranges.push([from, to]); return result((tables[table] || []).filter(row => filters.every(fn => fn(row))).slice(from, to + 1)); },
      async maybeSingle() { return { data: (tables[table] || []).find(row => filters.every(fn => fn(row))) || null }; },
      then(resolve, reject) { return Promise.resolve(result((tables[table] || []).filter(row => filters.every(fn => fn(row))))).then(resolve, reject); },
    };
    function result(rows) {
      // Mimic the intentionally narrow JSON-path projection used by PostgREST.
      return { data: rows.map(row => ({ ...row, ...(table === 'sales_quote_delivery_audit'
        ? { request_metadata: row.request_metadata?.actor_type } : {}) })) };
    }
    return query;
  } };
}
const scoped = rows => rows.map(row => ({ tenant_id: 't', ...row }));
const context = { isAuthenticated: true, tenantId: 't', memberId: 'owner' };

test('loader filters tenant and record visibility before limit and batches permitted identity lookups', async () => {
  const data = base();
  data.opportunities.push({ ...data.opportunities[0], id: 'hidden', name: 'Private deal', owner_id: 'other' });
  data.quotes.push({ id: 'hidden-q', opportunity_id: 'hidden' }, { id: 'unlinked-q' });
  const db = database({
    opportunity_collaborator: [{ tenant_id: 'foreign', principal_id: 'owner', principal_kind: 'member', opportunity_id: 'hidden' }],
    opportunity_stage_history: scoped([
      move('visible', 1),
      ...Array.from({ length: 20 }, (_, i) => ({ ...move(`private-${i}`, 26), opportunity_id: 'hidden' })),
      { ...move('foreign', 26), tenant_id: 'foreign' },
    ]),
    sales_quote_delivery_audit: scoped([
      ...Array.from({ length: 10 }, (_, i) => delivery(`send-${i}`, i + 2)),
      { ...delivery('hidden-send', 26), quote_id: 'hidden-q' },
      { ...delivery('unlinked-send', 26), quote_id: 'unlinked-q' },
    ]),
    tenant_user: [{ tenant_id: 't', id: 'user', first_name: 'Alex', last_name: 'Smith', email: 'private@example.test' }],
  });
  const rows = await loadSalesDashboardActivity(db, context, data, { hasAdminAccess: async () => false });
  assert.equal(rows.length, 8);
  assert.ok(rows.every(row => row.actorName === 'Alex Smith' && row.quoteId === 'q'));
  const payload = JSON.stringify(rows);
  assert.doesNotMatch(payload, /Private deal|hidden|unlinked|foreign|private@example|actor_id|_actor|request_metadata|token|recipient|provider/);
  assert.equal(db.calls.filter(call => call.table === 'tenant_user').length, 1);
  assert.equal(db.calls.find(call => call.table === 'opportunity_collaborator').columns, 'opportunity_id');
  assert.ok(!db.calls.some(call => call.table === 'member'));
  for (const call of db.calls) {
    assert.notEqual(call.columns, '*');
    if (call.table === 'sales_quote_delivery_audit') assert.doesNotMatch(call.columns, /recipient_email|provider_message_id|sender_domain/);
  }
});

test('collaborators can see their deals, but unrelated member/contact names are not exposed', async () => {
  const data = base();
  data.opportunities[0].owner_id = 'other';
  const db = database({
    opportunity_collaborator: scoped([{ id: 'c', principal_kind: 'member', principal_id: 'owner', opportunity_id: 'o' }]),
    opportunity_stage_history: scoped([move('team', 1), { ...move('contact', 2), actor_id: 'contact' }]),
    organization: scoped([{ id: 'primary', is_primary: true }]),
    member: scoped([{ id: 'owner', organization_id: 'primary', first_name: 'Sam', last_name: 'Sales' },
      { id: 'contact', organization_id: 'customer', first_name: 'Private', last_name: 'Contact' }]),
  });
  const rows = await loadSalesDashboardActivity(db, context, data, { hasAdminAccess: async () => false });
  assert.deepEqual(rows.map(row => row.actorName), ['Name unavailable', 'Sam Sales']);
  assert.doesNotMatch(JSON.stringify(rows), /Private Contact/);
});

test('history reads page past 1000 records and failures are surfaced rather than empty success', async () => {
  const db = database({ opportunity_stage_history: scoped(Array.from({ length: 1002 }, (_, i) => move(`m${i}`, i === 1001 ? 26 : 1))) });
  const rows = await loadSalesDashboardActivity(db, context, base(), { hasAdminAccess: async () => true });
  assert.equal(rows[0].id, 'stage:m1001');
  assert.equal(db.calls.filter(call => call.table === 'opportunity_stage_history').length, 2);
  const bad = { from() { return { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, async range() { return { error: new Error('Unavailable') }; } }; } };
  await assert.rejects(loadSalesDashboardActivity(bad, context, base(), { hasAdminAccess: async () => true }), /Unavailable/);
});

test('activity history refuses overflow rather than silently returning an incomplete newest-eight list', async () => {
  const db = database({ opportunity_stage_history: scoped(Array.from({ length: 50001 }, (_, i) => move(`m${i}`, 1))) });
  await assert.rejects(loadSalesDashboardActivity(db, context, base(), { hasAdminAccess: async () => true }),
    error => error.status === 413 && /maximum scan/.test(error.message));
});

test('dashboard handler emits the normalized minimal timeline and leaves expected-close filtering independent', async () => {
  const data = base();
  const db = database({ sales_quote_delivery_audit: scoped([delivery('sent', 10), delivery('failed', 26, 'send_failed')]),
    tenant_user: [{ tenant_id: 't', id: 'user', first_name: 'Alex' }] });
  const handler = createSalesReportsHandler({ db, getTenantContext: async () => ({ ...context, tenantUserId: 'user' }),
    loadSalesReportData: async () => data, hasAdminAccess: async () => true });
  async function request(query) {
    const response = { headers: {}, status(code) { this.code = code; return this; },
      setHeader(key, value) { this.headers[key] = value; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { view: 'dashboard', ...query } }, response);
    assert.equal(response.code, 200);
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    return response.body;
  }
  const first = await request({});
  const second = await request({ expectedCloseFrom: '2027-01-01', expectedCloseSort: 'desc' });
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.recentActivity, second.recentActivity);
  assert.deepEqual(Object.keys(first.recentActivity[0]).sort(),
    ['id', 'kind', 'date', 'description', 'opportunityId', 'opportunityName', 'quoteId', 'quoteNumber', 'organizationName', 'actorName'].sort());
  assert.equal(first.recentActivity[0].actorName, 'Alex');
});
