import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverInitialCheckout } from './formInitialCheckoutRecovery.js';

test('unpaid initial DD release requires provider cancellation reread before finalization', async () => {
  const calls=[];
  let status='pending';
  const agreement={id:'agreement',tenant_id:'tenant',member_id:'member',provider:'gocardless',
    environment:'sandbox',status:'payment_setup_required',gocardless_billing_request_id:'BR'};
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name.startsWith('begin_')
    ? {recoveryId:'recovery',quotes:[],agreements:[agreement]} : true};}};
  const gc={getBillingRequest:async()=>({id:'BR',status,metadata:{tenant_id:'tenant',member_id:'member'},links:{}}),
    cancelBillingRequest:async()=>{status='cancelled';}};
  const result=await recoverInitialCheckout({db,tenantId:'tenant',memberId:'member',gcForAgreement:async()=>gc});
  assert.equal(result.released,true);
  assert.equal(calls[1].args.p_receipts[0].status,'canceled');
  assert.equal(calls[1].args.p_receipts[0].id,'BR');
});

test('unknown provider outcome retains fence; authorised payment refuses instead of releasing', async () => {
  for(const authorized of [false,true]) {
    const calls=[];
    const agreement={id:'agreement',tenant_id:'tenant',member_id:'member',provider:'gocardless',
      environment:'sandbox',status:'payment_setup_required',gocardless_billing_request_id:'BR'};
    const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name.startsWith('begin_')
      ? {recoveryId:'recovery',quotes:[],agreements:[agreement]} : false};}};
    const gc={getBillingRequest:async()=>{if(!authorized)throw new Error('network unavailable');
      return {id:'BR',status:'fulfilled',metadata:{tenant_id:'tenant',member_id:'member'},links:{mandate:'mandate'}};}};
    await assert.rejects(recoverInitialCheckout({db,tenantId:'tenant',memberId:'member',gcForAgreement:async()=>gc}),
      e=>e.code===(authorized?'payment_committed':'provider_unavailable'));
    assert.equal(calls.length,authorized?2:1);
    if(authorized) assert.equal(calls[1].args.p_refused,true);
  }
});

test('initial upfront card recovery verifies exact quote identity and saved Stripe mode', async () => {
  const calls=[];
  const quote={id:'quote',tenant_id:'tenant',member_id:'member',organization_id:null,stripe_payment_intent_id:'pi_fixture',
    quote:{stripeEnvironment:'test'}};
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name.startsWith('begin_')
    ? {recoveryId:'recovery',quotes:[quote],agreements:[]} : true};}};
  let status='requires_action';
  const intent=()=>({id:'pi_fixture',livemode:false,status,metadata:{tenant_id:'tenant',member_id:'member',membership_quote_id:'quote'}});
  const stripe={paymentIntents:{retrieve:async()=>intent(),cancel:async()=>{status='canceled';return intent();}}};
  assert.deepEqual(await recoverInitialCheckout({db,tenantId:'tenant',memberId:'member',stripeForQuote:async()=>stripe}),{released:true});
  assert.deepEqual(calls[1].args.p_receipts,[{id:'pi_fixture',status:'canceled',livemode:false}]);
});
