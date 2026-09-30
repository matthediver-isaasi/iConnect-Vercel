import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler as createPreviewHandler } from './widgets/preview.js';
import { createHandler as createDataHandler } from './widgets/[id]/data.js';
import { createHandler as createDrilldownHandler } from './widgets/[id]/drilldown.js';
import { runWidgetConfig } from './_lib/aggregation.js';
import { executeClaim } from './_lib/resultCache.js';
import { widgetConfigSchema } from './_lib/validation.js';

const actor = {
  tenantId: 'tenant-events',
  memberId: 'member-events',
  permissions: { view: true, managePersonal: true, manageShared: true },
};

const countMeasure = {
  aggregator: 'count',
  field: null,
  fieldKind: null,
  fieldId: null,
};

const cases = [
  {
    name: 'KPI',
    widgetType: 'stat',
    config: { source: 'event', measure: countMeasure, filters: [] },
    result: { type: 'scalar', value: 12, total: 12 },
  },
  ...[
    ['month', [{ key: '2026-01', value: 3 }, { key: '2026-02', value: 5 }]],
    ['quarter', [{ key: '2026-Q1', value: 8 }, { key: '2026-Q2', value: 4 }]],
    ['year', [{ key: '2025', value: 7 }, { key: '2026', value: 12 }]],
  ].map(([granularity, rows]) => ({
    name: `${granularity} trend`,
    widgetType: 'line',
    config: {
      source: 'event',
      measure: countMeasure,
      timeBucket: {
        field: 'event_start_date',
        fieldKind: 'system',
        fieldId: null,
        granularity,
      },
      filters: [],
    },
    result: { type: 'time', rows, total: rows.reduce((sum, row) => sum + row.value, 0) },
  })),
];

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function widgetDb(widget) {
  return {
    from(table) {
      assert.equal(table, 'dashboard_widget');
      const query = {
        select() { return query; },
        eq() { return query; },
        is() { return query; },
        single: async () => ({ data: widget, error: null }),
      };
      return query;
    },
  };
}

function eventClient(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, tenant: undefined, afterId: null };
      const query = {
        select() { return query; },
        eq(field, value) {
          if (field === 'tenant_id') state.tenant = value;
          return query;
        },
        is(field, value) {
          if (field === 'tenant_id') state.tenant = value;
          return query;
        },
        gt(field, value) {
          if (field === 'id') state.afterId = value;
          return query;
        },
        order(field, options) {
          state.order = { field, options };
          return query;
        },
        async range(from, to) {
          calls.push({ ...state, from, to });
          const rows = (tables[table] || [])
            .filter(row =>
              (state.tenant === undefined || (row.tenant_id ?? null) === state.tenant)
              && (state.afterId === null || String(row.id) > String(state.afterId)))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return query;
    },
  };
}

test('Events KPI and month/quarter/year previews preserve saved configs and results', async t => {
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const savedConfig = JSON.parse(JSON.stringify(fixture.config));
      let executed;
      const handler = createPreviewHandler({
        getDashboardActor: async () => actor,
        normalizeWidgetConfigDateFilters: async config => config,
        runWidgetConfig: async (config, tenantId) => {
          executed = { config, tenantId };
          return fixture.result;
        },
      });
      const res = response();
      await handler({
        method: 'POST',
        body: { config: savedConfig, widgetType: fixture.widgetType },
      }, res);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data, fixture.result);
      assert.equal(executed.tenantId, actor.tenantId);
      // Schema parsing may add display-only defaults, but the persisted event
      // query contract must survive preview unchanged.
      assert.equal(executed.config.source, savedConfig.source);
      assert.deepEqual(executed.config.measure, savedConfig.measure);
      assert.deepEqual(executed.config.timeBucket ?? null, savedConfig.timeBucket ?? null);
      assert.deepEqual(executed.config.filters, savedConfig.filters);
    });
  }
});

test('real Events engine gives preview and cache workers identical date-filtered aggregates', async t => {
  const client = eventClient({
    event: [
      // Event inventory is independent of bookings: this event intentionally
      // has none, but still contributes to every count.
      {
        id: 'no-bookings',
        tenant_id: actor.tenantId,
        status: 'published',
        start_date: '2026-01-04T09:00:00Z',
      },
      {
        id: 'last-day-evening',
        tenant_id: actor.tenantId,
        status: 'published',
        start_date: '2026-01-31T23:45:00Z',
      },
      {
        id: 'next-day',
        tenant_id: actor.tenantId,
        status: 'published',
        start_date: '2026-02-01T00:00:00Z',
      },
      {
        id: 'stale-immediate',
        tenant_id: actor.tenantId,
        status: 'immediate',
        start_date: '2026-01-08T10:00:00Z',
      },
      {
        id: 'foreign',
        tenant_id: 'another-tenant',
        status: 'published',
        start_date: '2026-01-06T10:00:00Z',
      },
    ],
    complex_event: [
      {
        id: 'complex-earliest-session',
        tenant_id: actor.tenantId,
        status: 'published',
        start_date: '2026-04-01T09:00:00Z',
      },
      {
        id: 'complex-february',
        tenant_id: actor.tenantId,
        status: 'published',
        start_date: '2026-05-01T09:00:00Z',
      },
    ],
    complex_event_session: [
      {
        id: 'session-later',
        tenant_id: actor.tenantId,
        complex_event_id: 'complex-earliest-session',
        start_time: '2026-01-20T09:00:00Z',
      },
      {
        id: 'session-earliest',
        tenant_id: actor.tenantId,
        complex_event_id: 'complex-earliest-session',
        start_time: '2026-01-10T09:00:00Z',
      },
      {
        id: 'session-february',
        tenant_id: actor.tenantId,
        complex_event_id: 'complex-february',
        start_time: '2026-02-02T09:00:00Z',
      },
    ],
    // Explicitly empty to document that booking inventory is irrelevant.
    booking: [],
    complex_event_booking: [],
  });
  const filters = [
    {
      field: 'event_start_date',
      fieldKind: 'system',
      fieldId: null,
      operator: 'gte',
      value: '2026-01-01',
    },
    {
      field: 'event_start_date',
      fieldKind: 'system',
      fieldId: null,
      operator: 'lte',
      value: '2026-01-31',
    },
  ];
  const fixtures = [
    {
      name: 'KPI',
      widgetType: 'stat',
      config: { source: 'event', measure: countMeasure, filters },
      expected: {
        type: 'scalar',
        total: 3,
        value: 3,
        rows: [{ key: 'total', value: 3 }],
      },
    },
    ...[
      ['month', '2026-01'],
      ['quarter', '2026-Q1'],
      ['year', '2026'],
    ].map(([granularity, key]) => ({
      name: granularity,
      widgetType: 'line',
      config: {
        source: 'event',
        measure: countMeasure,
        timeBucket: {
          field: 'event_start_date',
          fieldKind: 'system',
          fieldId: null,
          granularity,
        },
        filters,
      },
      expected: {
        type: 'time',
        total: 3,
        categories: ['value'],
        rows: [{ key, value: 3 }],
        granularity,
      },
    })),
  ];
  const runRealEngine = (config, tenantId, options = {}) =>
    runWidgetConfig(config, tenantId, { ...options, client });

  for (const [index, fixture] of fixtures.entries()) {
    await t.test(fixture.name, async () => {
      // Mirror a real save/load boundary rather than sharing object identity
      // between the builder, preview request and durable cache claim.
      const serialized = JSON.stringify(fixture.config);
      const savedConfig = widgetConfigSchema.parse(JSON.parse(serialized));

      const preview = createPreviewHandler({
        getDashboardActor: async () => actor,
        runWidgetConfig: runRealEngine,
      });
      const previewRes = response();
      await preview({
        method: 'POST',
        body: {
          config: JSON.parse(JSON.stringify(savedConfig)),
          widgetType: fixture.widgetType,
        },
      }, previewRes);
      assert.equal(previewRes.statusCode, 200);
      assert.deepEqual(previewRes.body.data, fixture.expected);

      let published = null;
      const cacheDb = {
        async rpc(name, args) {
          assert.equal(name, 'dashboard_widget_cache_publish');
          published = args;
          return { data: true, error: null };
        },
      };
      const outcome = await executeClaim(cacheDb, {
        widget: {
          id: `real-events-${index}`,
          tenant_id: actor.tenantId,
          widget_type: fixture.widgetType,
          config: JSON.parse(JSON.stringify(savedConfig)),
        },
        cache: { identity: `identity-${index}`, lease_token: `lease-${index}` },
      }, {
        run: runRealEngine,
        timeoutMs: 2_000,
      });
      assert.deepEqual(outcome, { published: true, failed: false });
      assert.deepEqual(published.p_result, fixture.expected);
      assert.equal(published.p_error, null);
    });
  }

  assert.deepEqual(
    new Set(client.calls.map(call => call.table)),
    new Set(['event', 'complex_event', 'complex_event_session']),
  );
  assert.ok(client.calls.every(call => call.tenant === actor.tenantId));
  assert.ok(client.calls.every(call => call.order?.field === 'id'));
});

test('saved Events widgets return the same cached KPI and trend payloads after reload', async t => {
  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const widget = {
        id: `events-${index}`,
        tenant_id: actor.tenantId,
        owner_member_id: actor.memberId,
        scope: 'personal',
        widget_type: fixture.widgetType,
        config: JSON.parse(JSON.stringify(fixture.config)),
      };
      let cacheRead;
      const handler = createDataHandler({
        supabase: widgetDb(widget),
        getDashboardActor: async () => actor,
        normalizeWidgetConfigDateFilters: async config => config,
        readWidgetCache: async (_db, savedWidget, savedActor, options) => {
          cacheRead = { savedWidget, savedActor, options };
          return {
            data: fixture.result,
            cache: { status: 'current', pending: false, updatedAt: '2026-09-25T12:00:00Z' },
          };
        },
      });
      const res = response();
      await handler({ method: 'GET', query: { id: widget.id } }, res);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.widget.config, fixture.config);
      assert.deepEqual(res.body.data, fixture.result);
      assert.equal(res.body.cache.status, 'current');
      assert.equal(cacheRead.savedWidget, widget);
      assert.equal(cacheRead.savedActor, actor);
      assert.equal(cacheRead.options.refresh, false);
    });
  }
});

test('Events preview and saved data keep authentication, role and tenant gates', async () => {
  for (const [currentActor, expected] of [
    [null, 401],
    [{ ...actor, permissions: { view: false } }, 403],
  ]) {
    let ran = false;
    const preview = createPreviewHandler({
      getDashboardActor: async () => currentActor,
      runWidgetConfig: async () => { ran = true; },
    });
    const res = response();
    await preview({
      method: 'POST',
      body: { config: cases[0].config, widgetType: 'stat' },
    }, res);
    assert.equal(res.statusCode, expected);
    assert.equal(ran, false);
  }

  let cacheRead = false;
  const foreign = {
    id: 'foreign-events',
    tenant_id: 'another-tenant',
    owner_member_id: actor.memberId,
    scope: 'personal',
    widget_type: 'stat',
    config: cases[0].config,
  };
  const data = createDataHandler({
    supabase: widgetDb(foreign),
    getDashboardActor: async () => actor,
    readWidgetCache: async () => { cacheRead = true; },
  });
  const res = response();
  await data({ method: 'GET', query: { id: foreign.id } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(cacheRead, false);
});

test('Events widgets never enable CRM drilldown or execute row-id aggregation', async () => {
  for (const clickThrough of [false, true]) {
    const widget = {
      id: `events-drill-${clickThrough}`,
      tenant_id: actor.tenantId,
      owner_member_id: actor.memberId,
      scope: 'personal',
      widget_type: 'bar',
      config: {
        source: 'event',
        measure: countMeasure,
        groupBy: { kind: 'system', field: 'status', fieldId: null },
        filters: [],
        clickThrough,
      },
    };
    let ran = false;
    const handler = createDrilldownHandler({
      supabase: widgetDb(widget),
      getDashboardActor: async () => actor,
      getSourceDef: () => ({ id: 'event', table: 'event', isEvent: true }),
      runWidgetConfig: async () => { ran = true; },
    });
    const res = response();
    await handler({
      method: 'POST',
      query: { id: widget.id },
      body: { key: 'published' },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /does not support click-through/);
    assert.equal(ran, false);
  }
});