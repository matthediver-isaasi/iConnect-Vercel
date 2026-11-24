import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';
import { listQuotes } from './salesQuote.js';

const response = () => ({
  statusCode: 0, body: null, setHeader() {},
  status(n) { this.statusCode = n; return this; },
  json(body) { this.body = body; return this; },
});
const context = { isAuthenticated: true, tenantId: 'server-tenant', tenantUserId: 'server-actor' };

test('proposal lifecycle derives tenant and actor, and never invokes the old cancel/delete RPC', async () => {
  for (const action of ['archive', 'restore', 'delete']) {
    const calls = [];
    const handler = createSalesQuotesHandler({
      db: { rpc: async (name, args) => { calls.push({ name, args }); return { data: { ok: true } }; } },
      getTenantContext: async () => context,
    });
    const res = response();
    await handler({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: `/api/sales/quotes/quote-one${action === 'delete' ? '' : `?action=${action}`}`,
      body: { expectedVersion: 7, confirmDelete: true, tenantId: 'forged', actorId: 'forged' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{ name: 'set_sales_quote_archive', args: {
      p_tenant: 'server-tenant', p_quote: 'quote-one', p_version: 7, p_action: action,
      p_actor: 'server-actor', p_actor_type: 'tenant_user',
    } }]);
  }
});

test('lifecycle requires proposal management, valid revision and explicit deletion confirmation', async () => {
  let calls = 0;
  const db = { rpc: async () => { calls++; return { data: {} }; } };
  for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: 1 }, { expectedVersion: '1', confirmDelete: true }]) {
    const res = response();
    await createSalesQuotesHandler({ db, getTenantContext: async () => context })({
      method: 'DELETE', url: '/api/sales/quotes/quote-one', body,
    }, res);
    assert.equal(res.statusCode, 400);
  }
  const res = response();
  await createSalesQuotesHandler({
    db, getTenantContext: async () => ({ ...context, tenantUserId: null, memberId: 'member', roleId: 'custom-role' }),
    hasFeatureAccess: async (_role, feature) => feature === 'sales.view',
  })({ method: 'POST', url: '/api/sales/quotes/quote-one?action=archive', body: { expectedVersion: 1 } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls, 0);
});

test('lifecycle returns actionable blockers, conflicts, missing-record and rollout responses', async () => {
  for (const [code, status] of [['PT409',409], ['23503',409], ['23514',409], ['P0002',404], ['PGRST202',503], ['22023',400]]) {
    const res = response();
    await createSalesQuotesHandler({
      db: { rpc: async () => ({ error: { code, message: 'Keep this proposal archived.' } }) },
      getTenantContext: async () => context,
    })({ method: 'DELETE', url: '/api/sales/quotes/quote-one', body: { expectedVersion: 4, confirmDelete: true } }, res);
    assert.equal(res.statusCode, status);
    assert.match(res.body.error, status === 503 ? /database update/ : /Keep this proposal archived/);
  }
});

test('proposal visibility is applied before paging and retains opportunity/status/search filters', async () => {
  const roots = [
    { id: 'active', current_version: 1, archived_at: null },
    { id: 'archived-a', current_version: 1, archived_at: '2026-11-24' },
    { id: 'archived-b', current_version: 1, archived_at: '2026-11-24' },
    { id: 'legacy-deleted', current_version: 1, archived_at: null, exhibition_deleted_at: '2026-11-24' },
  ];
  const conditions = [];
  const db = { from(table) {
    return { select() { return this; }, order() { return this; },
      eq(k,v) { conditions.push([table,k,v]); return this; }, in() { return this; },
      then(resolve) { return Promise.resolve({ data: table === 'sales_quote' ? roots
        : roots.map(r => ({ quote_id: r.id, version_number: 1, status: 'draft', customer_reference: 'Example' })) }).then(resolve); },
    };
  } };
  const active = await listQuotes(db, 'tenant', {});
  assert.deepEqual(active.items.map(r => r.id), ['active']);
  const archived = await listQuotes(db, 'tenant', {
    archived: 'true', opportunityId: 'opportunity', page: 2, pageSize: 1, status: 'draft', search: 'example',
  });
  assert.equal(archived.total, 2);
  assert.equal(archived.totalPages, 2);
  assert.deepEqual(archived.items.map(r => r.id), ['archived-b']);
  assert.ok(conditions.some(c => c[0] === 'sales_quote' && c[1] === 'opportunity_id' && c[2] === 'opportunity'));
  assert.ok(conditions.every(c => c[1] !== 'tenant_id' || c[2] === 'tenant'));
});
