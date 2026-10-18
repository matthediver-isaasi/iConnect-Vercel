import assert from 'node:assert/strict';
import test from 'node:test';
import { createSalesAccountingHandler } from '../sales/accounting/[...path].js';
import { __setRoleAccessOverlayForTests } from './roleVisibility.js';
import { getSalesSchedules } from './salesInvoiceSchedule.js';

__setRoleAccessOverlayForTests([]);
const response = () => ({ status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; }, setHeader() {} });
const baseSchedule = { id: 'schedule', sale_id: 'sale', tenant_id: 'tenant', status: 'blocked',
  provider: 'xero', accounting_request_id: null };
function fixture({ schedule = baseSchedule, auditError = null, delivery = { status: 'sent' }, context } = {}) {
  const order = [], audits = [];
  const dependencies = {
    db: { from(table) {
      assert.equal(table, 'sales_audit_event');
      return { async insert(row) { order.push('audit'); audits.push(row); return { error: auditError }; } };
    } },
    getTenantContext: async () => context || { tenantId: 'tenant', tenantUserId: 'admin', isAuthenticated: true },
    hasFeatureAccess: async () => false,
    getSalesSchedules: async () => [schedule],
    refreshSalesInvoiceStatus: async () => { order.push('refresh'); return { invoice: { id: 'invoice' } }; },
    dispatchSalesSchedule: async (_db, _tenant, _id, command) => {
      order.push('dispatch'); assert.equal(command.actorId, 'admin'); return { status: 'queued' };
    },
    deliverSalesSchedule: async () => { order.push('deliver'); return delivery; },
  };
  return { order, audits, handler: createSalesAccountingHandler(dependencies) };
}
const request = action => ({ method: 'POST', url: `/api/sales/accounting/sale?action=${action}`,
  body: { scheduleId: 'schedule' } });

for (const scenario of [
  { action: 'refresh-schedule', effect: 'refresh', schedule: { ...baseSchedule, status: 'invoiced' } },
  { action: 'retry-schedule', effect: 'dispatch', schedule: baseSchedule },
  { action: 'retry-schedule', effect: 'dispatch', schedule: { ...baseSchedule, status: 'queued', accounting_request_id: 'request' } },
  { action: 'retry-schedule', effect: 'deliver', schedule: { ...baseSchedule, status: 'invoiced', delivery_status: 'rejected' } },
]) {
  test(`${scenario.effect}/${scenario.schedule.status}: actor audit is durable before manual effect`, async () => {
    const f = fixture(scenario), res = response();
    await f.handler(request(scenario.action), res);
    assert.equal(res.code, 200);
    assert.deepEqual(f.order, ['audit', scenario.effect]);
    assert.equal(f.audits[0].actor_id, 'admin');
    assert.equal(f.audits[0].actor_type, 'tenant_user');
    assert.equal(f.audits[0].tenant_id, 'tenant');
    assert.equal(f.audits[0].entity_id, 'schedule');
    assert.equal(f.audits[0].after_data.saleId, 'sale');
  });
  test(`${scenario.effect}/${scenario.schedule.status}: audit failure starts no dispatch/provider/email effect`, async () => {
    const f = fixture({ ...scenario, auditError: new Error('Audit unavailable') }), res = response();
    await f.handler(request(scenario.action), res);
    assert.equal(res.code, 500);
    assert.deepEqual(f.order, ['audit']);
  });
}
test('rejected delivery cooldown returns an explicit retry-at conflict, not silent skipped success', async () => {
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const f = fixture({ schedule: { ...baseSchedule, status: 'invoiced', delivery_status: 'rejected', next_attempt_at: retryAt } });
  const res = response();
  await f.handler(request('retry-schedule'), res);
  assert.equal(res.code, 409);
  assert.equal(res.body.code, 'SCHEDULE_DELIVERY_COOLDOWN');
  assert.equal(res.body.details.retryAt, retryAt);
  assert.deepEqual(f.order, ['audit']);
});
test('delivery claim lost to another worker returns an explicit conflict after audited attempt', async () => {
  const f = fixture({ schedule: { ...baseSchedule, status: 'invoiced', delivery_status: 'rejected' }, delivery: { skipped: true } });
  const res = response();
  await f.handler(request('retry-schedule'), res);
  assert.equal(res.code, 409);
  assert.equal(res.body.code, 'SCHEDULE_DELIVERY_NOT_CLAIMED');
  assert.deepEqual(f.order, ['audit', 'deliver']);
});
test('Sales accounting permission denial prevents audit and effects', async () => {
  const f = fixture({ context: { tenantId: 'tenant', memberId: 'member', roleId: 'role', isAuthenticated: true } });
  const res = response();
  await f.handler(request('refresh-schedule'), res);
  assert.equal(res.code, 403);
  assert.deepEqual(f.order, []);
});
test('schedule presentation disables rejected delivery retry until its disclosed retry date', async () => {
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const row = { ...baseSchedule, status: 'invoiced', delivery_status: 'rejected', next_attempt_at: retryAt };
  const db = { from(table) {
    const query = { then(resolve) { resolve({ data: table === 'sales_invoice_schedule' ? [row] : [] }); } };
    for (const method of ['select', 'eq', 'order']) query[method] = () => query;
    return query;
  } };
  const [presented] = await getSalesSchedules(db, 'tenant', 'sale');
  assert.equal(presented.can_retry, false);
  assert.equal(presented.retry_at, retryAt);
});
