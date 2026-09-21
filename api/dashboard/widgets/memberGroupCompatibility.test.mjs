import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createPreview } from './preview.js';
import { createHandler as createWidget } from './index.js';
import { createHandler as createUpdate } from './[id].js';
import { runMemberGroupWidgetConfig } from '../_lib/memberGroupAggregation.js';
import { validateMemberGroupWidgetType } from '../_lib/memberGroupContract.js';

const actor = { tenantId: 'tenant', memberId: 'member', permissions: { view: true, manageShared: true, managePersonal: true } };
const config = {
  source: 'member_group',
  measure: { aggregator: 'count', field: 'joins', fieldKind: 'system' },
  timeBucket: { field: 'membership_at', granularity: 'month' },
  filters: [],
};
const response = () => ({
  statusCode: 200, setHeader() {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const forbiddenDb = { from() { throw new Error('unexpected database access'); } };
const failures = [
  ['pie', config], ['donut', config],
  ['pie', { ...config, timeBucket: null }],
  ['stat', { ...config, seriesBy: { kind: 'system', field: 'group_id' } }],
];

test('preview rejects temporal pie/donut, stat series and missing type before aggregation', async () => {
  let calls = 0;
  const handler = createPreview({
    getDashboardActor: async () => actor,
    runWidgetConfig: async () => { calls++; return {}; },
  });
  for (const [widgetType, cfg] of [...failures, [undefined, config]]) {
    const res = response();
    await handler({ method: 'POST', body: { config: cfg, widgetType } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Member Groups/);
  }
  assert.equal(calls, 0);
  for (const widgetType of ['stat', 'bar', 'line', 'list']) {
    const res = response();
    await handler({ method: 'POST', body: { config, widgetType } }, res);
    assert.equal(res.statusCode, 200);
  }
});

test('shared and personal create reject incompatible widget types before any database write', async () => {
  const handler = createWidget({ supabase: forbiddenDb, getDashboardActor: async () => actor });
  for (const scope of ['shared', 'personal']) for (const [widget_type, cfg] of failures) {
    const res = response();
    await handler({ method: 'POST', body: { title: 'Group metric', scope, widget_type, config: cfg } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Member Groups/);
  }
});

test('PATCH validates merged saved config/type, including type-only and config-only updates', async () => {
  const saved = { id: 'widget', tenant_id: 'tenant', scope: 'shared', widget_type: 'line', config };
  const db = { from() {
    return { select() { return this; }, eq() { return this; }, single: async () => ({ data: saved }) };
  } };
  const handler = createUpdate({ supabase: db, getDashboardActor: async () => actor });
  for (const body of [
    { widget_type: 'pie' }, { widget_type: 'donut' },
    { widget_type: 'stat', config: failures[3][1] },
  ]) {
    const res = response();
    await handler({ method: 'PATCH', query: { id: saved.id }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Member Groups/);
  }
  saved.widget_type = 'stat';
  const res = response();
  await handler({ method: 'PATCH', query: { id: saved.id }, body: { config: failures[3][1] } }, res);
  assert.equal(res.statusCode, 400);
});

test('null tenant historical requests fail explicitly without reading global baseline; current requests still work', async () => {
  for (const field of ['joins', 'period_end_members']) {
    await assert.rejects(runMemberGroupWidgetConfig({
      ...config, measure: { aggregator: 'count', field },
    }, null, forbiddenDb), /history is unavailable for a null tenant/);
  }
  const queries = [];
  const db = { from(table) {
    const filters = [];
    return {
      select() { return this; }, eq(k, v) { filters.push([k, v]); return this; },
      is(k, v) { filters.push([k, v]); return this; }, order() { return this; },
      async range() { queries.push({ table, filters }); return { data: [] }; },
    };
  } };
  const result = await runMemberGroupWidgetConfig({
    source: 'member_group', measure: { aggregator: 'count', field: 'groups' }, filters: [],
  }, null, db);
  assert.equal(result.value, 0);
  assert.ok(queries.every(q => q.filters.some(([k, v]) => k === 'tenant_id' && v === null)));
});

test('count-only measures and period-end no-cumulative rules are never silently coerced', async () => {
  const handler = createPreview({ getDashboardActor: async () => actor, runWidgetConfig: async () => assert.fail('must reject first') });
  for (const bad of [
    { ...config, measure: { aggregator: 'sum', field: 'joins' } },
    { ...config, measure: { aggregator: 'count_distinct', field: 'joins' } },
    { ...config, measure: { aggregator: 'count', field: 'period_end_members' }, cumulative: true },
  ]) {
    const res = response();
    await handler({ method: 'POST', body: { config: bad, widgetType: 'line' } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.doesNotThrow(() => validateMemberGroupWidgetType({
    ...config, timeBucket: null, measure: { aggregator: 'count', field: 'current_members' },
  }, 'pie'));
});