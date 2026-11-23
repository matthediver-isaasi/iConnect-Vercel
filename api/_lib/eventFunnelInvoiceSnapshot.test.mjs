import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelInvoiceSnapshots} from './eventFunnelInvoiceSnapshot.js';
import {validRecoverySnapshot,validRecoveryTaxIntent} from './eventInvoiceRecovery.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(mode='per_event',provider='xero') {
  const commercial={accounting:{name:provider,connectionId:id(50),company:'original-company',environment:'production'},
    accountingSettings:{xero_stripe_bank_account_code:'090',xero_invoice_status:'DRAFT',
      quickbooks_event_item_id:'qbo-item',quickbooks_event_tax_code_id:'qbo-tax'}};
  const lines=[['simple',10,4000,3000,1000,0],['complex',20,2500,2000,0,500]].map(
    ([eventKind,n,amountMinor,payableMinor,trainingFundMinor,voucherMinor])=>({
      eventKind,eventId:id(n),nodeId:`node${n}`,ticketId:`ticket${n}`,quantity:1,
      amountMinor,payableMinor,trainingFundMinor,voucherMinor,
      priceSnapshot:{eventTitle:`Event ${n}`,eventReference:`REF-${n}`,ticketName:`Ticket ${n}`,
        unitMinor:amountMinor,unitAmount:amountMinor/100,accountCode:`20${n}`,
        tax:{percentage:20,key:'OUTPUT2',lineAmountType:'Inclusive'},commercial:structuredClone(commercial)},
      registrations:[{id:id(n+1),places:1,grossMinor:amountMinor,payableMinor,trainingFundMinor,voucherMinor,
        row:{attendee_first_name:'Test',attendee_last_name:'Attendee',attendee_email:'attendee@example.test'}}],
    }));
  const order={id:id(1),tenant_id:id(2),state:'confirmed',currency:'GBP',payment_method:'card',payable_minor:5000,
    payment_intent_id:'pi_original',verified_payment:{id:'pi_original',status:'succeeded',amount:5000,
      amountReceived:5000,currency:'GBP',livemode:true,
      capturedCharge:{id:'ch_original',amountMinor:5000,currency:'GBP',livemode:true,paidAt:'2026-11-23T12:00:00Z'}},
    snapshot:{version:1,invoiceMode:mode,paymentMethod:'card',paymentAuthority:{mode:'live'},currency:'GBP',
      invoiceDate:'2026-11-23',purchaseOrderNumber:'PO-123',purchaser:{first_name:'Original',last_name:'Buyer',email:'buyer@example.test'},
      payableMinor:5000,trainingFundMinor:1000,voucherMinor:500,
      invoiceCustomer:{name:'Original customer',email:'customer@example.test',provenance:{kind:'member',id:id(3)}},lines}};
  const allocations=lines.map(line=>({tenant_id:order.tenant_id,order_id:order.id,booking_id:line.registrations[0].id,
    booking_source:line.eventKind==='simple'?'booking':'complex_event_booking',event_id:line.eventId,
    node_id:line.nodeId,ticket_id:line.ticketId,places:1,gross_minor:line.amountMinor,payable_minor:line.payableMinor,
    training_fund_minor:line.trainingFundMinor,voucher_minor:line.voucherMinor}));
  return {order,allocations};
}
test('per-event frozen invoices retain different funding conventions and exact charge shares',()=>{
  const input=fixture(),before=structuredClone(input),jobs=buildFunnelInvoiceSnapshots(input);
  assert.ok(jobs.every(job=>job.status==='pending'));
  assert.ok(jobs.every(job=>validRecoverySnapshot(job.snapshot)||validRecoveryTaxIntent(job.snapshot)));
  assert.equal(jobs.reduce((sum,job)=>sum+job.snapshot.settlement.amount,0),50);
  const simple=jobs.find(job=>job.events[0].eventKind==='simple').snapshot;
  const complex=jobs.find(job=>job.events[0].eventKind==='complex').snapshot;
  assert.equal(simple.invoice.LineItems[0].UnitAmount,30);
  assert.deepEqual(complex.invoice.LineItems.map(line=>line.UnitAmount),[25,-5]);
  assert.equal(simple.invoice.Reference,'PO-123');
  assert.equal(simple.invoice.Date,'2026-11-23');
  assert.equal(simple.invoice.DueDate,'2026-12-23');
  assert.match(simple.invoice.LineItems[0].Description,/Original Buyer/);
  assert.equal(simple.provider.xeroTenantId,'original-company');
  assert.deepEqual(input,before);
});
test('consolidation retains all booking links and never repeats the full settlement',()=>{
  const [job]=buildFunnelInvoiceSnapshots(fixture('consolidated'));
  assert.equal(job.status,'pending');
  assert.equal(job.snapshot.amount,50);
  assert.equal(job.snapshot.settlement.amount,50);
  assert.equal(job.snapshot.eventFunnel.events.length,2);
  assert.equal(job.snapshot.invoice.LineItems.length,3);
  assert.equal(job.snapshot.eventFunnel.lineAllocations.length,3);
  assert.deepEqual(job.snapshot.eventFunnel.lineAllocations.filter(line=>line.bookingId===id(11)).map(line=>line.amountMinor),[3000]);
  assert.deepEqual(job.snapshot.eventFunnel.lineAllocations.filter(line=>line.bookingId===id(21)).map(line=>line.amountMinor),[2500,-500]);
});
test('public PO uses original purchaser and has no card settlement',()=>{
  const input=fixture();input.order.payment_method=input.order.snapshot.paymentMethod='public_invoice_po';
  input.order.snapshot.submissionAccepted=true;input.order.verified_payment=null;
  const jobs=buildFunnelInvoiceSnapshots(input);
  assert.ok(jobs.every(job=>job.status==='pending'&&job.snapshot.settlement===null&&job.snapshot.paymentMethod==='invoice'));
  assert.ok(jobs.every(job=>job.snapshot.contact.name==='Original customer'));
});
test('QuickBooks preserves original company and item mapping rather than using ledger codes as item IDs',()=>{
  const [job]=buildFunnelInvoiceSnapshots(fixture('consolidated','quickbooks'));
  assert.equal(job.status,'pending');
  assert.equal(job.snapshot.approvalProvider.realmId,'original-company');
  assert.equal(job.snapshot.invoice.settings.quickbooks_event_item_id,'qbo-item');
  assert.ok(job.snapshot.invoice.lines.every(line=>line.AccountCode==='__quickbooks_event_item__'));
  assert.equal(job.snapshot.payment.amount,50);
  assert.equal(job.snapshot.linkage.events.length,2);
});
test('missing original dates, charge evidence, customer or accounting authority retains review evidence',()=>{
  for(const mutate of [
    x=>{delete x.order.snapshot.invoiceDate;},
    x=>{delete x.order.verified_payment.capturedCharge;},
    x=>{delete x.order.snapshot.invoiceCustomer.provenance;},
    x=>{x.order.snapshot.lines.forEach(line=>delete line.priceSnapshot.commercial.accounting.company);},
  ]) {
    const input=fixture();mutate(input);
    const jobs=buildFunnelInvoiceSnapshots(input);
    assert.ok(jobs.every(job=>job.status==='needs_review'&&job.snapshot===null));
    assert.equal(jobs.reduce((sum,job)=>sum+job.amountMinor,0),5000);
    assert.equal(input.order.state,'confirmed');
  }
});
