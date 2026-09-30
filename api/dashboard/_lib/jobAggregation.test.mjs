import test from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_SOURCES } from './sources.js';
import { runWidgetConfig } from './aggregation.js';

const jobs = [
  {
    id: 'j1', tenant_id: 'tenant-a', title: 'Engineer',
    posted_by_organization_id: 'o1', status: 'active', is_member_post: true,
    job_type: 'Permanent', hours: 'Full-time', featured: true,
    payment_status: 'N/A', external_source: null,
    created_date: '2026-01-10T10:00:00Z',
  },
  {
    id: 'j2', tenant_id: 'tenant-a', title: 'Analyst',
    posted_by_organization_id: 'o1', status: 'active', is_member_post: false,
    job_type: 'Contract', hours: 'Part-time', featured: false,
    payment_status: 'paid', external_source: null,
    created_date: '2026-01-20T10:00:00Z',
  },
  {
    id: 'j3', tenant_id: 'tenant-a', title: 'External vacancy',
    posted_by_organization_id: null, status: 'active', is_member_post: false,
    job_type: 'Permanent', hours: 'Full-time', featured: false,
    payment_status: 'N/A', external_source: 'adzuna',
    created_date: '2026-02-05T10:00:00Z',
  },
  {
    id: 'j4', tenant_id: 'tenant-a', title: 'Pending vacancy',
    posted_by_organization_id: 'o2', status: 'pending_approval', is_member_post: true,
    job_type: 'Permanent', hours: 'Full-time', featured: false,
    payment_status: 'N/A', external_source: null,
    created_date: '2026-02-15T10:00:00Z',
  },
  {
    id: 'foreign', tenant_id: 'tenant-b', title: 'Other tenant',
    posted_by_organization_id: 'o9', status: 'active', is_member_post: true,
    created_date: '2026-01-01T10:00:00Z',
  },
];

const organizations = [
  { id: 'o1', tenant_id: 'tenant-a', name: 'Acme Association' },
  { id: 'o2', tenant_id: 'tenant-a', name: 'Beacon Trust' },
  { id: 'o9', tenant_id: 'tenant-b', name: 'Foreign Org' },
];

function makeClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, filters: [], inFilter: null, range: null };
      const query = {
        select() { return query; },
        eq(field, value) { state.filters.push([field, value]); return query; },
        is(field, value) { state.filters.push([field, value]); return query; },
        in(field, values) { state.inFilter = [field, values]; return query; },
        neq(field, value) { state.filters.push([field, { neq: value }]); return query; },
        order() { return query; },
        range(from, to) { state.range = [from, to]; return execute(); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      const execute = async () => {
        calls.push({ ...state, filters: [...state.filters] });
        let rows = table === 'job_posting' ? jobs : organizations;
        for (const [field, expected] of state.filters) {
          rows = rows.filter(row => expected?.neq !== undefined
            ? row[field] !== expected.neq
            : row[field] === expected);
        }
        if (state.inFilter) {
          const [field, values] = state.inFilter;
          rows = rows.filter(row => values.includes(row[field]));
        }
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        return { data: rows.map(row => ({ ...row })), error: null };
      };
      return query;
    },
  };
}

function config(overrides = {}) {
  return {
    source: 'job_posting',
    measure: { aggregator: 'count', field: null, fieldKind: null },
    filters: [],
    ...overrides,
  };
}

test('Jobs source publishes canonical measures, dimensions, and dates', () => {
  const source = DASHBOARD_SOURCES.job_posting;
  assert.equal(source.label, 'Jobs');
  assert.equal(source.table, 'job_posting');
  assert.equal(source.timestampField, 'created_date');
  const fields = new Map(source.systemFields.map(field => [field.name, field]));
  assert.equal(fields.get('posted_by_organization_id').referenceTable, 'organization');
  assert.equal(fields.get('amount_paid').aggregatable, true);
  for (const name of [
    'status', 'job_type', 'hours', 'is_member_post', 'featured',
    'payment_status', 'external_source', 'created_date', 'closing_date', 'expiry_date',
  ]) assert.ok(fields.has(name), `missing ${name}`);
});

test('job totals and distinct organisations are tenant-scoped and retain unlinked jobs', async () => {
  const client = makeClient();
  const total = await runWidgetConfig(config(), 'tenant-a', { client });
  assert.equal(total.value, 4);
  assert.ok(client.calls.some(call =>
    call.table === 'job_posting'
    && call.filters.some(([field, value]) => field === 'tenant_id' && value === 'tenant-a')));

  const distinct = await runWidgetConfig(config({
    measure: {
      aggregator: 'count_distinct',
      field: 'posted_by_organization_id',
      fieldKind: 'system',
    },
  }), 'tenant-a', { client: makeClient() });
  assert.equal(distinct.value, 2);
  assert.equal(distinct.total, 4);
});

test('jobs filter by canonical status and origin fields', async () => {
  const result = await runWidgetConfig(config({
    filters: [
      { fieldKind: 'system', field: 'status', operator: 'eq', value: 'active' },
      { fieldKind: 'system', field: 'external_source', operator: 'eq', value: 'adzuna' },
    ],
  }), 'tenant-a', { client: makeClient() });
  assert.equal(result.value, 1);
  assert.equal(result.total, 1);
});

test('posting-organisation grouping uses labels and keeps unlinked jobs', async () => {
  const result = await runWidgetConfig(config({
    groupBy: { kind: 'system', field: 'posted_by_organization_id' },
  }), 'tenant-a', { client: makeClient() });
  assert.deepEqual(
    Object.fromEntries(result.rows.map(row => [row.key, row.value])),
    { 'Acme Association': 2, 'Beacon Trust': 1, Unspecified: 1 },
  );
  assert.ok(!result.rows.some(row => /^o\d/.test(row.key)));
});

test('posted-date activity buckets by month', async () => {
  const result = await runWidgetConfig(config({
    timeBucket: { field: 'created_date', fieldKind: 'system', granularity: 'month' },
  }), 'tenant-a', { client: makeClient() });
  assert.deepEqual(result.rows, [
    { key: '2026-01', value: 2 },
    { key: '2026-02', value: 2 },
  ]);
});