import test from 'node:test';
import assert from 'node:assert/strict';
import { bookedValue, simpleBookingCurrency } from './eventRevenueAggregation.js';
import { runWidgetConfig } from './aggregation.js';
import { widgetConfigSchema, widgetCreateSchema, widgetUpdateSchema } from './validation.js';
import { createHandler as createPreviewHandler } from '../widgets/preview.js';
import { isMembershipValueConfig, canAccessMembershipValue } from './permissions.js';
import { getSourceDef } from './sources.js';
import { executeClaim } from './resultCache.js';
import { createHandler as createDataHandler } from '../widgets/[id]/data.js';

const config = {
  source: 'event_revenue', revenueCurrency: 'GBP',
  measure: { aggregator: 'sum', field: 'booked_value', fieldKind: 'system' },
  filters: [],
};
function clientFor(overrides = {}, cap = 1) {
  const tables = {
    event: [{ id: 'event-a', tenant_id: 'tenant-a', title: 'Spring event', start_date: '2026-03-02T12:00:00Z', status: 'published', pricing_config: { currency: 'GBP' } }],
    complex_event: [{ id: 'event-a', tenant_id: 'tenant-a', title: 'Conference', start_date: '2026-01-01T00:00:00Z', status: 'published' }],
    complex_event_session: [
      { id: 's1', tenant_id: 'tenant-a', complex_event_id: 'event-a', start_time: '2026-05-02T12:00:00Z' },
      { id: 's2', tenant_id: 'tenant-a', complex_event_id: 'event-a', start_time: '2026-04-02T12:00:00Z' },
    ],
    booking: [
      { id: 'b1', tenant_id: 'tenant-a', event_id: 'event-a', status: 'confirmed', total_cost: 100, discount_code_amount: 10, voucher_amount: 20, training_fund_amount: 30 },
      { id: 'b2', tenant_id: 'tenant-a', event_id: 'event-a', status: 'pending', total_cost: 50, discount_code_amount: 0, payment_method: 'invoice' },
      { id: 'b3', tenant_id: 'tenant-a', event_id: 'event-a', status: 'cancelled', total_cost: null },
      { id: 'b4', tenant_id: 'other-tenant', event_id: 'event-a', status: 'confirmed', total_cost: 9999 },
    ],
    complex_event_booking: [
      { id: 'c1', tenant_id: 'tenant-a', event_id: 'event-a', status: 'confirmed', ticket_price: 80, currency: 'gbp', discount_amount: 20, total_paid: 0, payment_method: 'public_invoice_po', account_balance_amount: 40 },
      { id: 'c2', tenant_id: 'tenant-a', event_id: 'event-a', status: 'confirmed', ticket_price: 70, currency: 'USD' },
    ],
    ...overrides,
  };
  const calls = [];
  return { calls, from(table) {
    let tenant, cursor;
    const query = {
      select() { return query; },
      eq(field, value) { assert.equal(field, 'tenant_id'); tenant = value; return query; },
      is(field, value) { assert.equal(field, 'tenant_id'); tenant = value; return query; },
      gt(field, value) { assert.equal(field, 'id'); cursor = value; return query; },
      order(field) { assert.equal(field, 'id'); return query; },
      async range(start, end) {
        calls.push({ table, tenant, cursor });
        assert.notEqual(tenant, undefined, 'every financial query must be tenant scoped');
        if (tables[table] instanceof Error) return { error: tables[table] };
        return { data: (tables[table] || []).filter(row => row.tenant_id === tenant && (!cursor || row.id > cursor))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(start, Math.min(end + 1, start + cap)), error: null };
      },
    };
    return query;
  } };
}

const run = (cfg = config, client = clientFor()) => runWidgetConfig(cfg, 'tenant-a', { client });

test('booked value matches report totalAfterDiscount, not net payment', () => {
  assert.equal(bookedValue({ id: 'b', total_cost: 100, discount_code_amount: 10, voucher_amount: 25, training_fund_amount: 20 }, 'simple'), 90);
  assert.equal(bookedValue({ id: 'b', ticket_price: 70, discount_amount: 30, voucher_amount: 10, account_balance_amount: 10 }, 'complex'), 70);
  assert.throws(() => bookedValue({ id: 'b', total_cost: null }, 'simple'), /invalid total_cost/);
  assert.throws(() => bookedValue({ id: 'b', ticket_price: 'bad' }, 'complex'), /invalid ticket_price/);
  assert.throws(() => bookedValue({ id: 'b', total_cost: 20, discount_code_amount: 30 }, 'simple'), /exceeds/);
});

test('tenant scoped total includes unpaid bookings, excludes cancellation and foreign currency, handles capped pages', async () => {
  const client = clientFor();
  const result = await run(config, client);
  assert.equal(result.value, 220);
  assert.equal(result.currency, 'GBP');
  assert.equal(result.excludedOtherCurrencyBookings, 1);
  assert.ok(client.calls.some(call => call.table === 'booking' && call.cursor === 'b3'));
});

test('stored complex currency is selected explicitly without conversion', async () => {
  assert.equal((await run({ ...config, revenueCurrency: 'USD' })).value, 70);
});

test('time buckets use event dates and earliest complex session, not booking dates', async () => {
  for (const [granularity, keys] of [
    ['day', ['2026-03-02', '2026-04-02']],
    ['week', ['2026-03-02', '2026-03-30']],
    ['month', ['2026-03', '2026-04']],
    ['quarter', ['2026-Q1', '2026-Q2']],
    ['year', ['2026']],
  ]) {
    const result = await run({ ...config, timeBucket: { field: 'event_start_date', fieldKind: 'system', granularity } });
    assert.deepEqual(result.rows.map(row => row.key), keys);
    assert.equal(result.rows.reduce((sum, row) => sum + row.value, 0), 220);
  }
});

test('event filters support one/many kind-prefixed ids and no cross-kind id collision', async () => {
  const filter = { field: 'event_id', fieldKind: 'system', operator: 'in', value: ['complex:event-a'] };
  assert.equal((await run({ ...config, filters: [filter] })).value, 80);
  assert.equal((await run({ ...config, filters: [{ ...filter, value: ['simple:event-a', 'complex:event-a'] }] })).value, 220);
  assert.equal((await run({ ...config, filters: [{ ...filter, value: ['missing'] }] })).value, 0);
});

test('date-only comparisons retain generic timestamp boundaries', async () => {
  const filters = [{ field: 'event_start_date', fieldKind: 'system', operator: 'lte', value: '2026-03-02' }];
  assert.equal((await run({ ...config, filters })).value, 0);
});

test('cumulative totals are the final cumulative value, not the sum of cumulative points', async () => {
  const result = await run({ ...config, cumulative: true,
    timeBucket: { field: 'event_start_date', fieldKind: 'system', granularity: 'month' } });
  assert.deepEqual(result.rows.map(row => row.value), [140, 220]);
  assert.equal(result.total, 220);
});

test('grouping event ids remains distinct and sums attendee allocations before currency rounding', async () => {
  const rows = ['b1', 'b2', 'b3'].map(id => ({ id, tenant_id: 'tenant-a', event_id: 'event-a', total_cost: 10 / 3, status: 'confirmed', booking_group_reference: 'same-group' }));
  const result = await run({ ...config, groupBy: { kind: 'system', field: 'event_id' } }, clientFor({ booking: rows, complex_event_booking: [] }));
  assert.equal(result.total, 10);
  assert.equal(result.rows[0].value, 10);
  assert.match(result.rows[0].key, /Spring event/);
});

test('missing monetary, currency, event or scheduling evidence fails rather than presenting partial zero', async () => {
  await assert.rejects(run(config, clientFor({ booking: [{ id: 'b1', tenant_id: 'tenant-a', event_id: 'event-a', total_cost: null }] })), /invalid total_cost/);
  await assert.rejects(run(config, clientFor({ complex_event_booking: [{ id: 'c1', tenant_id: 'tenant-a', event_id: 'event-a', ticket_price: 1, currency: null }] })), /valid currency/);
  await assert.rejects(run(config, clientFor({ event: [] })), /no tenant event/);
  await assert.rejects(run({ ...config, timeBucket: { field: 'event_start_date', fieldKind: 'system', granularity: 'month' } },
    clientFor({ event: [{ id: 'event-a', tenant_id: 'tenant-a', status: 'tbc', pricing_config: { currency: 'GBP' } }] })), /unscheduled/);
  await assert.rejects(run(config, clientFor({ complex_event_session: new Error('session query failed') })), /session query failed/);
});

test('canonical validation covers all server paths and financial source is restricted', () => {
  assert.equal(widgetConfigSchema.safeParse(config).success, true);
  for (const patch of [
    { revenueCurrency: null }, { revenueCurrency: 'AAA' },
    { measure: { aggregator: 'count' } },
    { timeBucket: { field: 'created_at', fieldKind: 'system', granularity: 'month' } },
    { groupBy: { kind: 'system', field: 'status' } },
    { clickThrough: true }, { participation: true },
    { filters: [{ field: 'booked_value', fieldKind: 'system', operator: 'gt', value: 0 }] },
  ]) assert.equal(widgetConfigSchema.safeParse({ ...config, ...patch }).success, false, JSON.stringify(patch));
  assert.equal(getSourceDef('event_revenue').isEventRevenue, true);
  assert.equal(isMembershipValueConfig(config), true);
  assert.equal(canAccessMembershipValue({ permissions: { viewMembershipValue: true } }, config), false);
  assert.equal(canAccessMembershipValue({ permissions: { viewEventRevenue: true } }, config), true);
  assert.equal(canAccessMembershipValue({ permissions: { viewEventRevenue: true } }, { source: 'organisation_membership' }), false);
  for (const widget_type of ['stat', 'bar', 'line', 'list', 'pie', 'donut']) {
    const saved = widgetCreateSchema.parse({ title: 'Revenue', widget_type, scope: 'personal', config });
    assert.equal(saved.config.revenueCurrency, 'GBP');
    assert.equal(widgetUpdateSchema.parse({ config: saved.config }).config.measure.field, 'booked_value');
  }
});

function response() {
  return { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('authorized preview and durable cache worker publish the same saved revenue configuration', async () => {
  const savedConfig = widgetConfigSchema.parse(JSON.parse(JSON.stringify({
    ...config, timeBucket: { field: 'event_start_date', fieldKind: 'system', granularity: 'month' },
  })));
  const runReal = (config, tenantId, options) => runWidgetConfig(config, tenantId, { ...options, client: clientFor() });
  const preview = createPreviewHandler({
    getDashboardActor: async () => ({ tenantId: 'tenant-a', permissions: { view: true, viewEventRevenue: true } }),
    runWidgetConfig: runReal,
  });
  const res = response();
  await preview({ method: 'POST', body: { config: savedConfig, widgetType: 'line' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.data.total, 220);
  let published;
  const result = await executeClaim({ async rpc(name, args) {
    assert.equal(name, 'dashboard_widget_cache_publish'); published = args;
    return { data: true, error: null };
  } }, {
    widget: { id: 'revenue-cache', tenant_id: 'tenant-a', widget_type: 'line', config: savedConfig },
    cache: { identity: 'revenue-identity', lease_token: 'revenue-lease' },
  }, { run: runReal });
  assert.deepEqual(result, { published: true, failed: false });
  assert.deepEqual(published.p_result, res.body.data);
});

test('saved cached revenue cannot be read or refreshed without event-report permission', async () => {
  for (const refresh of [false, true]) {
    let cached = false;
    const handler = createDataHandler({
      refresh,
      getDashboardActor: async () => ({ tenantId: 'tenant-a', memberId: 'member-a',
        permissions: { view: true, viewMembershipValue: true } }),
      supabase: { from() {
        const query = { select() { return query; }, eq() { return query; }, is() { return query; },
          single: async () => ({ data: { id: 'revenue', scope: 'shared', tenant_id: 'tenant-a', config }, error: null }) };
        return query;
      } },
      cacheRpc: async () => { cached = true; throw new Error('must not read financial cache'); },
    });
    const res = response();
    await handler({ method: refresh ? 'POST' : 'GET', query: { id: 'revenue' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(cached, false);
    assert.match(res.body.error, /Event Registration Report/);
  }
});

test('currency rounding preserves fractional attendee allocations and currency minor units', async () => {
  const row = { id: 'c1', tenant_id: 'tenant-a', event_id: 'event-a', status: 'confirmed', ticket_price: 1.005, currency: 'GBP' };
  assert.equal((await run(config, clientFor({ booking: [], complex_event_booking: [row] }))).value, 1.01);
  assert.equal((await run({ ...config, revenueCurrency: 'JPY' }, clientFor({ booking: [],
    complex_event_booking: [{ ...row, ticket_price: 10.5, currency: 'JPY' }] }))).value, 11);
});

test('simple currency requires explicit snapshot or linked ticket/event evidence, never a GBP guess', async () => {
  const pricing = { currency: 'GBP', ticket_classes: [{ id: 'usd-ticket', currency: 'USD' }] };
  assert.equal(simpleBookingCurrency({ ticket_class_id: 'usd-ticket' }, pricing), 'USD');
  assert.equal(simpleBookingCurrency({ ticket_class_id: 'deleted-ticket' }, pricing), '');
  assert.equal(simpleBookingCurrency({}, {}), '');
  assert.equal(simpleBookingCurrency({ ticket_class_id: 'usd-ticket', purchaser_context: { financial_snapshot: { currency: 'EUR' } } }, pricing), 'EUR');
  await assert.rejects(run(config, clientFor({
    event: [{ id: 'event-a', tenant_id: 'tenant-a', start_date: '2026-01-01', pricing_config: {} }],
  })), /valid currency/);
});

test('preview refuses financial data before querying for an ordinary dashboard viewer', async () => {
  let queried = false;
  const handler = createPreviewHandler({
    getDashboardActor: async () => ({ tenantId: 'tenant-a', permissions: { view: true } }),
    runWidgetConfig: async () => { queried = true; },
  });
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', body: { config, widget_type: 'stat' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});