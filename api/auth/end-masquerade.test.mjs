import test from 'node:test';
import assert from 'node:assert/strict';
import { createEndMasqueradeHandler } from './end-masquerade.js';
import { getSessionTenantUser, isolateMasqueradeSession } from '../_lib/session.js';

const saved = { id: 'masquerade', data: {
  isMasquerading: true, memberId: 'viewed-member', tenantId: 'tenant',
  identityId: 'viewed-identity', masqueradeAdminTenantId: 'tenant',
  masqueradeAdminTenantUserId: 'original-identity',
  masqueradeAdminIdentityId: 'original-identity',
  // Older promoted sessions captured the pre-promotion type.
  masqueradeAdminUserType: 'member', masqueradeReturnUrl: '/members?tab=all',
} };
async function run({ session = saved, user = { id: 'original-identity',
  tenant_id: 'tenant', status: 'active', _isUnifiedIdentity: true }, failure,
  member = null, issue = true } = {}) {
  const issued = [], verified = [];
  const db = { from(table) {
    assert.equal(table, 'member'); const filters = [];
    const q = { select(){return q;}, eq(k,v){filters.push([k,v]);return q;},
      async maybeSingle(){return {data:member,error:null};},
      async single(){return {data:member,error:null};} };
    return q;
  } };
  const handler = createEndMasqueradeHandler({ db, readSession: async()=>session,
    readTenantUser: async(req,candidate)=>{verified.push(candidate);if(failure)throw new Error('unavailable');return user;},
    issueSession: async(res,data,options)=>{issued.push({data,options});return issue ? {id:'restored'} : null;} });
  const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},
    status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;},end(){return this;}};
  await handler({method:'POST',headers:{}},res);
  return {res,issued,verified};
}
test('unified admin without a legacy account or linked member can return',async()=>{
  const {res,issued,verified}=await run();
  assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
  assert.equal(res.body.returnUrl,'/members?tab=all');
  assert.equal(verified[0].data.identityId,'original-identity');
  assert.equal(verified[0].data.memberId,undefined);
  assert.equal(verified[0].data.isMasquerading,undefined);
  assert.equal(issued[0].data.memberId,null);
  assert.equal(issued[0].data.isMasquerading,undefined);
  assert.equal(issued[0].data.tenantUserId,'original-identity');
  assert.equal(issued[0].options.replaceSessionId,'masquerade');
});
test('legacy administrators and linked members remain supported',async()=>{
  const {res,issued}=await run({user:{id:'legacy',tenant_id:'tenant',status:'active'},
    member:{id:'original-member',role_id:'role'}});
  assert.equal(res.statusCode,200);assert.equal(issued[0].data.memberId,'original-member');
});
test('missing, revoked, cross-tenant and unavailable admins never issue a session',async()=>{
  for(const options of [{session:null},{session:{data:{}}},{user:null},
    {user:{tenant_id:'other',status:'active'}},{user:{tenant_id:'tenant',status:'inactive'}},{failure:true}]){
    const {res,issued}=await run(options);assert.ok(res.statusCode>=400);assert.equal(issued.length,0);
  }
});
test('member-role administrators restore their own member identity only',async()=>{
  const session={...saved,data:{...saved.data,masqueradeAdminTenantUserId:null,masqueradeAdminMemberId:'original-member'}};
  const {res,issued,verified}=await run({session,member:{id:'original-member',tenant_id:'tenant',login_enabled:true}});
  assert.equal(res.statusCode,200);assert.equal(verified.length,0);
  assert.equal(issued[0].data.memberId,'original-member');
  assert.equal(issued[0].data.userType,'member');
  const disabled=await run({session,member:{id:'original-member',login_enabled:false}});
  assert.equal(disabled.res.statusCode,403);assert.equal(disabled.issued.length,0);
});
test('failed issuance is not success and external return targets are rejected',async()=>{
  assert.equal((await run({issue:false})).res.statusCode,500);
  assert.equal((await run({session:{...saved,data:{...saved.data,masqueradeReturnUrl:'https://example.test'}}})).res.body.returnUrl,'/members');
});
test('masquerading cannot resolve team authority, even from already elevated sessions',async()=>{
  for(const userType of ['member','tenant_user']){
    assert.equal(await getSessionTenantUser({}, {id:'test',data:{
      isMasquerading:true,userType,tenantUserId:'team',identityId:'identity',
      preservedTenantUserId:'team',tenantId:'tenant',
    }}),null);
  }
});
test('old elevated masquerade sessions are restricted without losing return provenance',()=>{
  const original={...saved.data,userType:'tenant_user',tenantUserId:'viewed-team',
    preservedTenantUserId:'viewed-team',promotedFromMember:true};
  const data=isolateMasqueradeSession(original);
  assert.equal(data.userType,'member');assert.equal(data.tenantUserId,undefined);
  assert.equal(data.preservedTenantUserId,undefined);assert.equal(data.promotedFromMember,undefined);
  assert.equal(data.masqueradeAdminTenantUserId,'original-identity');
  assert.equal(data.memberId,'viewed-member');assert.equal(original.userType,'tenant_user');
});
