import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVoucherEntity, authorizeVoucherSettingWrite } from './voucherEntityBoundary.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
const organizationId = '00000000-0000-4000-8000-000000000003';
const id = '00000000-0000-4000-8000-000000000004';
function fixture({ admin = false, data = [], error = null, method = 'GET', entity = 'voucher', body = {}, query = {}, context = {} } = {}) {
  const calls = [];
  const builder = new Proxy({}, { get(_, key) {
    if (key === 'then') return resolve => resolve({ data, error, count: data?.length || 0 });
    return (...args) => { calls.push([key, ...args]); return builder; };
  } });
  const db = {
    from: table => { calls.push(['from', table]); return builder; },
    rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: { id }, error }; },
  };
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  return { entity, req: { method, body, query }, res, db, calls,
    context: { isAuthenticated: true, tenantId, memberId, organizationId, ...context },
    hasAdminAccess: async () => admin };
}

test('unrelated entity is untouched; anonymous and tenant mismatch fail before database access', async () => {
  for (const context of [{ isAuthenticated: false }, { tenantMismatch: true }, { tenantId: null }]) {
    const f = fixture({ context });
    assert.equal(await handleVoucherEntity(f), true);
    assert.ok([401, 403, 409].includes(f.res.code));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ entity: 'member' });
  assert.equal(await handleVoucherEntity(f), false);
});

test('member reads include personal and own org only with a hard tenant predicate', async () => {
  const f = fixture();
  await handleVoucherEntity(f);
  assert.equal(f.res.code, 200);
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === tenantId));
  assert.ok(f.calls.some(c => c[0] === 'or'
    && c[1] === `member_id.eq.${memberId},organization_id.eq.${organizationId}`));
});

test('members without organisations retain personal history', async () => {
  const f = fixture({ context: { organizationId: null } });
  await handleVoucherEntity(f);
  assert.ok(f.calls.some(c => c[0] === 'or' && c[1] === `member_id.eq.${memberId}`));
});

test('ledger access follows original voucher owner, not transaction member actor', async () => {
  const f = fixture({ entity: 'vouchertransaction', data: [{
    id, member_id: 'different-spender', voucher: { tenant_id: tenantId, member_id: memberId, organization_id: null },
  }] });
  await handleVoucherEntity(f);
  assert.ok(f.calls.some(c => c[0] === 'or' && c[2]?.referencedTable === 'voucher'));
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'voucher.tenant_id'));
  assert.equal(f.res.body[0].member_id, 'different-spender');
  assert.equal(f.res.body[0].owner_member_id, memberId);
  assert.equal(f.res.body[0].owner_type, 'member');
  assert.equal(f.res.body[0].voucher, undefined);
});

test('admin reads still use hard tenant predicate', async () => {
  const f = fixture({ admin: true });
  await handleVoucherEntity(f);
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === tenantId));
  assert.ok(!f.calls.some(c => c[0] === 'or'));
});

test('voucher default ordering uses the live issue-date column; ledger retains created_at', async () => {
  for (const admin of [true, false]) {
    const f = fixture({ admin });
    await handleVoucherEntity(f);
    assert.equal(f.res.code, 200);
    assert.ok(f.calls.some(c => c[0] === 'order' && c[1] === 'issued_at'));
    assert.ok(!f.calls.some(c => c[0] === 'order' && c[1] === 'created_at'));
    assert.ok(f.calls.some(c => c[0] === 'order' && c[1] === 'id'));
  }
  const ledger = fixture({ entity: 'vouchertransaction', data: [] });
  await handleVoucherEntity(ledger);
  assert.ok(ledger.calls.some(c => c[0] === 'order' && c[1] === 'created_at'));
});

test('forged filters cannot replace scope and projections cannot traverse related records', async () => {
  const f = fixture({ query: { filter: JSON.stringify({ member_id: id }) } });
  await handleVoucherEntity(f);
  assert.ok(f.calls.some(c => c[0] === 'or' && c[1].includes(memberId)));
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'member_id' && c[2] === id));
  for (const query of [
    { expand: '*,member(*)' }, { filter: '{"member.email":"private"}' },
    { filter: '{"id":{"or":"tenant_id.is.null"}}' }, { sort: '{"member.email":"asc"}' },
  ]) {
    const f = fixture({ query });
    await handleVoucherEntity(f);
    assert.equal(f.res.code, 400);
  }
});

test('by-id absence is not distinguishable from inaccessible credit', async () => {
  const f = fixture({ data: null });
  f.id = id;
  await handleVoucherEntity(f);
  assert.equal(f.res.code, 404);
  assert.ok(f.calls.some(c => c[0] === 'or'));
});

test('members cannot issue, edit, delete or manufacture ledger rows', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const f = fixture({ method, body: { value: 100 } });
    await handleVoucherEntity(f);
    assert.equal(f.res.code, 403);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ method: 'POST', entity: 'vouchertransaction', admin: true });
  await handleVoucherEntity(f);
  assert.equal(f.res.code, 403);
  assert.deepEqual(f.calls, []);
});

test('issue requires retry key, ignores forged tenant and actor, never adds organisation fallback', async () => {
  const f = fixture({ method: 'POST', admin: true, body: {
    member_id: memberId, value: 100, idempotency_key: 'stable-issue',
    tenant_id: id, created_by: 'forged', used_at: 'forged',
  } });
  await handleVoucherEntity(f);
  assert.equal(f.res.code, 201);
  const args = f.calls.find(c => c[0] === 'rpc')[2];
  assert.equal(args.p_tenant_id, tenantId);
  assert.equal(args.p_actor, memberId);
  assert.equal(args.p_idempotency_key, 'stable-issue');
  assert.deepEqual(args.p_values, { member_id: memberId, value: 100 });
  const missing = fixture({ method: 'POST', admin: true });
  await handleVoucherEntity(missing);
  assert.equal(missing.res.code, 400);
});

test('database read failure is explicit, not an empty balance', async () => {
  const f = fixture({ error: { message: 'unavailable' } });
  await handleVoucherEntity(f);
  assert.equal(f.res.code, 503);
  assert.ok(!Array.isArray(f.res.body));
});

test('protected settings cannot be edited through generic create or by-id rename', async () => {
  const f = fixture({ entity: 'systemsettings', method: 'POST',
    body: { setting_key: 'individual_vouchers_enabled', setting_value: 'true' } });
  assert.equal(await authorizeVoucherSettingWrite(f), true);
  assert.equal(f.res.code, 403);
  const g = fixture({ entity: 'systemsettings', method: 'PATCH',
    body: { setting_key: 'unprotected' }, data: { setting_key: 'member_voucher_display_name' } });
  g.id = id;
  assert.equal(await authorizeVoucherSettingWrite(g), true);
  assert.equal(g.res.code, 403);
});

test('admin setting values trim independently, including explicit clearing', async () => {
  for (const value of [' Credit ', '   ']) {
    const f = fixture({ entity: 'systemsettings', method: 'POST', admin: true,
      body: { setting_key: 'member_voucher_display_name', setting_value: value } });
    assert.equal(await authorizeVoucherSettingWrite(f), false);
    assert.equal(f.req.body.setting_value, value.trim());
    assert.equal(f.req.body.organization_voucher_display_name, undefined);
  }
});

test('accounting funding mappings require admin even when generic settings writes are available', async () => {
  for (const key of ['xero_voucher_clearing_account_code', 'quickbooks_program_sales_item_id',
    'program_price_vat_rate_percent', 'xero_training_fund_clearing_account_code']) {
    const f = fixture({ entity: 'systemsettings', method: 'POST',
      body: { setting_key: key, setting_value: 'forged' } });
    assert.equal(await authorizeVoucherSettingWrite(f), true);
    assert.equal(f.res.code, 403);
  }
});
