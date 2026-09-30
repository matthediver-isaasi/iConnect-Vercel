import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEventRows,
  matchEventFilter,
  normaliseEventRow,
  runEventWidgetConfig,
} from './eventAggregation.js';

function fakeClient(tables, errors = {}, options = {}) {
  const calls = [];
  const tableCallCounts = {};
  return {
    calls,
    from(table) {
      const state = { table, tenant: undefined, order: null, afterId: null };
      const query = {
        select(columns) {
          state.columns = columns;
          return query;
        },
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
          tableCallCounts[table] = (tableCallCounts[table] || 0) + 1;
          const tableCall = tableCallCounts[table];
          calls.push({ ...state, from, to });
          const configuredError = typeof errors[table] === 'function'
            ? errors[table](tableCall)
            : errors[table];
          if (configuredError) return { data: null, error: { message: configuredError } };
          if (options.nullData?.[table]?.includes(tableCall)) {
            return { data: null, error: null };
          }
          const all = (tables[table] || [])
            .filter(row =>
              (state.tenant === undefined || (row.tenant_id ?? null) === state.tenant)
              && (state.afterId === null || String(row.id) > String(state.afterId)))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const cap = options.serverCaps?.[table] || Infinity;
          return { data: all.slice(from, Math.min(to + 1, from + cap)), error: null };
        },
      };
      return query;
    },
  };
}

const aggregate = (values, aggregator) => {
  if (aggregator === 'count') return values.length;
  if (aggregator === 'count_distinct') return new Set(values.filter(v => v != null)).size;
  throw new Error(`unsupported test aggregator ${aggregator}`);
};

function bucketTimestamp(value, granularity) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  if (granularity === 'year') return String(d.getUTCFullYear());
  return d.toISOString().slice(0, 7);
}

const finalizeTimeRows = (buckets, timeBucket, aggregator, cumulative) => {
  let running = 0;
  return Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const value = aggregate(values, aggregator);
    running += value;
    return { key, value: cumulative ? running : value };
  });
};

function genericMatch(raw, filter) {
  if (filter.operator === 'eq') return String(raw) === String(filter.value);
  if (filter.operator === 'gte') return raw != null && raw >= filter.value;
  if (filter.operator === 'lte') return raw != null && raw <= filter.value;
  if (filter.operator === 'is_null') return raw == null || raw === '';
  return true;
}

const helpers = { aggregate, bucketTimestamp, finalizeTimeRows, matchFilter: genericMatch };
const source = { isEvent: true };

function config(patch = {}) {
  return {
    source: 'event',
    measure: { aggregator: 'count', field: null, fieldKind: null, fieldId: null },
    filters: [],
    ...patch,
  };
}

test('normalises kind-prefixed ids and suppresses stale schedule-free dates', () => {
  assert.deepEqual(
    normaliseEventRow(
      { id: 'same', status: 'published', start_date: '2026-02-03T10:00:00Z' },
      'simple',
    ),
    {
      id: 'simple:same',
      event_kind: 'simple',
      status: 'published',
      event_start_date: '2026-02-03T10:00:00.000Z',
    },
  );
  for (const status of ['tbc', 'immediate']) {
    assert.equal(
      normaliseEventRow({ id: status, status, start_date: '2020-01-01' }, 'simple')
        .event_start_date,
      null,
    );
  }
});

test('complex events use the earliest valid session, then the parent start date', async () => {
  const client = fakeClient({
    event: [],
    complex_event: [
      { id: 'c1', tenant_id: 't1', status: 'published', start_date: '2026-08-10' },
      { id: 'c2', tenant_id: 't1', status: 'published', start_date: '2026-09-12' },
    ],
    complex_event_session: [
      { id: 's3', tenant_id: 't1', complex_event_id: 'c1', start_time: 'invalid' },
      { id: 's2', tenant_id: 't1', complex_event_id: 'c1', start_time: '2026-08-04T12:00:00Z' },
      { id: 's1', tenant_id: 't1', complex_event_id: 'c1', start_time: '2026-08-03T09:00:00Z' },
      { id: 'other', tenant_id: 't1', complex_event_id: 'other', start_time: '2020-01-01' },
    ],
  });
  const rows = await loadEventRows(client, 't1');
  assert.equal(rows[0].event_start_date, '2026-08-03T09:00:00.000Z');
  assert.equal(rows[1].event_start_date, '2026-09-12T00:00:00.000Z');
});

test('queries every table tenant-scoped with stable id pagination', async () => {
  const client = fakeClient({
    event: [{ id: 'e1', tenant_id: 'tenant-a', status: 'draft' },
      { id: 'foreign', tenant_id: 'tenant-b', status: 'published' }],
    complex_event: [{ id: 'c1', tenant_id: 'tenant-a', status: 'published' }],
    complex_event_session: [],
  });
  const rows = await loadEventRows(client, 'tenant-a');
  assert.deepEqual(rows.map(row => row.id), ['simple:e1', 'complex:c1']);
  assert.deepEqual(new Set(client.calls.map(call => call.table)),
    new Set(['event', 'complex_event', 'complex_event_session']));
  assert.ok(client.calls.every(call => call.tenant === 'tenant-a'));
  assert.ok(client.calls.every(call => call.order.field === 'id'));
  assert.ok(client.calls.every(call => call.order.options.ascending === true));
});

test('continues paging when the server cap is lower than the requested page size', async () => {
  const simple = Array.from({ length: 7 }, (_, i) => ({
    id: `e${i}`,
    tenant_id: 't1',
    status: 'published',
    start_date: `2026-01-0${i + 1}`,
  }));
  const client = fakeClient(
    { event: simple, complex_event: [] },
    {},
    { serverCaps: { event: 2, complex_event: 2 } },
  );
  const rows = await loadEventRows(client, 't1');
  assert.equal(rows.length, 7);
  assert.deepEqual(
    client.calls.filter(call => call.table === 'event').map(call => call.afterId),
    [null, 'e1', 'e3', 'e5', 'e6'],
  );
});

test('includes tenant group events regardless of viewer group membership', async () => {
  const client = fakeClient({
    event: [
      {
        id: 'private-group',
        tenant_id: 't1',
        member_group_id: 'g1',
        group_event_public: false,
        status: 'published',
        start_date: '2026-01-01',
      },
    ],
    complex_event: [],
  });
  const rows = await loadEventRows(client, 't1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'simple:private-group');
});

test('fails closed on source errors and bounded-scan truncation', async () => {
  await assert.rejects(
    loadEventRows(fakeClient({ event: [], complex_event: [] }, { event: 'permission denied' }), 't1'),
    /event.*permission denied/i,
  );
  const thousand = Array.from({ length: 1000 }, (_, i) => ({
    id: `e${i}`,
    tenant_id: 't1',
    status: 'published',
  }));
  await assert.rejects(
    loadEventRows(fakeClient({ event: thousand, complex_event: [] }), 't1', 1000),
    /more than 1000 event rows/i,
  );
});

test('fails closed when a successful query has null row data', async () => {
  const client = fakeClient(
    { event: [], complex_event: [] },
    {},
    { nullData: { event: [1] } },
  );
  await assert.rejects(
    loadEventRows(client, 't1'),
    /event.*malformed or missing row data/i,
  );
});

test('fails closed when a later complex-session page errors', async () => {
  const sessions = [
    { id: 's1', tenant_id: 't1', complex_event_id: 'c1', start_time: '2026-01-01' },
    { id: 's2', tenant_id: 't1', complex_event_id: 'c1', start_time: '2026-01-02' },
    { id: 's3', tenant_id: 't1', complex_event_id: 'c1', start_time: '2026-01-03' },
  ];
  const client = fakeClient(
    {
      event: [],
      complex_event: [{ id: 'c1', tenant_id: 't1', status: 'published' }],
      complex_event_session: sessions,
    },
    {
      complex_event_session: call => call === 2 ? 'session page unavailable' : null,
    },
    { serverCaps: { complex_event_session: 2 } },
  );
  await assert.rejects(
    loadEventRows(client, 't1'),
    /complex_event_session.*session page unavailable/i,
  );
});

test('lte date-only filters include the whole final day only for Events', () => {
  const filter = {
    field: 'event_start_date',
    fieldKind: 'system',
    operator: 'lte',
    value: '2026-01-31',
  };
  assert.equal(
    matchEventFilter({ event_start_date: '2026-01-31T23:59:59.999Z' }, filter, genericMatch),
    true,
  );
  assert.equal(
    matchEventFilter({ event_start_date: '2026-02-01T00:00:00.000Z' }, filter, genericMatch),
    false,
  );
  assert.equal(matchEventFilter({ event_start_date: null }, filter, genericMatch), false);
});

test('runs scalar and status grouping over the unified event inventory', async () => {
  const client = fakeClient({
    event: [
      { id: 'e1', tenant_id: 't1', status: 'published', start_date: '2026-01-01' },
      { id: 'e2', tenant_id: 't1', status: 'draft', start_date: '2026-02-01' },
    ],
    complex_event: [
      { id: 'c1', tenant_id: 't1', status: 'published', start_date: '2026-03-01' },
    ],
    complex_event_session: [],
  });
  const scalar = await runEventWidgetConfig(
    config(), 't1', source, 30, { client }, helpers,
  );
  assert.equal(scalar.value, 3);

  const grouped = await runEventWidgetConfig(
    config({ groupBy: { kind: 'system', field: 'status' } }),
    't1', source, 30, { client }, helpers,
  );
  assert.deepEqual(grouped.rows, [
    { key: 'published', value: 2 },
    { key: 'draft', value: 1 },
  ]);
});

test('time buckets use effective dates, omit schedule-free rows, and can be cumulative', async () => {
  const client = fakeClient({
    event: [
      { id: 'jan', tenant_id: 't1', status: 'published', start_date: '2026-01-10' },
      { id: 'stale', tenant_id: 't1', status: 'immediate', start_date: '2020-01-01' },
    ],
    complex_event: [
      { id: 'feb', tenant_id: 't1', status: 'published', start_date: '2027-01-01' },
    ],
    complex_event_session: [
      { id: 's1', tenant_id: 't1', complex_event_id: 'feb', start_time: '2026-02-12' },
    ],
  });
  const result = await runEventWidgetConfig(
    config({
      timeBucket: { field: 'event_start_date', fieldKind: 'system', granularity: 'month' },
      cumulative: true,
    }),
    't1', source, 30, { client }, helpers,
  );
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows, [
    { key: '2026-01', value: 1 },
    { key: '2026-02', value: 2 },
  ]);
});

test('runtime contract validation rejects unsupported event measures', async () => {
  const client = fakeClient({ event: [], complex_event: [] });
  await assert.rejects(
    runEventWidgetConfig(
      config({ measure: { aggregator: 'sum', field: 'id', fieldKind: 'system' } }),
      't1', source, 30, { client }, helpers,
    ),
    /only support Count/i,
  );
  assert.equal(client.calls.length, 0);
});