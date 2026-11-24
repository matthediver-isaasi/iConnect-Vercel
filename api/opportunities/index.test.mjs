import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunitiesHandler } from './index.js';
import { salesPrincipalFixture, unifiedContext, salesResponse } from '../_lib/salesPrincipals.fixture.mjs';

function fixture(admin = true, fail = false) {
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: [], orders: [] }; calls.push(call);
    const q = {
      select(columns, options) { call.columns = columns; call.options = options; return q; },
      eq(key, value) { call.filters.push([key,value]); return q; },
      is(key, value) { call.filters.push([key,value]); return q; },
      not(key, operator, value) { call.filters.push([key,operator,value]); return q; },
      or(value) { call.or = value; return q; },
      ilike(key,value) { call.search = [key,value]; return q; },
      order(key,options) { call.orders.push([key,options]); return q; },
      range(from,to) { call.range = [from,to]; return Promise.resolve({data: [], count: 0, error: fail ? Error('lookup failed') : null}); },
      then(resolve) { return Promise.resolve({data: [{opportunity_id:'shared'}],error:null}).then(resolve); },
    }; return q;
  }};
  const handler = createOpportunitiesHandler({
    db, getTenantContext: async () => ({isAuthenticated:true,tenantId:'tenant-a',tenantUserId:'user-a'}),
    hasAdminAccess: async () => admin,
    requireCapability: async () => {},
  });
  const res = { statusCode:null, status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;} };
  return {calls,handler,res};
}
test('active opportunity search filters open stages before pagination with stable ordering', async () => {
  const f=fixture();
  await f.handler({method:'GET',query:{active:'true',search:'Conference',page:'2',pageSize:'25'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q=f.calls.find(c=>c.table==='opportunity');
  assert.match(q.columns,/opportunity_stage!inner/);
  assert.deepEqual(q.filters,[['tenant_id','tenant-a'],['archived_at',null],['active_stage.is_active',true],['active_stage.is_won',false],['active_stage.is_lost',false]]);
  assert.deepEqual(q.search,['name','%Conference%']);
  assert.deepEqual(q.range,[25,49]);
  assert.deepEqual(q.orders.map(v=>v[0]),['updated_at','id']);
  assert.equal(f.res.body.total,0);
});
test('active selector preserves tenant and owner/collaborator scope', async () => {
  const f=fixture(false);
  await f.handler({method:'GET',query:{active:'true'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q=f.calls.find(c=>c.table==='opportunity');
  assert.match(q.or,/owner_id.eq.user-a/);
  assert.match(q.or,/id.in.\(shared\)/);
  const roles=f.calls.find(c=>c.table==='opportunity_collaborator');
  assert.ok(roles.filters.some(([key,value])=>key==='tenant_id'&&value==='tenant-a'));
});
test('archived list is filtered before counting and pagination', async () => {
  const f = fixture(false);
  await f.handler({method:'GET',query:{archived:'true',page:'2'}},f.res);
  assert.equal(f.res.statusCode,200);
  const q = f.calls.find(c => c.table === 'opportunity');
  assert.ok(q.filters.some(f => f[0] === 'archived_at' && f[1] === 'is' && f[2] === null));
  assert.match(q.or,/owner_id.eq.user-a/);
  assert.deepEqual(q.range,[25,49]);
});
test('ordinary opportunity lists retain closed stages; lookup errors are not empty success', async () => {
  const normal=fixture();
  await normal.handler({method:'GET',query:{}},normal.res);
  assert.equal(normal.calls[0].columns,'*');
  const failed=fixture(true,true);
  await failed.handler({method:'GET',query:{active:'true'}},failed.res);
  assert.ok(failed.res.statusCode>=400);
});

test('creation accepts every organisation status with an optional contact, but rejects another tenant', async () => {
  for (const status of ['Live', 'Pending', null]) {
    for (const contactId of [null, 'contact']) {
      let inserted;
      const db = { from(table) {
        const filters = {};
        const q = {
          select() { return q; },
          eq(key, value) { filters[key] = value; return q; },
          insert(row) { inserted = row; return q; },
          async single() { return { data: { id: 'created', ...inserted }, error: null }; },
          async maybeSingle() {
            assert.equal(filters.tenant_id, 'tenant-a');
            return { data: filters.id === 'other-tenant-org' ? null
              : { id: filters.id, application_status: status, organization_id: 'org', is_active: true }, error: null };
          },
        };
        return q;
      } };
      const handler = createOpportunitiesHandler({ db,
        getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'user' }),
        requireCapability: async () => {},
      });
      const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
      const body = { name: 'Sale', organizationId: 'org', stageId: 'stage', contactId };
      await handler({ method: 'POST', body }, res);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.organization_id, 'org');
      assert.equal(res.body.primary_contact_id, contactId);
      inserted = null;
      await handler({ method: 'POST', body: { ...body, organizationId: 'other-tenant-org' } }, res);
      assert.equal(res.statusCode, 404);
      assert.equal(inserted, null);
    }
  }
});

test('default creator and owner remain the authenticated Sales principal for both staff forms and members', async () => {
  for (const context of [unifiedContext, { ...unifiedContext, tenantUserId: 'legacy' },
    { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-user', roleId: 'sales-role' }]) {
    for (const contactId of [null, 'contact']) {
      const db = salesPrincipalFixture(), res = salesResponse();
      const handler = createOpportunitiesHandler({ db, getTenantContext: async () => context,
        hasFeatureAccess: async () => true, hasAdminAccess: async () => false });
      await handler({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage', contactId } }, res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      const kind = context.tenantUserId ? 'tenant_user' : 'member';
      const id = context.tenantUserId || context.memberId;
      assert.equal(res.body.owner_kind, kind);
      assert.equal(res.body.owner_id, id);
      assert.equal(res.body.created_by_id, id);
      assert.equal(res.body.created_by_kind, kind);
      assert.equal(res.body.primary_contact_id, contactId);
      await handler({ method: 'GET', query: { mine: 'true' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].owner.id, id);
      assert.equal(res.body.items[0].primaryContact?.id || null, contactId);
      if (id === 'identity') assert.equal(res.body.items[0].owner.name, 'Unified Admin');
    }
  }
});

test('invalid unified owners and database failures cannot create opportunities', async () => {
  for (const id of ['foreign', 'inactive', 'ordinary', 'absent', 'missing-identity']) {
    const db = salesPrincipalFixture(), res = salesResponse();
    const handler = createOpportunitiesHandler({ db, getTenantContext: async () => unifiedContext,
      requireCapability: async () => {} });
    await handler({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage',
      contactId: 'contact', owner: { kind: 'tenant_user', id } } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'Principal not found in tenant');
    assert.equal(db.rows.opportunity.length, 0);
  }
  for (const table of ['tenant_user', 'tenant_membership', 'tenant_identity']) {
    const db = salesPrincipalFixture(), res = salesResponse();
    db.failures.set(table, new Error('database unavailable'));
    await createOpportunitiesHandler({ db, getTenantContext: async () => unifiedContext,
      requireCapability: async () => {} })({ method: 'POST',
      body: { name: 'Sale', organizationId: 'org', stageId: 'stage' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(db.rows.opportunity.length, 0);
  }
});
