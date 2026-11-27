import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnelOwnedInvoicesHandler} from './eventFunnelOwnedInvoices.js';
import {createFunnelGuestCapability} from './eventFunnelJourneyHandler.js';
const id='00000000-0000-4000-8000-000000000001',order='00000000-0000-4000-8000-000000000002',
  invoice='00000000-0000-4000-8000-000000000003',tenant='00000000-0000-4000-8000-000000000004';
function fixture({error=null,limited=false}={}) {
  const cap=createFunnelGuestCapability(id),calls=[];
  const handler=createFunnelOwnedInvoicesHandler({resolveTenant:async()=>({id:tenant}),loadViewer:async()=>null,
    db:{rpc:async(name,args)=>{
      if(name==='event_funnel_consume_limit')return {data:!limited};
      calls.push(args);
      assert.equal(name,'event_funnel_owned_invoices');assert.equal(args.p_capability_hash,cap.hash);
      if(error)return {error:{code:error}};
      return {data:args.p_invoice?{invoiceId:'private-provider-id',invoiceNumber:'INV1'}:{state:'pending',invoices:[]}};
    }},fetchPdf:async({link})=>{assert.equal(link.invoiceId,'private-provider-id');calls.push('pdf');return Buffer.from('%PDF fixture');}});
  return {calls,invoke:async(body={action:'list',sessionId:id,orderId:order},headers={},method='POST')=>{
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},
      json(v){this.body=v;return this;},send(v){this.body=v;return this;}};
    await handler({method,body,headers:{host:'example.test','content-type':'application/json',
      cookie:cap.cookie.split(';')[0],...headers}},res);return res;
  }};
}
test('guest list and PDF require original HttpOnly capability and never return it or provider identity',async()=>{
  const f=fixture(),list=await f.invoke();assert.equal(list.code,200);
  assert.deepEqual(list.body,{state:'pending',invoiceMode:undefined,invoices:[],email:null});
  assert.equal(f.calls[0].p_member,null);assert.equal(f.calls[0].p_tenant,tenant);
  const pdf=await f.invoke({action:'download',sessionId:id,orderId:order,invoiceId:invoice});
  assert.equal(pdf.code,200);assert.equal(pdf.headers['Content-Type'],'application/pdf');
  assert.equal(pdf.headers['Cache-Control'],'private, no-store');assert.equal(f.calls.at(-1),'pdf');
});
test('forged authority, missing cookies, cross-origin requests and GET cannot reach invoice reads',async()=>{
  for(const [body,headers,method] of [
    [{action:'list',sessionId:id,orderId:order,memberId:id},{},'POST'],
    [undefined,{cookie:''},'POST'],[undefined,{origin:'https://other.test'},'POST'],
    [undefined,{},'GET'],
  ]) {
    const f=fixture(),result=await f.invoke(body,headers,method);
    assert.ok(result.code>=400);assert.equal(f.calls.length,0);
  }
});
test('ownership failures, expiry and rate limits never fetch the PDF',async()=>{
  for(const [code,status] of [['PT404',404],['PT409',409],['42501',503]]) {
    const f=fixture({error:code});
    const result=await f.invoke({action:'download',sessionId:id,orderId:order,invoiceId:invoice});
    assert.equal(result.code,status);assert.equal(f.calls.includes('pdf'),false);
  }
  const limited=fixture({limited:true});assert.equal((await limited.invoke()).code,429);
  assert.equal(limited.calls.length,0);
});
