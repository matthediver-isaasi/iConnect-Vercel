import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFunnelCheckoutHandler } from './eventFunnelCheckoutHandler.js';
import { createFunnelGuestCapability } from './eventFunnelJourneyHandler.js';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const calls=[],id=uuid(3),order={id:uuid(4),state:'payable',payment_method:'card',currency:'GBP',payable_minor:500,
    snapshot:{invoiceMode:'per_event',privateBinding:'must-not-leak'}};
  const options={db:{rpc:async name=>({data:name==='event_funnel_consume_limit'?true:{version:1,purchasing:false}})},
    resolveTenant:async()=>({id:uuid(1)}),loadViewer:async()=>({tenantId:uuid(1),memberId:uuid(2)}),
    checkout:{readOrder:async()=>null,summary:async()=>({payableMinor:500}),prepare:async()=>order},
    paymentFor:async()=>({store:{readOwned:async(owner,orderId)=>{
      calls.push(owner);
      if(orderId!==order.id) throw new FunnelJourneyError('Not found','ORDER_NOT_FOUND',404);
      return order;
    }},service:{
      ensurePayment:async()=>{calls.push('payment');return {state:'requires_payment_method',clientSecret:'fixture-client-secret',publishableKey:'fixture-public-key',private:'must-not-leak'};},
      reconcile:async()=>{calls.push('reconcile');return {state:'confirmed',private:'must-not-leak'};},
      cancel:async()=>({state:'cancelled'}),
    }})};
  const invoke=async(body={action:'status',sessionId:id,orderId:order.id},headers={})=>{
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
    await createEventFunnelCheckoutHandler(options)({method:'POST',headers:{host:'fixture.test',origin:'https://fixture.test',
      'content-type':'application/json',...headers},body},res);
    return res;
  };
  return {options,calls,order,id,invoke};
}
test('new checkout remains gated while existing owned orders can recover',async()=>{
  const f=fixture();
  assert.equal((await f.invoke({action:'prepare',sessionId:f.id,command:{expectedPayableMinor:500}})).code,409);
  const result=await f.invoke();assert.equal(result.code,200);assert.equal(result.body.state,'confirmed');
  assert.ok(!JSON.stringify(result.body).includes('must-not-leak'));
  assert.equal(result.headers['Cache-Control'],'private, no-store, max-age=0');
  f.options.checkout.readOrder=async()=>f.order;
  const prepared=await f.invoke({action:'prepare',sessionId:f.id,command:{expectedPayableMinor:500}});
  assert.equal(prepared.code,200);assert.ok(!JSON.stringify(prepared.body).includes('must-not-leak'));
});
test('guest capability identity is retained even after login and forged orders cannot reach payment',async()=>{
  const f=fixture(),cap=createFunnelGuestCapability(f.id);
  const payment=await f.invoke({action:'payment',sessionId:f.id,orderId:f.order.id},{cookie:cap.cookie.split(';')[0]});
  assert.equal(payment.code,200);assert.equal(f.calls[0].memberId,null);assert.equal(f.calls[0].capabilityHash,cap.hash);
  assert.equal(payment.body.clientSecret,'fixture-client-secret');
  f.calls.length=0;
  assert.equal((await f.invoke({action:'payment',sessionId:f.id,orderId:uuid(99)})).code,404);
  assert.ok(!f.calls.includes('payment'));
});
test('cross-site requests and forged financial authority cannot invoke a payment adapter',async()=>{
  const f=fixture();
  assert.equal((await f.invoke(undefined,{origin:'https://other.test'})).code,403);
  assert.equal((await f.invoke({action:'status',sessionId:f.id,orderId:f.order.id,tenantId:uuid(99)})).code,400);
  assert.deepEqual(f.calls,[]);
});
