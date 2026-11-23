import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelCardReversal} from './eventFunnelCardReversal.js';
function fixture() {
  const events=[],operation={id:'op',tenantId:'tenant',orderId:'order',paymentIntentId:'pi',chargeId:'ch',
    authority:{accountFingerprint:'original',mode:'live'},state:'reserved',amountMinor:200,chargeAmountMinor:500,
    currency:'GBP',knownRefunds:[]};
  const refund={id:'re',charge:'ch',payment_intent:'pi',amount:200,currency:'gbp',status:'succeeded',
    metadata:{event_funnel_reversal:'op'}};
  const charge={id:'ch',payment_intent:'pi',amount:500,amount_refunded:0,currency:'gbp',livemode:true,paid:true,captured:true};
  const listing={complete:true,refunds:[]};
  const provider={authority:async()=>operation.authority,retrieveCharge:async()=>charge,listAllRefunds:async()=>listing,
    createRefund:async(body,options)=>{events.push(['post',body,options]);return refund;}};
  const store={begin:async()=>{events.push(['begin']);return true;},complete:async()=>{events.push(['complete']);}};
  return {operation,provider,store,events,refund,charge,listing};
}
test('a durable barrier precedes an exact allocation refund',async()=>{
  const f=fixture();assert.equal((await recoverFunnelCardReversal(f)).status,'complete');
  assert.deepEqual(f.events.map(e=>e[0]),['begin','post','complete']);
  assert.equal(f.events[1][1].amount,200);assert.equal(f.events[1][2].idempotencyKey,'event-funnel-reversal:op');
});
test('lost responses reconcile without issuing another refund',async()=>{
  const f=fixture();f.operation.state='writing';f.listing.refunds=[f.refund];f.charge.amount_refunded=200;
  assert.equal((await recoverFunnelCardReversal(f)).status,'complete');assert.deepEqual(f.events,[['complete']]);
  f.listing.refunds=[];f.charge.amount_refunded=0;f.events.length=0;
  assert.equal((await recoverFunnelCardReversal(f)).reason,'refund_submission_uncertain');assert.equal(f.events.length,0);
});
test('unknown provider refunds and switched accounts cannot spend another event allocation',async()=>{
  const f=fixture();f.listing.refunds=[{...f.refund,metadata:{}}];f.charge.amount_refunded=200;
  assert.equal((await recoverFunnelCardReversal(f)).reason,'unallocated_provider_refund');
  f.provider.authority=async()=>({accountFingerprint:'different',mode:'live'});
  assert.equal((await recoverFunnelCardReversal(f)).reason,'payment_authority_changed');assert.equal(f.events.length,0);
});
test('incomplete observations and failed write claims do not submit',async()=>{
  const f=fixture();f.listing.complete=false;
  assert.equal((await recoverFunnelCardReversal(f)).reason,'incomplete_refund_listing');
  f.listing.complete=true;f.store.begin=async()=>false;
  assert.equal((await recoverFunnelCardReversal(f)).reason,'write_not_claimed');assert.equal(f.events.length,0);
});
test('uncertain posts never reset their write barrier',async()=>{
  const f=fixture();f.provider.createRefund=async()=>{throw new Error('lost response');};
  assert.equal((await recoverFunnelCardReversal(f)).reason,'refund_submission_uncertain');
  assert.deepEqual(f.events,[['begin']]);
});
