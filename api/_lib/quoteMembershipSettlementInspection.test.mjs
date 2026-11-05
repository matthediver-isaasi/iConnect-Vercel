import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectQuoteMembershipSettlement } from './quoteMembershipSettlementInspection.js';
const history = { id:'h',tenant_id:'t',member_id:'m',payment_status:'paid',status:'active',stripe_payment_intent_id:'pi_test',
  membership_payment_quote_id:'q',total_with_vat:156,currency:'GBP',accounting_invoice_id:'i',accounting_invoice_number:'INV-1' };
const pi = { id:'pi_test',status:'succeeded',livemode:true,amount_received:15600,currency:'gbp',
  metadata:{source:'form-membership-payment',tenant_id:'t',member_id:'m',membership_quote_id:'q'} };
function fixture({payment=true,balance=0,company='company',intent=pi,exists=true}={}) {
  const row={provider:'xero',company_id:'company',invoice_result:{id:'i'},payment_result:{id:'p'}};
  const filters=[];
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},async maybeSingle(){return{data:exists?row:null};}};
  return {args:{db:{from(name){assert.equal(name,'accounting_request_queue');return q;}},tenantId:'t',recordId:'h',table:'member_membership_history'},
    deps:{assertSource:async()=>history,retrieve:async()=>({paymentIntent:intent}),loadToken:async()=>({tenantId:company}),
      getProvider:()=>({fetchInvoiceStatus:async()=>({balance,voided:false,raw:{InvoiceID:'i',CurrencyCode:'GBP',Payments:payment?[{PaymentID:'p',Amount:156}]:[]}})})},filters};
}
test('inspects verified quote purchase without a form or writes',async()=>{
  const f=fixture(); const result=await inspectQuoteMembershipSettlement(f.args,f.deps);
  assert.equal(result.settlement_state,'done');assert.equal(result.read_only,true);
  assert.ok(f.filters.some(([k,v])=>k==='tenant_id'&&v==='t'));
});
test('zero balance alone is not evidence of this Stripe payment',async()=>{
  const f=fixture({payment:false});const r=await inspectQuoteMembershipSettlement(f.args,f.deps);
  assert.equal(r.payment_recorded,false);assert.equal(r.settlement_state,'review_required');
});
test('partial balance requires review',async()=>{
  const f=fixture({balance:20});assert.equal((await inspectQuoteMembershipSettlement(f.args,f.deps)).settlement_state,'review_required');
});
test('company changes and Stripe ownership mismatches fail closed',async()=>{
  for(const options of [{company:'other'},{intent:{...pi,metadata:{...pi.metadata,member_id:'other'}}}]){
    const f=fixture(options);await assert.rejects(inspectQuoteMembershipSettlement(f.args,f.deps));
  }
});
test('unmanaged purchases are not silently assigned a settlement flow',async()=>{
  const f=fixture({exists:false});assert.equal(await inspectQuoteMembershipSettlement(f.args,f.deps),null);
});
