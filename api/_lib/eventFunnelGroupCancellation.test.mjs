import test from 'node:test';
import assert from 'node:assert/strict';
import {splitFunnelRefund,groupFunnelAmountChoices} from './eventFunnelGroupCancellation.js';
const requests=[{id:'b',booking_id:'two'},{id:'a',booking_id:'one'}];
const plan={items:[
  {source:'booking',id:'one',cardMinor:101,invoiceMinor:101,trainingFundMinor:1,voucherAmounts:{v:50}},
  {source:'booking',id:'two',cardMinor:202,invoiceMinor:202,trainingFundMinor:2,voucherAmounts:{v:100}}]};
test('integer group refunds conserve pennies and never exceed original caps',()=>{
  assert.deepEqual(splitFunnelRefund(101,[101,202]),[34,67]);
  assert.deepEqual(splitFunnelRefund(1,[1,1]),[1,0]);
  assert.deepEqual(splitFunnelRefund(0,[0,0]),[0,0]);
  assert.throws(()=>splitFunnelRefund(304,[101,202]));
  for(let total=0;total<=303;total++){
    const parts=splitFunnelRefund(total,[101,202]);
    assert.equal(parts.reduce((a,b)=>a+b),total);assert.ok(parts[0]<=101&&parts[1]<=202);
  }
});
test('group choices use original per-registration shares with stable request ordering',()=>{
  const args={plan,requests,customRefundAmount:'1.01',refundAllocation:{trainingFundAmount:'0.01',vouchers:{v:'0.50'}}};
  const choices=groupFunnelAmountChoices(args);
  assert.equal(choices.a.refundAllocation.stripeAmount,'0.34');
  assert.equal(choices.b.refundAllocation.stripeAmount,'0.67');
  assert.equal(choices.a.refundAllocation.invoiceAmount,'0.34');
  assert.equal(choices.b.refundAllocation.trainingFundAmount,'0.01');
  assert.deepEqual(groupFunnelAmountChoices({...args,requests:[...requests].reverse()}),choices);
});
test('unknown funding, malformed totals and over-refunds fail before approval',()=>{
  for(const refundAllocation of [{vouchers:{foreign:0}},{stripeAmount:-1},{invoiceAmount:'100.00'},
    {trainingFundAmount:true},{vouchers:{v:'0.001'}}])
    assert.throws(()=>groupFunnelAmountChoices({plan,requests,refundAllocation}));
});
