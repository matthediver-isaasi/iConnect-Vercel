import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateMembershipValueWidgetType,
  widgetConfigSchema,
  widgetCreateSchema,
  widgetUpdateSchema,
} from './validation.js';
import { canAccessMembershipValue, isMembershipValueConfig } from './permissions.js';
import { createHandler as createPreview } from '../widgets/preview.js';
import { createHandler as createUpdate } from '../widgets/[id].js';

const config = {
  source: 'organisation_membership',
  measure: { aggregator: 'count', field: 'id', fieldKind: 'system' },
  filters: [],
  membershipValue: { startMonth: 4, startYear: 2026, currency: 'GBP' },
};

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('annual membership value schema is stat-only and validates its dedicated config', () => {
  assert.equal(widgetConfigSchema.safeParse(config).success, true);
  assert.equal(widgetConfigSchema.safeParse({ ...config, membershipValue: null }).success, false);
  assert.equal(widgetConfigSchema.safeParse({
    ...config,
    filters: [{ fieldKind: 'system', field: 'status', operator: 'eq', value: 'active' }],
  }).success, false);
  assert.equal(widgetCreateSchema.safeParse({
    title: 'Value', scope: 'shared', widget_type: 'stat', config,
  }).success, true);
  assert.equal(widgetCreateSchema.safeParse({
    title: 'Value', scope: 'shared', widget_type: 'bar', config,
  }).success, false);
  assert.equal(widgetUpdateSchema.safeParse({ widget_type: 'bar', config }).success, false);
  assert.throws(() => validateMembershipValueWidgetType(config, 'line'), /KPI\/stat/);
});

test('financial source recognition and permission are explicit, not implied by dashboard view', () => {
  assert.equal(isMembershipValueConfig(config), true);
  assert.equal(isMembershipValueConfig({ source: 'organization' }), false);
  assert.equal(canAccessMembershipValue({ permissions: { view: true } }), false);
  assert.equal(canAccessMembershipValue({
    permissions: { view: true, viewMembershipValue: true },
  }), true);
});

test('preview denies financial configs before aggregation and permits authorized stat previews', async () => {
  let calls = 0;
  const deniedHandler = createPreview({
    getDashboardActor: async () => ({ permissions: { view: true } }),
    runWidgetConfig: async () => { calls++; return {}; },
  });
  const denied = response();
  await deniedHandler({ method: 'POST', body: { config, widgetType: 'stat' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);

  const allowedHandler = createPreview({
    getDashboardActor: async () => ({
      tenantId: 'tenant',
      permissions: { view: true, viewMembershipValue: true },
    }),
    runWidgetConfig: async () => { calls++; return { rows: [{ value: 12 }] }; },
  });
  const allowed = response();
  await allowedHandler({ method: 'POST', body: { config, widgetType: 'stat' } }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls, 1);
});

test('PATCH validates the merged saved type for config-only and type-only changes', async () => {
  const actor = {
    tenantId: 'tenant',
    memberId: 'member',
    permissions: {
      view: true,
      manageShared: true,
      viewMembershipValue: true,
    },
  };
  const saved = {
    id: 'widget',
    tenant_id: 'tenant',
    scope: 'shared',
    widget_type: 'bar',
    config,
  };
  const db = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: saved }),
      };
    },
  };
  const handler = createUpdate({ supabase: db, getDashboardActor: async () => actor });
  for (const body of [{ title: 'Still invalid' }, { config }, { widget_type: 'bar' }]) {
    const res = response();
    await handler({ method: 'PATCH', query: { id: saved.id }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /KPI\/stat/);
  }
});