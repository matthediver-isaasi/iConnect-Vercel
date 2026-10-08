import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import handler from './form-alert-response.js';
const token='a'.repeat(43);
test('preserves inherited Node request headers without accepting tenant overrides',async()=>{
  const f=fixture({result:{form_name:'Fixture',answers:[],attachments:[]}});
  const req=new IncomingMessage(null);
  req.method='GET';
  req.headers={...f.req.headers,host:'example.iconn.app'};
  req.query={tenant:'attacker',domain:'attacker.example'};
  req.body={tenant:'attacker'};
  assert.equal({...req}.headers,undefined);
  f.deps.resolveTenantFromRequest=async scoped=>{
    assert.equal(scoped.headers,req.headers);
    assert.equal(scoped.headers.host,'example.iconn.app');
    assert.deepEqual(scoped.query,{});
    assert.deepEqual(scoped.body,{});
    return {id:'tenant'};
  };
  await handler(req,f.res,f.deps);
  assert.equal(f.res.statusCode,200);
  assert.equal(f.res.body.form_name,'Fixture');
});
function fixture(options={}){
  const calls=[];
  const deps={db:{async rpc(name,args){calls.push([name,args]);return {data:options.allowed??true,error:options.rateError||null};}},
    async resolveTenantFromRequest(req){
      assert.deepEqual(req.query,{});assert.deepEqual(req.body,{});
      return options.tenant===false?null:{id:'tenant'};
    },
    async resolveCapability(db,tenant,received){
      assert.equal(tenant,'tenant');assert.equal(received,token);
      if(options.throw)throw new Error('private diagnostics');
      return options.result??null;
    }};
  const headers={};const res={statusCode:200,setHeader(k,v){headers[k]=v;},status(code){res.statusCode=code;return res;},
    json(value){res.body=value;return res;},send(value){res.body=value;return res;}};
  const req={method:'GET',headers:{'x-form-alert-token':token,'x-forwarded-for':'192.0.2.1'},
    query:{tenant:'attacker'},body:{tenant:'attacker'}};
  return {req,res,deps,calls,headers};
}
test('public capability endpoint is GET-only, no-store, rate-limited and fail-closed',async()=>{
  for(const [options,method,status] of [[{},'POST',405],[{allowed:false},'GET',429],
    [{rateError:{message:'private'}},'GET',404],[{tenant:false},'GET',404],[{throw:true},'GET',404],[{},'GET',404]]){
    const f=fixture(options);f.req.method=method;await handler(f.req,f.res,f.deps);
    assert.equal(f.res.statusCode,status);
    assert.equal(f.headers['Cache-Control'],'private, no-store');
    assert.equal(f.headers['Referrer-Policy'],'no-referrer');
    assert.ok(!JSON.stringify(f.res.body).includes('private'));
    for(const [name,args] of f.calls){assert.equal(name,'limit_form_alert_reads');assert.match(args.p_key,/^[a-f0-9]{64}$/);}
  }
});
test('successful API output uses an explicit allowlist, not internal capability/storage data',async()=>{
  const f=fixture({result:{form_name:'Form',submitted_at:'2026-01-01',anonymous:false,
    answers:[{label:'Question',value:'Answer'}],attachments:[{path:'private/path'}],secret:'excluded'}});
  await handler(f.req,f.res,f.deps);
  assert.deepEqual(f.res.body,{form_name:'Form',submitted_at:'2026-01-01',anonymous:false,
    answers:[{label:'Question',value:'Answer'}]});
});
test('attachments require a revalidated capability and an allowlisted attachment index',async()=>{
  for(const [index,anonymous] of [['../secret',false],['5',false],['0',true]]){
    const f=fixture({result:{anonymous,attachments:[{path:'tenant/form-submissions/submission/file',bucket:'private-uploads',name:'file'}]}});
    f.req.query.attachment=index;
    await handler(f.req,f.res,f.deps);assert.equal(f.res.statusCode,404);
  }
  const f=fixture({result:{anonymous:false,attachments:[{path:'tenant/form-submissions/submission/file',bucket:'private-uploads',name:'file'}]}});
  f.req.query.attachment='0';
  f.deps.db.storage={from(bucket){assert.equal(bucket,'private-uploads');return {async download(path){
    assert.equal(path,'tenant/form-submissions/submission/file');return {data:new Blob(['safe fixture']),error:null};
  }};}};
  await handler(f.req,f.res,f.deps);
  assert.equal(f.res.statusCode,200);assert.equal(f.res.body.toString(),'safe fixture');
  assert.match(f.headers['Content-Disposition'],/^attachment;/);
  assert.equal(f.headers['Content-Type'],'application/octet-stream');
});
