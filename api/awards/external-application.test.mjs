import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './external-application.js';
import {credentialHash} from '../_lib/assessment/credentials.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture({data={applications:[{id:id(1)}]},error=null}={}){
  const calls=[],headers={};
  return{calls,req:{method:'GET',query:{applicationId:id(1)},headers:{'x-awards-applicant':'a'.repeat(43),cookie:'sid=ordinary-session'}},
    res:{statusCode:200,setHeader(key,value){headers[key]=value;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}},
    dependencies:{resolveTenant:async()=>({id:id(2)}),getMember:async()=>{throw new Error('No member fallback');},
      supabase:{async rpc(name,args){calls.push({name,args});return{data,error};}}}};
}
test('external applicant reads forward a hash and tenant scope, never an ordinary member identity',async()=>{
  const f=fixture();await handler(f.req,f.res,f.dependencies);
  assert.equal(f.res.statusCode,200);assert.equal(f.calls[0].args.p_tenant,id(2));
  assert.equal(f.calls[0].args.p_member,null);
  assert.equal(f.calls[0].args.p_access_hash,credentialHash(f.req.headers['x-awards-applicant']));
  assert.equal(JSON.stringify(f.res.body).includes('a'.repeat(43)),false);
});
test('missing, expired or revoked grants do not fall back to cookie authentication',async()=>{
  const missing=fixture();delete missing.req.headers['x-awards-applicant'];
  await handler(missing.req,missing.res,missing.dependencies);assert.equal(missing.res.statusCode,403);assert.equal(missing.calls.length,0);
  const revoked=fixture({data:{applications:[]}});
  await handler(revoked.req,revoked.res,revoked.dependencies);assert.equal(revoked.res.statusCode,403);
});
test('external changes require same-origin JSON intent and retain optimistic conflict errors',async()=>{
  const f=fixture();f.req.method='POST';f.req.body={command:'withdraw',applicationId:id(1),version:2,reason:'Withdraw'};
  await handler(f.req,f.res,f.dependencies);assert.equal(f.res.statusCode,403);assert.equal(f.calls.length,0);
  f.req.headers={...f.req.headers,'x-awards-request':'1','content-type':'application/json'};
  f.dependencies.supabase.rpc=async()=>({error:{code:'40001',message:'Application changed'}});
  await handler(f.req,f.res,f.dependencies);assert.equal(f.res.statusCode,409);
});
