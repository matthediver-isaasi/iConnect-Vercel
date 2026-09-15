import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteOrDeactivateBadge } from './badgeDelete.js';

function mockSupabase({ deleteResult, updateResult }) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, operation: null, filters: [], payload: null };
      calls.push(call);
      const chain = {
        delete() { call.operation = 'delete'; return this; },
        update(payload) { call.operation = 'update'; call.payload = payload; return this; },
        eq(column, value) { call.filters.push([column, value]); return this; },
        select() {
          return Promise.resolve(call.operation === 'delete' ? deleteResult : updateResult);
        },
      };
      return chain;
    },
  };
}

test('permanently deletes an unreferenced badge within its tenant', async () => {
  const db = mockSupabase({ deleteResult: { data: [{ id: 'b1' }], error: null } });
  assert.deepEqual(
    await deleteOrDeactivateBadge(db, { id: 'b1', tenantId: 't1' }),
    { ok: true, outcome: 'deleted' },
  );
  assert.deepEqual(db.calls[0].filters, [['id', 'b1'], ['tenant_id', 't1']]);
  assert.equal(db.calls.length, 1);
});

test('deactivates a tenant badge when history restricts deletion', async () => {
  const badge = { id: 'b1', tenant_id: 't1', is_active: false };
  const db = mockSupabase({
    deleteResult: { data: null, error: { code: '23503', message: 'foreign key violation' } },
    updateResult: { data: [badge], error: null },
  });
  assert.deepEqual(
    await deleteOrDeactivateBadge(db, { id: 'b1', tenantId: 't1' }),
    { ok: true, outcome: 'deactivated', badge },
  );
  assert.deepEqual(db.calls[1].payload, { is_active: false });
  assert.deepEqual(db.calls[1].filters, [['id', 'b1'], ['tenant_id', 't1']]);
});

test('does not hide non-foreign-key delete failures', async () => {
  const db = mockSupabase({
    deleteResult: { data: null, error: { code: '42501', message: 'permission denied' } },
  });
  assert.deepEqual(
    await deleteOrDeactivateBadge(db, { id: 'b1', tenantId: 't1' }),
    { ok: false, status: 500, error: 'permission denied' },
  );
  assert.equal(db.calls.length, 1);
});

test('fails closed without tenant context and cannot touch another tenant', async () => {
  const noTenantDb = mockSupabase({});
  assert.deepEqual(
    await deleteOrDeactivateBadge(noTenantDb, { id: 'b1', tenantId: null }),
    { ok: false, status: 403, error: 'Valid tenant context required' },
  );
  assert.equal(noTenantDb.calls.length, 0);

  const wrongTenantDb = mockSupabase({ deleteResult: { data: [], error: null } });
  assert.deepEqual(
    await deleteOrDeactivateBadge(wrongTenantDb, { id: 'b1', tenantId: 't2' }),
    { ok: false, status: 404, error: 'Badge not found' },
  );
  assert.deepEqual(wrongTenantDb.calls[0].filters, [['id', 'b1'], ['tenant_id', 't2']]);
});