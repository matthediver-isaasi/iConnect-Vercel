import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './dd-cancellation-requests.js';

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const auth = {
  getContext: async () => ({ tenantId: 'tenant', roleId: 'admin-role', email: 'admin@example.test' }),
  adminAccess: async () => true,
  featureAccess: async (role, feature) => role === 'admin-role' && feature === 'commerce.gocardless-dd',
  getProvider: async () => assert.fail('No provider calls allowed'),
  claimCancellation: async () => assert.fail('No cancellation claims allowed'),
};

function fixture({ errorTable, missingPlan = false, planProvider = 'gocardless', agreementProvider = 'gocardless' } = {}) {
  const kinds = ['visible', 'deleted', 'missing', 'foreign', 'org', 'missing-org', 'foreign-org', 'conflict-org'];
  const agreements = kinds.map(k => ({
    id: `a-${k}`, provider: agreementProvider, tenant_id: 'tenant',
    ...(k.includes('org') ? { organization_id: k === 'conflict-org' ? 'org' : k } : { member_id: k }),
  }));
  const plans = agreements.map((a, n) => ({
    ...a, provider: planProvider, id: `p-${kinds[n]}`, billing_agreement_id: a.id, status: 'active',
    gocardless_subscription_id: `sub-${n}`,
    ...(kinds[n] === 'conflict-org' ? { organization_id: 'org2' } : {}),
  }));
  const tables = {
    member: [
      { id: 'visible', tenant_id: 'tenant', email: null, status: 'disabled' },
      { id: 'deleted', tenant_id: 'tenant', email: 'deleted_123@deleted.local' },
      { id: 'foreign', tenant_id: 'other', email: 'someone@example.test' },
    ],
    organization: [{ id: 'org', tenant_id: 'tenant' }, { id: 'org2', tenant_id: 'tenant' }, { id: 'foreign-org', tenant_id: 'other' }],
    membership_billing_agreements: agreements,
    membership_payment_plans: missingPlan ? [] : plans,
    membership_dd_cancellation_requests: kinds.map(k => ({
      id: k, tenant_id: 'tenant', plan_id: `p-${k}`, billing_agreement_id: `a-${k}`, status: 'pending',
    })).concat([{ id: 'other-tenant', tenant_id: 'other', member_id: 'visible', status: 'pending' }]),
  };
  const mutations = [], reads = [];
  return {
    mutations, reads,
    from(table) {
      const filters = [];
      let patch = null;
      function result(single = false) {
        reads.push({ table, filters });
        if (table === errorTable) return { data: null, error: { message: `${table} unavailable` } };
        const rows = (tables[table] || []).filter(r => filters.every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
        const data = rows.map(r => patch ? { ...r, ...patch } : r);
        return { data: single ? data[0] || null : data };
      }
      return {
        select() { return this; }, order() { return this; }, limit() { return this; },
        eq(k, v) { filters.push([k, v]); return this; },
        in(k, v) { filters.push([k, v]); return this; },
        update(value) { patch = value; mutations.push({ table, value, filters }); return this; },
        async insert(value) { mutations.push({ table, value }); return { data: value }; },
        async maybeSingle() { return result(true); },
        then(resolve) { resolve(result()); },
      };
    },
  };
}

test('actual cancellation GET filters deleted/missing/cross-tenant/conflicting owners while retaining disabled and org-only requests', async () => {
  const db = fixture(), res = response();
  await handler({ method: 'GET', query: { tenantId: 'other' } }, res, { ...auth, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.requests.map(r => r.id), ['visible', 'org']);
  assert.deepEqual(db.mutations, []);
  assert.ok(db.reads.every(r => r.filters.some(([k, v]) => k === 'tenant_id' && v === 'tenant')));
});

test('actual cancellation POST rejects hidden owners before claims, provider access or database mutation', async () => {
  for (const id of ['deleted', 'missing', 'foreign', 'missing-org', 'foreign-org', 'conflict-org', 'other-tenant']) {
    for (const decision of ['approve', 'reject']) {
      const db = fixture(), res = response();
      await handler({ method: 'POST', body: { requestId: id, decision, cancelScope: 'mandate', tenantId: 'other' } }, res, { ...auth, db });
      assert.equal(res.statusCode, 404, `${id}: ${decision}`);
      assert.equal(res.body.error, 'Request not found');
      assert.deepEqual(db.mutations, []);
    }
  }
  const db = fixture({ missingPlan: true }), res = response();
  await handler({ method: 'POST', body: { requestId: 'visible', decision: 'approve' } }, res, { ...auth, db });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(db.mutations, []);
});

test('actual cancellation boundary reports read errors explicitly without writes', async () => {
  for (const errorTable of ['membership_dd_cancellation_requests', 'membership_payment_plans', 'membership_billing_agreements', 'member', 'organization']) {
    for (const method of ['GET', 'POST']) {
      const db = fixture({ errorTable }), res = response();
      await handler({ method, query: {}, body: { requestId: errorTable === 'organization' ? 'org' : 'visible', decision: 'approve' } }, res, { ...auth, db });
      assert.equal(res.statusCode, 500, `${errorTable}: ${method}`);
      assert.match(res.body.error, /unavailable/);
      assert.deepEqual(db.mutations, []);
    }
  }
});

test('actual cancellation boundary authenticates and authorizes before reads', async () => {
  for (const method of ['GET', 'POST']) {
    for (const [override, status] of [
      [{ getContext: async () => { throw new Error('No session'); } }, 401],
      [{ adminAccess: async () => false }, 403],
      [{ featureAccess: async () => false }, 403],
    ]) {
      const res = response();
      await handler({ method, query: {}, body: {} }, res, {
        ...auth, ...override, db: { from: () => assert.fail('No database access before auth') },
      });
      assert.equal(res.statusCode, status);
    }
  }
});

test('visible cancellation rejection remains functional and update/audit stay tenant-scoped', async () => {
  const db = fixture(), res = response();
  await handler({ method: 'POST', body: { requestId: 'visible', decision: 'reject', notes: 'reviewed' } }, res, { ...auth, db });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.request.status, 'rejected');
  assert.equal(db.mutations.length, 2);
  assert.ok(db.mutations[0].filters.some(([k, v]) => k === 'tenant_id' && v === 'tenant'));
  assert.equal(db.mutations[1].value.tenant_id, 'tenant');
});

test('cancellation boundary excludes non-DD and unproven providers on both canonical records', async () => {
  for (const [planProvider, agreementProvider] of [
    ['stripe', 'stripe'], [null, 'gocardless'], ['gocardless', null],
    ['stripe', 'gocardless'], ['gocardless', 'stripe'],
  ]) {
    for (const decision of ['approve', 'reject']) {
      const db = fixture({ planProvider, agreementProvider }), res = response();
      await handler({ method: 'POST', body: { requestId: 'visible', decision } }, res, { ...auth, db });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(db.mutations, []);
    }
    const db = fixture({ planProvider, agreementProvider }), res = response();
    await handler({ method: 'GET', query: {} }, res, { ...auth, db });
    assert.deepEqual(res.body.requests, []);
  }
});