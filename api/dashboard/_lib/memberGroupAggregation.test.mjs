import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMemberGroups, unionMembershipIntervals, periodStart, advancePeriod,
  readMemberGroupPages, runMemberGroupWidgetConfig,
} from './memberGroupAggregation.js';
import { widgetConfigSchema, widgetCreateSchema, widgetUpdateSchema } from './validation.js';

const cfg = (field, extra = {}) => ({
  source: 'member_group', measure: { aggregator: 'count', field, fieldKind: 'system' }, filters: [], ...extra,
});
const groups = [
  { id: 'a', name: 'Alpha', is_active: true },
  { id: 'b', name: 'Beta', is_active: false },
  { id: 'c', name: 'Empty', is_active: true },
];
const members = [{ id: 'm1', login_enabled: false }, { id: 'm2', login_enabled: true }];
const assignments = [
  { group_id: 'a', member_id: 'm1' }, { group_id: 'a', member_id: 'm1' },
  { group_id: 'b', member_id: 'm1' }, { group_id: 'b', member_id: 'm2' },
  { group_id: 'a', member_id: 'deleted' },
  { group_id: 'a', member_id: 'm2', guest_id: 'guest' },
  { group_id: 'a', member_id: 'm2', expires_at: '2026-01-01' },
];
const data = { groups, members, assignments };
const now = '2026-03-15T12:00:00Z';
const options = { now };
const organisationData = {
  groups,
  members: [
    { id: 'm1', organization_id: 'o1', login_enabled: false },
    { id: 'm2', organization_id: 'o1', login_enabled: true },
    { id: 'm3', organization_id: 'o2', login_enabled: true },
    { id: 'none', organization_id: null },
    { id: 'empty', organization_id: '' },
    { id: 'blank', organization_id: '  ' },
    { id: 'excluded', organization_id: 'o3' },
  ],
  assignments: [
    ...assignments,
    { group_id: 'a', member_id: 'm2' },
    { group_id: 'b', member_id: 'm3' },
    ...['none', 'empty', 'blank'].map(member_id => ({ group_id: 'a', member_id })),
    { group_id: 'a', member_id: 'excluded', guest_id: 'guest' },
    { group_id: 'a', member_id: 'excluded', expires_at: now },
    { group_id: 'a', guest_id: 'guest' },
    { group_id: 'missing', member_id: 'excluded' },
  ],
};
const groupFilter = ids => ({ fieldKind: 'system', field: 'group_id', operator: 'in', value: ids });

test('current organisations deduplicate members, assignments and overlapping groups, excluding ineligible identities', () => {
  for (const [ids, expected] of [[null, 2], [['a'], 1], [['a', 'b'], 2], [['c'], 0], [[], 0]]) {
    const result = aggregateMemberGroups(cfg('current_organizations', { filters: ids ? [groupFilter(ids)] : [] }), organisationData, options);
    assert.equal(result.value, expected);
    assert.equal(result.total, expected);
    assert.equal(result.clickThroughAvailable, false);
    assert.equal(result.historyBaseline, undefined);
  }
  const grouped = aggregateMemberGroups(cfg('current_organizations', {
    groupBy: { kind: 'system', field: 'group_id' },
  }), organisationData, options);
  assert.deepEqual(grouped.rows, [{ key: 'Alpha', value: 1 }, { key: 'Beta', value: 2 }, { key: 'Empty', value: 0 }]);
  assert.equal(grouped.total, 2);
});

test('organisation counts preserve member, group, role and custom filters with independent bucket sets', () => {
  for (const [field, value, expected] of [['login_enabled', false, 1], ['is_active', true, 1], ['organization_id', 'o2', 1], ['group_role', 'unassigned', 0]]) {
    assert.equal(aggregateMemberGroups(cfg('current_organizations', {
      filters: [{ fieldKind: 'system', field, operator: 'eq', value }],
    }), organisationData, options).value, expected);
  }
  const preferences = [
    { member_id: 'm1', field_id: 'f', value: '["UK","USA"]' },
    { member_id: 'm2', field_id: 'f', value: '["UK"]' },
    { member_id: 'm3', field_id: 'f', value: '["USA"]' },
  ];
  const result = aggregateMemberGroups(cfg('current_organizations', {
    groupBy: { kind: 'custom', fieldId: 'f' },
    filters: [{ fieldKind: 'custom', fieldId: 'f', operator: 'in', value: ['UK', 'USA'] }],
  }), { ...organisationData, preferences }, options);
  assert.deepEqual(result.rows, [{ key: 'UK', value: 1 }, { key: 'USA', value: 2 }]);
  assert.equal(result.total, 2);
});

test('organisation measure is count-only and current-state in preview, create and update schemas', () => {
  const valid = cfg('current_organizations', { filters: [groupFilter(['a', 'b'])] });
  for (const config of [valid, { ...valid, groupBy: { kind: 'system', field: 'organization_id' } }]) {
    assert.equal(widgetConfigSchema.safeParse(config).success, true);
    assert.equal(widgetCreateSchema.safeParse({ title: 'Organisations', scope: 'personal', widget_type: 'stat', config }).success, true);
    assert.equal(widgetUpdateSchema.safeParse({ config }).success, true);
  }
  for (const patch of [
    { timeBucket: { field: 'membership_at', granularity: 'month' } },
    { cumulative: true }, { clickThrough: true },
    { seriesBy: { kind: 'system', field: 'group_id' } },
    { measure: { aggregator: 'count_distinct', field: 'organization_id' } },
  ]) {
    assert.equal(widgetConfigSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});
const time = { field: 'membership_at', granularity: 'month', window: { amount: 3, unit: 'month' } };
const interval = (member_id, group_id, valid_from, valid_until = null, extra = {}) =>
  ({ member_id, group_id, valid_from, valid_until, ...extra });
const history = [
  interval('m1', 'a', '2026-01-15', '2026-02-01', { is_baseline: true, role: 'old' }),
  interval('m1', 'a', '2026-02-01', null, { role: 'new' }),
  interval('m1', 'a', '2026-02-10'),
  interval('m1', 'b', '2026-02-03'),
  interval('m2', 'a', '2026-01-20', '2026-02-01'),
  interval('m2', 'a', '2026-02-12', '2026-02-20'),
  interval('m2', 'a', '2026-03-01'),
];
const historical = { ...data, history, baseline: '2026-01-15T00:00:00Z' };

test('current member totals are tenant distinct, not a sum of group counts; empty and inactive groups retained', () => {
  assert.equal(aggregateMemberGroups(cfg('current_members'), data, options).value, 2);
  assert.equal(aggregateMemberGroups(cfg('groups'), data, options).value, 3);
  const result = aggregateMemberGroups(cfg('current_members', { groupBy: { kind: 'system', field: 'group_id' } }), data, options);
  assert.deepEqual(result.rows, [{ key: 'Alpha', value: 1 }, { key: 'Beta', value: 2 }, { key: 'Empty', value: 0 }]);
  assert.equal(result.total, 2);
  assert.equal(result.clickThroughAvailable, false);
  assert.ok(!JSON.stringify(result).includes('m1'));
});

test('group/member attributes and custom multi-value filters count distinct pairs', () => {
  const filters = [{ fieldKind: 'system', field: 'login_enabled', operator: 'eq', value: false }];
  assert.equal(aggregateMemberGroups(cfg('current_members', { filters }), data, options).value, 1);
  const preferences = [{ member_id: 'm1', field_id: 'f', value: '["UK","USA"]' }];
  const result = aggregateMemberGroups(cfg('current_members', {
    filters: [{ fieldKind: 'custom', fieldId: 'f', operator: 'in', value: ['UK'] }],
    groupBy: { kind: 'custom', fieldId: 'f' },
  }), { ...data, preferences }, options);
  assert.deepEqual(result.rows, [{ key: 'UK', value: 1 }, { key: 'USA', value: 1 }]);
});

test('joins union duplicate and contiguous segments before role filtering; baseline is not a join', () => {
  assert.equal(unionMembershipIntervals(history).length, 5);
  assert.equal(aggregateMemberGroups(cfg('joins'), historical, options).value, 4);
  assert.equal(aggregateMemberGroups(cfg('joins', {
    filters: [{ fieldKind: 'system', field: 'group_role', operator: 'eq', value: 'new' }],
  }), historical, options).value, 0);
  const result = aggregateMemberGroups(cfg('joins', { timeBucket: time }), historical, options);
  assert.deepEqual(result.rows.map(r => r.value), [null, 2, 1]);
});

test('period-end uses actual exclusive period boundary, dedupes overlapping groups, marks current provisional', () => {
  const result = aggregateMemberGroups(cfg('period_end_members', { timeBucket: time }), historical, options);
  assert.deepEqual(result.rows.map(r => r.value), [2, 1, 2]);
  assert.deepEqual(result.rows.map(r => r.provisional), [false, false, true]);
  const byGroup = aggregateMemberGroups(cfg('period_end_members', { timeBucket: time, seriesBy: { kind: 'system', field: 'group_id' } }), historical, options);
  assert.equal(byGroup.rows[1]['group:a'], 1);
  assert.equal(byGroup.rows[1]['group:b'], 1);
  assert.equal(byGroup.rows[1]['group:c'], 0);
  assert.equal(byGroup.seriesLabels['group:a'], 'Alpha');
});

test('pre-baseline totals are null, never zero or inferred from current memberships', () => {
  const result = aggregateMemberGroups(cfg('period_end_members', {
    timeBucket: { ...time, window: { amount: 5, unit: 'month' } },
  }), historical, options);
  assert.deepEqual(result.rows.map(r => r.value), [null, null, 2, 1, 2]);
  assert.equal(result.historyBaseline, historical.baseline);
});

test('UTC day/week/month/quarter/year boundaries and rolling windows', () => {
  for (const [unit, expected, next] of [
    ['day', '2026-03-15', '2026-03-16'],
    ['week', '2026-03-09', '2026-03-16'],
    ['month', '2026-03-01', '2026-04-01'],
    ['quarter', '2026-01-01', '2026-04-01'],
    ['year', '2026-01-01', '2027-01-01'],
  ]) {
    assert.equal(periodStart(now, unit).toISOString().slice(0, 10), expected);
    assert.equal(advancePeriod(periodStart(now, unit), unit).toISOString().slice(0, 10), next);
    const result = aggregateMemberGroups(cfg('period_end_members', {
      timeBucket: { field: 'membership_at', granularity: unit, window: { amount: 2, unit } },
    }), historical, options);
    assert.equal(result.rows.length, 2);
  }
});

test('all save and preview schemas reject incompatible configurations', () => {
  const bad = [
    cfg('groups', { groupBy: { kind: 'system', field: 'group_role' } }),
    cfg('groups', { filters: [{ fieldKind: 'custom', fieldId: 'f', operator: 'eq', value: 'x' }] }),
    cfg('current_members', { timeBucket: time }), cfg('period_end_members'),
    cfg('period_end_members', { timeBucket: time, cumulative: true }),
    cfg('joins', { timeBucket: { ...time, field: 'created_on' } }),
    cfg('current_members', { clickThrough: true }),
    cfg('joins', { seriesBy: { kind: 'system', field: 'group_id' } }),
    cfg('groups', { groupBy: { kind: 'system', field: 'email' } }),
  ];
  for (const config of bad) {
    assert.equal(widgetConfigSchema.safeParse(config).success, false);
    assert.equal(widgetCreateSchema.safeParse({ title: 'Test', scope: 'shared', widget_type: 'stat', config }).success, false);
    assert.equal(widgetUpdateSchema.safeParse({ config }).success, false);
  }
  assert.equal(widgetConfigSchema.safeParse(cfg('joins', { timeBucket: time })).success, true);
});

test('pagination reads beyond 1000 and fails explicitly above cap or on database errors', async () => {
  let calls = 0;
  const rows = Array.from({ length: 2001 }, (_, id) => ({ id }));
  const query = () => ({ range: async (a, b) => { calls++; return { data: rows.slice(a, b + 1) }; } });
  assert.equal((await readMemberGroupPages(query)).length, 2001);
  assert.equal(calls, 3);
  await assert.rejects(readMemberGroupPages(query, 2000), /safety limit/);
  await assert.rejects(readMemberGroupPages(() => ({ range: async () => ({ error: { message: 'denied' } }) })), /denied/);
});

test('duplicate group names stay separate and series names cannot overwrite chart metadata', () => {
  const duplicate = { ...historical, groups: groups.map(g => ({ ...g, name: 'key' })) };
  const grouped = aggregateMemberGroups(cfg('current_members', { groupBy: { kind: 'system', field: 'group_id' } }), duplicate, options);
  assert.deepEqual(grouped.rows.map(r => r.key), ['key (a)', 'key (b)', 'key (c)']);
  const result = aggregateMemberGroups(cfg('period_end_members', {
    timeBucket: time, seriesBy: { kind: 'system', field: 'group_id' },
  }), duplicate, options);
  assert.equal(result.rows[0].key, '2026-01');
  assert.equal(result.seriesLabels['group:a'], 'key (a)');
});

test('deleted members retain authoritative earlier headcounts, current member filters use current attributes', () => {
  const deleted = { ...historical, members: [] };
  assert.equal(aggregateMemberGroups(cfg('period_end_members', { timeBucket: time }), deleted, options).rows[0].value, 2);
  assert.equal(aggregateMemberGroups(cfg('period_end_members', {
    timeBucket: time,
    filters: [{ fieldKind: 'system', field: 'login_enabled', operator: 'eq', value: true }],
  }), deleted, options).rows[0].value, 0);
});

test('unknown cumulative history remains null and bucket/group safety caps fail explicitly', () => {
  const result = aggregateMemberGroups(cfg('joins', { timeBucket: time, cumulative: true }), historical, options);
  assert.deepEqual(result.rows.map(r => r.value), [null, null, null]);
  assert.throws(() => aggregateMemberGroups(cfg('period_end_members', {
    timeBucket: { field: 'membership_at', granularity: 'day', window: { amount: 120, unit: 'year' } },
  }), historical, options), /500 buckets/);
  assert.throws(() => aggregateMemberGroups(cfg('current_members', {
    groupBy: { kind: 'system', field: 'group_id' },
  }), historical, { ...options, maxGroups: 2 }), /group limit/);
});

function fakeClient(tables, queries) {
  return { from(table) {
    const filters = [];
    const query = {
      select() { return this; }, order() { return this; },
      eq(k, v) { filters.push([k, v]); return this; },
      is(k, v) { filters.push([k, v]); return this; },
      in(k, v) { filters.push([k, v]); return this; },
      async range(a, b) {
        queries.push({ table, filters: [...filters] });
        return { data: (tables[table] || []).filter(r => filters.every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v)).slice(a, b + 1) };
      },
    };
    return query;
  } };
}

test('unfiltered organisation measure always reads current tenant members, rejecting foreign rows on every join', async () => {
  const queries = [];
  const tables = {
    member_group: [...groups.map(g => ({ ...g, tenant_id: 'tenant' })), { id: 'foreign-group', tenant_id: 'other' }],
    member: [
      ...organisationData.members.map(m => ({ ...m, tenant_id: 'tenant' })),
      { id: 'foreign-member', organization_id: 'foreign-org', tenant_id: 'other' },
    ],
    member_group_assignment: [
      ...organisationData.assignments.map((a, id) => ({ ...a, id, tenant_id: 'tenant' })),
      { id: 'foreign-member-link', group_id: 'a', member_id: 'foreign-member', tenant_id: 'tenant' },
      { id: 'foreign-assignment', group_id: 'a', member_id: 'excluded', tenant_id: 'other' },
      { id: 'foreign-group-link', group_id: 'foreign-group', member_id: 'excluded', tenant_id: 'tenant' },
    ],
  };
  const result = await runMemberGroupWidgetConfig(cfg('current_organizations'), 'tenant', fakeClient(tables, queries), options);
  assert.equal(result.value, 2);
  assert.ok(queries.some(q => q.table === 'member'));
  assert.ok(queries.every(q => q.filters.some(([k, v]) => k === 'tenant_id' && v === 'tenant')));
  assert.equal((await runMemberGroupWidgetConfig(cfg('current_organizations'), 'empty-tenant', fakeClient(tables, []), options)).value, 0);
});

test('tenant-scoped metadata rejects forged foreign custom fields before accessing values', async () => {
  const queries = [];
  const client = fakeClient({ preference_field: [{ id: 'foreign', tenant_id: 'other', entity_scope: 'member', is_active: true }] }, queries);
  await assert.rejects(runMemberGroupWidgetConfig(cfg('current_members', {
    filters: [{ fieldKind: 'custom', fieldId: 'foreign', operator: 'eq', value: 'x' }],
  }), 'tenant', client), /unavailable for this tenant/);
  assert.ok(queries.every(q => q.table === 'preference_field' && q.filters.some(([k, v]) => k === 'tenant_id' && v === 'tenant')));
});

test('every source read is tenant scoped; preferences are constrained to validated member and field IDs', async () => {
  const queries = [];
  const tenant_id = 'tenant';
  const client = fakeClient({
    preference_field: [{ id: 'f', tenant_id, entity_scope: 'member', is_active: true, field_type: 'text' }],
    member_group: [{ id: 'a', name: 'Alpha', tenant_id }],
    member: [{ id: 'm1', tenant_id }, { id: 'foreign', tenant_id: 'other' }],
    member_group_assignment: [{ id: 'x', group_id: 'a', member_id: 'm1', tenant_id }],
    member_preference_value: [
      { member_id: 'm1', field_id: 'f', value: '"ok"' },
      { member_id: 'foreign', field_id: 'f', value: '"ok"' },
    ],
  }, queries);
  const result = await runMemberGroupWidgetConfig(cfg('current_members', {
    filters: [{ fieldKind: 'custom', fieldId: 'f', operator: 'eq', value: 'ok' }],
  }), tenant_id, client, options);
  assert.equal(result.value, 1);
  for (const q of queries) {
    if (q.table === 'member_preference_value') {
      assert.deepEqual(q.filters, [['field_id', ['f']], ['member_id', ['m1']]]);
    } else assert.ok(q.filters.some(([k, v]) => k === 'tenant_id' && v === tenant_id));
  }
});