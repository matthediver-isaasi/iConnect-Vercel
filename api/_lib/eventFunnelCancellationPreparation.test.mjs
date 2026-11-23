import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFunnelCancellation} from './eventFunnelCancellationPreparation.js';
function fixture(){
  const calls=[],context={order:{id:'order',tenant_id:'tenant',state:'confirmed',payment_method:'card',currency:'GBP',
    snapshot:{version:1,invoiceMode:'consolidated',paymentMethod:'card',currency:'GBP',
      lines:[{eventKind:'simple',registrations:[{id:'booking',voucherContributions:[]}]}]}},
    allocations:[{order_id:'order',tenant_id:'tenant',booking_source:'booking',booking_id:'booking',
      payable_minor:100,training_fund_minor:0,voucher_minor:0}],history:[]};
  const options={tenantId:'tenant',operationId:'operation',
    requests:[{id:'request',tenant_id:'tenant',booking_id:'booking',status:'pending'}],
    db:{rpc:async(name,args)=>{
      calls.push({name,args});
      return {data:name==='event_funnel_invoice_report'?[{bookingSource:'booking',bookingId:'booking',orderId:'order'}]:context};
    }}};
  return {options,calls,context};
}
test('preparation resolves the original order and does not reserve or refund anything',async()=>{
  const f=fixture(),result=await prepareFunnelCancellation(f.options);
  assert.equal(result.kind,'funnel');assert.equal(result.items[0].cardMinor,100);
  assert.deepEqual(result.requestIds,['request']);
  assert.deepEqual(f.calls.map(c=>c.name),['event_funnel_invoice_report','event_funnel_reversal_context']);
});
test('explicit standalone ownership preserves the legacy path',async()=>{
  const f=fixture();f.options.db.rpc=async()=>({data:[]});
  assert.deepEqual(await prepareFunnelCancellation(f.options),{kind:'legacy'});
});
test('a missing reader cannot bypass an installed funnel financial guard',async()=>{
  const f=fixture();f.options.db.rpc=async name=>name==='event_funnel_invoice_report'?
    {error:{code:'PGRST202'}}:{data:false};
  await assert.rejects(prepareFunnelCancellation(f.options),{code:'FUNNEL_REVERSAL_REQUIRED'});
});
test('foreign requests, mixed orders and corrupted private scope fail before preparation',async()=>{
  const f=fixture();f.options.requests[0].tenant_id='other';
  await assert.rejects(prepareFunnelCancellation(f.options),/scope/);assert.equal(f.calls.length,0);
  f.options.requests[0].tenant_id='tenant';f.context.order.tenant_id='other';
  await assert.rejects(prepareFunnelCancellation(f.options),/authority/);
});
test('amount inputs cannot override private order or purchaser authority',async()=>{
  const f=fixture();f.options.amountsByRequest={request:{order:{id:'forged'}}};
  await assert.rejects(prepareFunnelCancellation(f.options),/choices/);
  f.options.amountsByRequest={request:{refundAllocation:{stripeAmount:0}}};
  const result=await prepareFunnelCancellation(f.options);assert.equal(result.items[0].cardMinor,0);
  assert.equal(result.items[0].invoiceMinor,0);
});
test('pending accounting customer preparation does not block original refund limits',async()=>{
  const f=fixture();assert.equal(f.context.order.snapshot.invoiceCustomer,undefined);
  const result=await prepareFunnelCancellation(f.options);assert.equal(result.items[0].invoiceMinor,100);
  f.context.order.snapshot.version=2;
  await assert.rejects(prepareFunnelCancellation(f.options),/policy/);
});
