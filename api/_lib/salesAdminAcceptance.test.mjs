import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';

function fixture(status = 'issued', conflict = false, authorized = true) {
  const calls = [];
  const db = {
    from(table) {
      assert.ok(['sales_quote', 'sales_quote_version'].includes(table));
      return { select() { return this; }, eq(key, value) {
        if (key === 'tenant_id') assert.equal(value, 'tenant');
        return this;
      }, maybeSingle: async () => ({ data: { id: 'quote', current_version: 1 } }),
      order: async () => ({ data: [{ id: 'version', version_number: 1, status }] }) };
    },
    rpc: async (name, args) => { calls.push({ name, args }); return conflict
      ? { error: { code: '40001' } } : { data: { id: 'quote', status: 'accepted', row_version: 3 } }; },
  };
  const handler = createSalesQuotesHandler({ db, getTenantContext: async () => authorized
    ? { isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'staff' } : { isAuthenticated: false } });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const run = () => handler({ method: 'POST', url: '/api/sales/quotes/quote?action=transition',
    query: { action: 'transition' }, body: { status: 'accepted', expectedVersion: 2, note: 'Approved by phone' } }, res);
  return { calls, res, run };
}

test('staff may accept issued or sent quotes through the shared atomic transition with audit evidence', async () => {
  for (const status of ['issued', 'sent']) {
    const f = fixture(status);
    await f.run();
    assert.equal(f.res.statusCode, 200);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { name: 'transition_sales_quote', args: {
      p_tenant_id: 'tenant', p_quote_id: 'quote', p_expected_version: 2, p_status: 'accepted',
      p_note: 'Accepted by staff on behalf of the customer. Approved by phone',
      p_actor_id: 'staff', p_actor_type: 'tenant_user',
    } });
  }
});
test('draft and terminal quotes cannot be accepted again; stale writes and unauthenticated requests are rejected', async () => {
  for (const status of ['draft', 'accepted', 'declined', 'expired', 'superseded', 'converted']) {
    const f = fixture(status);
    await f.run();
    assert.equal(f.res.statusCode, 409);
    assert.equal(f.calls.length, 0);
  }
  const stale = fixture('sent', true);
  await stale.run();
  assert.equal(stale.res.statusCode, 409);
  const denied = fixture('issued', false, false);
  await denied.run();
  assert.ok([401, 403].includes(denied.res.statusCode));
  assert.equal(denied.calls.length, 0);
});
