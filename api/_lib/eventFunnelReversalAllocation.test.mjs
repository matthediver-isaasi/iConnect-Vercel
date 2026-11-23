import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateFunnelMinor,funnelReversalLimits,allocateFunnelReversal} from './eventFunnelReversalAllocation.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(mode='consolidated') {
  const lines=[['simple',10,4000,3000,1000,0],['complex',20,2500,2000,0,500]].map(
    ([eventKind,n,amountMinor,payableMinor,trainingFundMinor,voucherMinor])=>({
      eventKind,eventId:id(n),nodeId:`node${n}`,ticketId:`ticket${n}`,amountMinor,payableMinor,trainingFundMinor,voucherMinor,
      registrations:[{id:id(n+1),places:1,grossMinor:amountMinor,payableMinor,trainingFundMinor,voucherMinor}],
    }));
  const order={id:id(1),tenant_id:id(2),state:'confirmed',currency:'GBP',payment_method:'card',payable_minor:5000,
    payment_intent_id:'pi_fixture',verified_payment:{id:'pi_fixture',status:'succeeded',amount:5000,
      amountReceived:5000,currency:'GBP',livemode:true},
    snapshot:{version:1,invoiceMode:mode,invoiceCustomer:{},paymentMethod:'card',currency:'GBP',payableMinor:5000,
      trainingFundMinor:1000,voucherMinor:500,paymentAuthority:{mode:'live'},lines}};
  const allocations=lines.flatMap(line=>line.registrations.map(b=>({
    tenant_id:order.tenant_id,order_id:order.id,booking_source:line.eventKind==='simple'?'booking':'complex_event_booking',
    booking_id:b.id,event_id:line.eventId,node_id:line.nodeId,ticket_id:line.ticketId,places:b.places,
    gross_minor:b.grossMinor,payable_minor:b.payableMinor,training_fund_minor:b.trainingFundMinor,voucher_minor:b.voucherMinor,
  })));
  return {order,allocations,selected:[{source:'booking',id:id(11)}],history:[]};
}
test('a selected event never inherits the full multi-event charge or invoice amount',()=>{
  for(const mode of ['per_event','consolidated']) {
    const f=fixture(mode),result=funnelReversalLimits(f);
    assert.deepEqual(result.limits,{cardMinor:3000,invoiceMinor:3000,trainingFundMinor:1000,voucherMinor:0});
    assert.equal(result.items.length,1);assert.equal(result.items[0].eventId,id(10));
    assert.throws(()=>allocateFunnelReversal(f,{cardMinor:5000,invoiceMinor:3000,trainingFundMinor:1000,voucherMinor:0}),/exceeds/);
  }
});
test('pending and uncertain operations fence amounts exactly like completed refunds',()=>{
  for(const state of ['reserved','processing','retry','needs_review','complete','released']) {
    const f=fixture();
    f.history.push({id:'operation',tenant_id:f.order.tenant_id,order_id:f.order.id,state,
      allocations:[{source:'booking',id:id(11),cardMinor:1000,invoiceMinor:1000,trainingFundMinor:500,voucherMinor:0}]});
    assert.equal(funnelReversalLimits(f).limits.cardMinor,state==='released'?3000:2000);
  }
});
test('scope and immutable financial evidence must be complete',()=>{
  const f=fixture();
  for(const selected of [[{source:'booking',id:id(99)}],[...f.selected,...f.selected]])assert.throws(()=>funnelReversalLimits({...f,selected}));
  const forged=structuredClone(f);forged.allocations[0].payable_minor=5000;
  assert.throws(()=>funnelReversalLimits(forged));
  assert.throws(()=>funnelReversalLimits({...f,history:undefined}),/complete/);
  assert.throws(()=>allocateFunnelReversal(f,{cardMinor:1000}),/explicit/);
  const exhausted={id:'operation',tenant_id:f.order.tenant_id,order_id:f.order.id,state:'complete',
    allocations:[{...f.selected[0],cardMinor:3001,invoiceMinor:0,trainingFundMinor:0,voucherMinor:0}]};
  assert.throws(()=>funnelReversalLimits({...f,history:[exhausted]}),/exceed/);
});
test('penny allocation is deterministic, capped and exact at large safe totals',()=>{
  assert.deepEqual(allocateFunnelMinor(2,[1,1,1]),[1,1,0]);
  assert.deepEqual(allocateFunnelMinor(0,[0,0]),[0,0]);
  const result=allocateFunnelMinor(Number.MAX_SAFE_INTEGER-2,[Number.MAX_SAFE_INTEGER-1,1]);
  assert.equal(result.reduce((a,b)=>a+b,0),Number.MAX_SAFE_INTEGER-2);
  assert.ok(result[0]<=Number.MAX_SAFE_INTEGER-1&&result[1]<=1);
});
test('non-card invoices cannot manufacture a card refund',()=>{
  const f=fixture();f.order.payment_method='public_invoice_po';f.order.snapshot.paymentMethod='public_invoice_po';
  f.order.snapshot.submissionAccepted=true;
  const result=funnelReversalLimits(f);assert.equal(result.limits.cardMinor,0);assert.equal(result.limits.invoiceMinor,3000);
});
