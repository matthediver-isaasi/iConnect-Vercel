import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFunnelIssuedInvoice} from './eventFunnelIssuedInvoice.js';
function fixture(){
  const line={LineItemID:'line',Description:'original booking',Quantity:1,UnitAmount:12,LineAmount:12,TaxAmount:2,TaxType:'OUTPUT2',AccountCode:'200'};
  const invoice={InvoiceID:'invoice',Contact:{ContactID:'original-customer',Name:'Private name'},CurrencyCode:'GBP',
    LineAmountTypes:'Inclusive',Total:12,TotalTax:2,AmountDue:0,LineItems:[line]};
  const row={id:'work',tenant_id:'tenant',order_id:'order',lease_token:'lease',snapshot:{
    invoice:{CurrencyCode:'GBP',LineItems:[line]},
    eventFunnel:{lineAllocations:[{index:0,source:'booking',bookingId:'booking',amountMinor:1200}]},
  }};
  const calls=[],db={rpc:async(name,args)=>{calls.push(args);return {data:true};}};
  return {row,invoice,db,calls};
}
test('issued invoice evidence retains customer identity and tax, not mutable balances or names',async()=>{
  const f=fixture();await recordFunnelIssuedInvoice(f);
  assert.equal(f.calls[0].p_token,'lease');
  assert.deepEqual(f.calls[0].p_evidence.Contact,{ContactID:'original-customer'});
  assert.equal(f.calls[0].p_evidence.AmountDue,undefined);
});
test('failed evidence persistence is retryable without changing invoice authority',async()=>{
  const f=fixture();f.db.rpc=async()=>({data:false});
  await assert.rejects(recordFunnelIssuedInvoice(f),e=>e.retry===true);
});
test('legacy prepared invoices retain delivery without invented line attribution',async()=>{
  const f=fixture();delete f.row.snapshot.eventFunnel.lineAllocations;
  await recordFunnelIssuedInvoice(f);assert.equal(f.calls.length,0);
});
test('accepts the booking reference that invoice creation appends to the first line, and nothing else',async()=>{
  const f=fixture();f.row.order_id='11111111-1111-4111-8111-111111111111';
  f.row.source='event_funnel';f.row.booking_group_reference='event-funnel-invoice:order:simple:event';
  f.invoice.LineItems=[{...f.invoice.LineItems[0],Description:'original booking\nBooking reference: event-funnel-invoice:order:simple:event'}];
  await recordFunnelIssuedInvoice(f);
  assert.equal(f.calls.length,1);
  assert.match(f.calls[0].p_evidence.LineItems[0].Description,/Booking reference/);
  const other=fixture();other.row.order_id='11111111-1111-4111-8111-111111111111';
  other.row.source='event_funnel';other.row.booking_group_reference='event-funnel-invoice:order:simple:event';
  other.invoice.LineItems=[{...other.invoice.LineItems[0],Description:'original booking\nBooking reference: someone-else'}];
  await assert.rejects(recordFunnelIssuedInvoice(other),e=>e.code==='funnel_invoice_lines_changed'&&!e.retry);
  assert.equal(other.calls.length,0);
});
test('accepts the customer order number appended to the first line',async()=>{
  const f=fixture();const order='9ee949f1-2cec-46cc-a22d-5eb967de8aa9';
  Object.assign(f.row,{source:'event_funnel',order_id:order,booking_group_reference:`event-funnel-invoice:${order}:simple:event`});
  f.invoice.LineItems=[{...f.invoice.LineItems[0],Description:`original booking\nBooking reference: ${order}`}];
  await recordFunnelIssuedInvoice(f);assert.equal(f.calls.length,1);
});
