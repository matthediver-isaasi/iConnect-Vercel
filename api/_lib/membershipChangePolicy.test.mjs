import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERSHIP_CHANGE_POLICY_DEFAULTS as defaults, validateMembershipChangePolicy, membershipSurplusCreditExpiry, readMembershipChangePolicy } from './membershipChangePolicy.js';
import { createMembershipChangePolicyHandler } from '../admin/membership-change-policy.js';

const tenant = '10000000-0000-4000-8000-000000000001';
function fixture(overrides = {}) {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, 'membership_change_policy');
      return { select() { return this; }, eq(key, value) {
        assert.equal(key, 'tenant_id'); assert.equal(value, tenant); return this;
      }, async maybeSingle() { return { data: null, error: null }; } };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { policy: args.p_policy, revision: 1 }, error: null };
    },
  };
  const handler = createMembershipChangePolicyHandler({
    db, getContext: async () => ({ isAuthenticated: true, tenantId: tenant, tenantUserId: 'operator' }),
    isAdmin: async () => true, ...overrides,
  });
  return { db, calls, async call(method = 'GET', body) {
    const res = { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; },
      status(code) { this.statusCode=code; return this; }, json(data) { this.body=data; return this; } };
    await handler({method,body},res); return res;
  } };
}
test('safe defaults require approval and retained surplus has no expiry', () => {
  assert.deepEqual(validateMembershipChangePolicy(defaults), defaults);
  assert.equal(membershipSurplusCreditExpiry(defaults, '2026-10-26T10:00:00Z'), null);
  assert.equal(membershipSurplusCreditExpiry({...defaults,creditExpiryDays:1}, '2028-02-28T10:00:00Z'), '2028-02-29T10:00:00.000Z');
  assert.equal(membershipSurplusCreditExpiry({...defaults,creditExpiryDays:2}, '2028-02-28T10:00:00Z'), '2028-03-01T10:00:00.000Z');
});
test('policy rejects partial, unknown, coerced and out-of-range values', () => {
  for (const value of [null, [], {}, {...defaults,enable:true}, {...defaults,surplusHandling:null},
    {...defaults,upgradesRequireApproval:'false'}, {...defaults,creditExpiryDays:'90'},
    ...[-1,0,0.5,36501,NaN,Infinity].map(creditExpiryDays=>({...defaults,creditExpiryDays}))]) {
    assert.throws(()=>validateMembershipChangePolicy(value));
  }
  assert.throws(()=>membershipSurplusCreditExpiry(defaults,'bad'));
});
test('GET returns absent-row defaults without enabling execution; PUT scopes tenant and actor', async () => {
  const f=fixture(); const read=await f.call();
  assert.deepEqual(read.body,{policy:defaults,revision:0,executionEnabled:false});
  assert.equal(read.headers['Cache-Control'],'private, no-store');
  const write=await f.call('PUT',{policy:{...defaults,creditExpiryDays:90},expectedRevision:0,tenantId:'forged'});
  assert.equal(write.statusCode,200); assert.equal(write.body.executionEnabled,false);
  assert.equal(f.calls[0].args.p_tenant_id,tenant); assert.equal(f.calls[0].args.p_actor,'tenant_user:operator');
});
test('authentication, tenant mismatch, access and revision checks prevent writes', async () => {
  for(const overrides of [
    {getContext:async()=>null},
    {getContext:async()=>({isAuthenticated:true,tenantId:tenant,tenantMismatch:true})},
    {isAdmin:async()=>false},
    {getContext:async()=>({isAuthenticated:true,tenantId:tenant})},
  ]) {
    const f=fixture(overrides); const r=await f.call('PUT',{policy:defaults,expectedRevision:0});
    assert.ok(r.statusCode>=400); assert.equal(f.calls.length,0);
  }
  const f=fixture();
  for(const expectedRevision of [undefined,-1,'0',0.1]) {
    assert.equal((await f.call('PUT',{policy:defaults,expectedRevision})).statusCode,400);
  }
  assert.equal(f.calls.length,0);
});
test('missing migration errors are not swallowed as default settings; stale saves conflict',async()=>{
  const f=fixture();
  f.db.from=()=>({select(){return this;},eq(){return this;},async maybeSingle(){return {error:{code:'42P01'}};}});
  await assert.rejects(()=>readMembershipChangePolicy(f.db,tenant));
  assert.equal((await f.call()).statusCode,503);
  f.db.rpc=async()=>({error:{code:'40001'}});
  assert.equal((await f.call('PUT',{policy:defaults,expectedRevision:0})).statusCode,409);
});
