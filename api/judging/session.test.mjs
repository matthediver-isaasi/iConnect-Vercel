import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
const {__setRoleAccessOverlayForTests}=await import('../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const {default:handler}=await import('./session.js');
const {newCredential}=await import('../_lib/assessment/credentials.js');
const token=newCredential();
async function run({allowed=true,error=null,headers={},method='POST',accept=true}={}){
  const calls=[],out={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
  await handler({method,headers:{'content-type':'application/json','x-judging-request':'1',...headers},body:{token,accept}},out,{
    resolveTenant:async()=>({id:'tenant'}),rateLimitSecret:'isolated-fixture-secret',
    supabase:{async rpc(name,args){calls.push({name,args});return name==='assessment_consume_access_limit'?{data:allowed}:
      {error,data:{accepted:accept,expires_at:'2027-01-01T00:00:00Z'}};}},
  });
  return{out,calls};
}
test('external exchange hashes credentials and issues only a restricted cookie',async()=>{
  const {out,calls}=await run();
  assert.equal(out.statusCode,200);
  assert.match(out.headers['Set-Cookie'],/^__Host-iconnect-judging=/);
  assert.equal(out.body.csrfToken.length,43);
  assert.equal(JSON.stringify(calls).includes(token),false);
  assert.equal(calls[1].args.p_tenant,'tenant');
});
test('rate limits and cross-site requests fail before redemption',async()=>{
  const limited=await run({allowed:false});assert.equal(limited.out.statusCode,429);assert.equal(limited.calls.length,1);
  const cross=await run({headers:{'sec-fetch-site':'cross-site'}});assert.equal(cross.out.statusCode,403);assert.equal(cross.calls.length,0);
});
test('decline and invalid invitations never establish sessions',async()=>{
  const declined=await run({accept:false});assert.equal(declined.out.headers['Set-Cookie'],undefined);
  const rejected=await run({error:{code:'42501'}});assert.equal(rejected.out.statusCode,403);assert.equal(rejected.out.headers['Set-Cookie'],undefined);
});
test('logout revokes the restricted session before clearing its cookie',async()=>{
  const csrf=newCredential();
  const headers={cookie:`__Host-iconnect-judging=${token}`,'x-judging-csrf':csrf};
  const {out,calls}=await run({method:'DELETE',headers});
  assert.equal(out.statusCode,200);
  assert.equal(calls[0].name,'assessment_session_logout');
  assert.equal(calls[0].args.p_session_hash.length,64);
  assert.equal(JSON.stringify(calls).includes(csrf),false);
  assert.match(out.headers['Set-Cookie'],/Max-Age=0/);
  const failed=await run({method:'DELETE',headers,error:{code:'42501'}});
  assert.equal(failed.out.statusCode,403);
  assert.equal(failed.out.headers['Set-Cookie'],undefined);
  const missing=await run({method:'DELETE'});
  assert.equal(missing.out.statusCode,403);
  assert.equal(missing.calls.length,0);
});
