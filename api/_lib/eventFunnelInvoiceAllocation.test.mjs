import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelInvoiceAllocations} from './eventFunnelInvoiceAllocation.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(mode='per_event') {
  const lines=[['simple',10,4000,3000,1000,0],['complex',20,2500,2000,0,500]].map(
    ([eventKind,n,amountMinor,payableMinor,trainingFundMinor,voucherMinor])=>({
      eventKind,eventId:id(n),nodeId:`node${n}`,ticketId:`ticket${n}`,
      amountMinor,payableMinor,trainingFundMinor,voucherMinor,priceSnapshot:{tax:{percentage:20}},
      registrations:[{id:id(n+1),places:1,grossMinor:amountMinor,payableMinor,trainingFundMinor,voucherMinor}],
    }));
  const order={id:id(1),tenant_id:id(2),state:'confirmed',currency:'gbp',payment_method:'card',payable_minor:5000,
    payment_intent_id:'pi_fixture',verified_payment:{id:'pi_fixture',status:'succeeded',amount:5000,
      amountReceived:5000,currency:'gbp',livemode:false},
    snapshot:{version:1,invoiceMode:mode,paymentMethod:'card',paymentAuthority:{mode:'test'},currency:'GBP',
      payableMinor:5000,trainingFundMinor:1000,voucherMinor:500,invoiceCustomer:{name:'Fixture buyer'},lines}};
  const allocations=lines.map(line=>({tenant_id:order.tenant_id,order_id:order.id,booking_id:line.registrations[0].id,
    booking_source:line.eventKind==='simple'?'booking':'complex_event_booking',event_id:line.eventId,
    node_id:line.nodeId,ticket_id:line.ticketId,places:1,gross_minor:line.amountMinor,
    payable_minor:line.payableMinor,training_fund_minor:line.trainingFundMinor,voucher_minor:line.voucherMinor}));
  return {order,allocations};
}
test('per-event invoices allocate one charge rather than repeatedly settling its full amount',()=>{
  const input=fixture(),before=structuredClone(input),jobs=buildFunnelInvoiceAllocations(input);
  assert.deepEqual(jobs.map(row=>row.amountMinor).sort(),[2000,3000]);
  assert.equal(jobs.reduce((sum,row)=>sum+row.settlement.amountMinor,0),5000);
  assert.ok(jobs.every(row=>row.settlement.chargeAmountMinor===5000&&row.settlement.kind==='event_funnel_allocation'));
  assert.notEqual(jobs[0].key,jobs[1].key);assert.deepEqual(input,before);
  assert.deepEqual(buildFunnelInvoiceAllocations(input),jobs);
});
test('consolidated invoices preserve both event and booking links with exact funding evidence',()=>{
  const [job]=buildFunnelInvoiceAllocations(fixture('consolidated'));
  assert.equal(job.amountMinor,5000);assert.equal(job.events.length,2);
  assert.equal(job.settlement.allocations.reduce((sum,row)=>sum+row.amountMinor,0),5000);
  assert.equal(job.events.flatMap(row=>row.bookingIds).length,2);
});
test('invoice acceptance has no card settlement and does not invent provider payment evidence',()=>{
  const input=fixture();input.order.payment_method=input.order.snapshot.paymentMethod='account';
  input.order.snapshot.submissionAccepted=true;input.order.verified_payment=null;input.order.payment_intent_id=null;
  assert.ok(buildFunnelInvoiceAllocations(input).every(row=>row.settlement===null));
});
test('same-event add-ons join one event invoice rather than create duplicate settlements',()=>{
  const input=fixture(),line=input.order.snapshot.lines[1];
  line.eventKind='simple';line.eventId=id(10);
  input.allocations[1].booking_source='booking';input.allocations[1].event_id=id(10);
  const jobs=buildFunnelInvoiceAllocations(input);
  assert.equal(jobs.length,1);assert.equal(jobs[0].events[0].registrationLines.length,2);
  assert.equal(jobs[0].settlement.amountMinor,5000);
});
test('fully funded purchases retain traceable event evidence without creating payable invoices',()=>{
  const input=fixture(),{order,allocations}=input;
  order.payment_method=order.snapshot.paymentMethod='free';order.snapshot.submissionAccepted=true;
  order.payable_minor=order.snapshot.payableMinor=0;
  order.snapshot.trainingFundMinor=4000;order.snapshot.voucherMinor=2500;
  order.payment_intent_id=order.verified_payment=null;
  for(const [i,line] of order.snapshot.lines.entries()) {
    const funding=i===0?'trainingFundMinor':'voucherMinor';
    line[funding]=line.amountMinor;line.payableMinor=0;
    line.registrations[0][funding]=line.amountMinor;line.registrations[0].payableMinor=0;
    allocations[i][i===0?'training_fund_minor':'voucher_minor']=line.amountMinor;allocations[i].payable_minor=0;
  }
  const jobs=buildFunnelInvoiceAllocations(input);
  assert.ok(jobs.every(row=>!row.applicable&&row.settlement===null));
  assert.equal(jobs.flatMap(row=>row.events.flatMap(event=>event.bookingIds)).length,2);
});
test('corrupt, duplicate, foreign, missing or unconfirmed allocation evidence fails closed',()=>{
  for(const alter of [
    x=>{x.order.state='payable';},x=>{x.order.verified_payment.amountReceived=4999;},
    x=>{x.allocations[0].tenant_id=id(99);},x=>{x.allocations[0].payable_minor=5000;},
    x=>{x.allocations.push(x.allocations[0]);},x=>{x.allocations.pop();},
    x=>{x.order.snapshot.voucherMinor=499;},x=>{x.order.snapshot.lines[0].registrations[0].grossMinor=4001;},
  ]) {const input=fixture();alter(input);assert.throws(()=>buildFunnelInvoiceAllocations(input),{code:'FUNNEL_INVOICE_EVIDENCE_INVALID'});}
});
