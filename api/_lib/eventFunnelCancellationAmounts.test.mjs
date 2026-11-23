import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelCancellationAmounts as build} from './eventFunnelCancellationAmounts.js';
const a='10000000-0000-0000-0000-000000000001',b='10000000-0000-0000-0000-000000000002';
function fixture(){
  return {order:{id:'order',tenant_id:'tenant',state:'confirmed',payment_method:'card'},
    booking:{booking_source:'booking',booking_id:'booking',order_id:'order',tenant_id:'tenant',
      payable_minor:1000,training_fund_minor:200,voucher_minor:300},
    history:[],operationId:'operation',invoiceRequired:true,
    voucherContributions:[{voucherId:a,amountMinor:100},{voucherId:b,amountMinor:200}]};
}
test('default refunds use only original per-registration amounts',()=>{
  const f=fixture(),result=build(f);
  assert.deepEqual(result,{source:'booking',id:'booking',cardMinor:1000,invoiceMinor:1000,
    trainingFundMinor:200,voucherMinor:300,voucherAmounts:{[a]:100,[b]:200}});
  f.order.payment_method='account';assert.equal(build(f).cardMinor,0);
  f.invoiceRequired=false;assert.equal(build(f).invoiceMinor,0);
});
test('partial and zero selections retain the exact chosen original voucher',()=>{
  const f=fixture();f.refundAllocation={vouchers:{[a]:0,[b]:0.5},stripeAmount:2,trainingFundAmount:0,invoiceAmount:1};
  const result=build(f);
  assert.equal(result.cardMinor,200);assert.equal(result.invoiceMinor,100);assert.equal(result.trainingFundMinor,0);
  assert.deepEqual(result.voucherAmounts,{[a]:0,[b]:50});assert.equal(result.voucherMinor,50);
});
test('reserved history consumes remaining amounts even before provider completion',()=>{
  const f=fixture();f.history=[{id:'older',tenant_id:'tenant',order_id:'order',state:'processing',
    allocations:[{source:'booking',id:'booking',cardMinor:400,invoiceMinor:300,trainingFundMinor:100,voucherMinor:50}],
    voucher_plan:[{source:'booking',bookingId:'booking',voucherId:b,amountMinor:50}]}];
  const result=build(f);assert.equal(result.cardMinor,600);assert.deepEqual(result.voucherAmounts,{[a]:100,[b]:150});
});
test('replays retain original approved amounts instead of recomputing a larger refund',()=>{
  const f=fixture();f.refundAllocation={vouchers:{[a]:0,[b]:0.5},stripeAmount:2,invoiceAmount:1,trainingFundAmount:0};
  const prior=build(f);
  f.history=[{id:'operation',tenant_id:'tenant',order_id:'order',state:'retry',allocations:[prior],
    voucher_plan:[{source:'booking',bookingId:'booking',voucherId:b,amountMinor:50}]}];
  f.refundAllocation={};assert.deepEqual(build(f),prior);
  f.refundAllocation={vouchers:{[a]:0.5,[b]:0}};
  assert.throws(()=>build(f),/voucher choices/);
});
test('over-refunds, malformed money and foreign vouchers fail closed',()=>{
  for(const allocation of [{stripeAmount:10.01},{invoiceAmount:11},{trainingFundAmount:-1},
    {stripeAmount:'2oops'},{stripeAmount:1.001},{vouchers:{[a]:2}},{vouchers:{foreign:0}},{vouchers:{[a]:null}}]){
    const f=fixture();f.refundAllocation=allocation;assert.throws(()=>build(f));
  }
});
test('missing original attribution or foreign history cannot invent a refund',()=>{
  const f=fixture();f.voucherContributions=[];assert.throws(()=>build(f),/contributions/);
  const other=fixture();other.history=[{id:'other',tenant_id:'foreign',order_id:'order',allocations:[]}];
  assert.throws(()=>build(other),/history/);
});
