import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunitiesHandler } from './index.js';

function fixture(admin = true, fail = false) {
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: [], orders: [] }; calls.push(call);
    const q = {
      select(columns, options) { call.columns = columns; call.options = options; return q; },
      eq(key, value) { call.filters.push([key,value]); return q; },
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
  assert.deepEqual(q.filters,[['tenant_id','tenant-a'],['active_stage.is_active',true],['active_stage.is_won',false],['active_stage.is_lost',false]]);
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
test('ordinary opportunity lists retain closed stages; lookup errors are not empty success', async () => {
  const normal=fixture();
  await normal.handler({method:'GET',query:{}},normal.res);
  assert.equal(normal.calls[0].columns,'*');
  const failed=fixture(true,true);
  await failed.handler({method:'GET',query:{active:'true'}},failed.res);
  assert.ok(failed.res.statusCode>=400);
});
