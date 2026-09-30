import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './[entity]/[id].js';

test('real endpoint archives/restores with admin and tenant checks without deleting history', async () => {
  for (const [authenticated, admin, archive, expected] of [
    [false, true, true, 401], [true, false, true, 403],
    [true, true, true, 200], [true, true, false, 200],
  ]) {
    const calls = [];
    const q = {
      update(value) { calls.push(['update', value]); return q; },
      eq(key, value) { calls.push(['eq', key, value]); return q; },
      select() { return q; },
      async maybeSingle() { return { data: { id: 'ordinary', is_active: false } }; },
    };
    let status = 200;
    const response = { status(code) { status = code; return this; }, json(data) { return data; } };
    await handler({
      method: 'PATCH', query: { entity: 'Form', id: 'ordinary' }, headers: {},
      body: { archived_at: archive ? '2026-09-29T12:00:00Z' : null },
    }, response, {
      supabase: { from(table) { assert.equal(table, 'form'); return q; } },
      getTenantContext: async () => ({ tenantId: 'tenant', isAuthenticated: authenticated }),
      hasAdminAccess: async () => admin,
    });
    assert.equal(status, expected);
    if (expected === 200) {
      assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 'tenant'));
      assert.equal(calls.find(c => c[0] === 'update')[1].is_active, false);
      assert.equal(Boolean(calls.find(c => c[0] === 'update')[1].archived_at), archive);
    } else assert.deepEqual(calls, []);
  }
});