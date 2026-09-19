import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCollectionDayAction } from './gocardless-dd.js';

function response() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
const request = { method: 'POST', body: { action: 'preview_collection_day', planId: 'plan', day: 20, tenantId: 'attacker' } };
const context = { tenantId: 'tenant', roleId: 'role', member: { email: 'admin@example.test' } };

test('collection-day API denies unauthenticated and non-admin callers before any database/provider access', async () => {
  const db = { from: () => assert.fail('No database reads before authentication') };
  for (const [getContext, adminAccess, status] of [
    [async () => { throw new Error('No session'); }, async () => true, 401],
    [async () => null, async () => true, 403],
    [async () => context, async () => false, 403],
  ]) {
    const res = response();
    await handleCollectionDayAction(request, res, { db, getContext, adminAccess });
    assert.equal(res.statusCode, status);
  }
});

test('both preview and confirm require both DD and finance features', async () => {
  for (const action of ['preview_collection_day', 'change_collection_day']) {
    for (const missing of ['commerce.gocardless-dd', 'commerce.monthly-finance-report']) {
      const res = response();
      await handleCollectionDayAction({ ...request, body: { ...request.body, action } }, res, {
        db: { from: () => assert.fail('Permission check must precede reads') },
        getContext: async () => context, adminAccess: async () => true,
        featureAccess: async (_, feature) => feature !== missing,
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /finance permissions/);
    }
  }
});

function dbFixture({ crossTenant = false, wrongOwner = false, paused = false, rpcError = null } = {}) {
  const agreement = { id: 'agreement', tenant_id: 'tenant', provider: 'gocardless', status: 'active',
    member_id: 'member', gocardless_mandate_id: 'MD1',
    metadata: { dd: { collection_policy: { version: 1, pricing_policy: 'dynamic' } } } };
  const plan = { id: 'plan', tenant_id: crossTenant ? 'other' : 'tenant', billing_agreement_id: 'agreement',
    member_id: wrongOwner ? 'other-member' : 'member', status: paused ? 'paused' : 'active',
    dynamic_next_collection_date: '2090-01-15',
    metadata: { collection_mode: 'dynamic', dynamic_first_date: '2090-01-15' } };
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = {};
      return {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        async maybeSingle() {
          assert.equal(filters.tenant_id, 'tenant', 'Must use authenticated tenant, not body tenant');
          const row = table === 'membership_payment_plans' ? plan : agreement;
          return { data: Object.entries(filters).every(([k, v]) => row[k] === v) ? row : null };
        },
      };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return rpcError ? { error: { message: rpcError } } : { data: { effective_date: '2090-01-20', version: 0 } };
    },
  };
}
const auth = {
  getContext: async () => context, adminAccess: async () => true, featureAccess: async () => true,
};
const gc = { getMandate: async () => ({ id: 'MD1', status: 'active', next_possible_charge_date: '2090-01-01' }) };

test('API scopes plan lookup to authenticated tenant and rejects owner and lifecycle mismatches', async () => {
  for (const [options, status, pattern] of [
    [{ crossTenant: true }, 404, /Plan not found/],
    [{ wrongOwner: true }, 409, /ownership/],
    [{ paused: true }, 409, /paused/],
  ]) {
    const db = dbFixture(options);
    const res = response();
    await handleCollectionDayAction(request, res, { ...auth, db, gc: { getMandate: () => assert.fail('No provider access') } });
    assert.equal(res.statusCode, status);
    assert.match(res.body.error, pattern);
    assert.equal(db.calls.length, 0);
  }
});

test('authorized API previews use context identity; provider failures and local failures do not report success', async () => {
  const db = dbFixture();
  const res = response();
  await handleCollectionDayAction(request, res, { ...auth, db, gc });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.preview.requestId);
  assert.equal(db.calls[0].args.p_tenant_id, 'tenant');
  assert.equal(db.calls[0].args.p_actor_email, 'admin@example.test');
  for (const deps of [
    { db: dbFixture(), gc: { getMandate: async () => { throw new Error('Provider timeout; retry preview'); } } },
    { db: dbFixture({ rpcError: 'Schedule changed; preview again' }), gc },
  ]) {
    const failed = response();
    await handleCollectionDayAction(request, failed, { ...auth, ...deps });
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.ok, undefined);
    assert.match(failed.body.error, /timeout|preview again/);
  }
});