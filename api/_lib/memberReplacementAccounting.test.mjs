import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberReplacementAccounting} from './memberReplacementAccounting.js';
const step={kind:'invoice',providerTenantId:'books',contactId:'payer',currency:'GBP',
 reference:'MR:case:new',accountCode:'401',taxCode:'NONE',sourceInvoiceId:'old',issueDate:'2026-10-27',
 amount:{netMinor:7500,vatMinor:0,grossMinor:7500}};
const invoice=()=>({InvoiceID:'new',Type:'ACCREC',Status:'AUTHORISED',Contact:{ContactID:'payer'},
 CurrencyCode:'GBP',Reference:step.reference,SubTotal:75,TotalTax:0,Total:75,
 LineItems:[{AccountCode:'401',TaxType:'NONE'}]});
test('replacement document uses the whole target value and preserves payer without address updates',async()=>{
 let written=false;
 const adapter=createMemberReplacementAccounting({providerTenantId:'books',request:async(path,options)=>{
  if(options){
   written=true;assert.equal(path,'Invoices');
   assert.equal(options.body.Invoices[0].Contact.ContactID,'payer');
   assert.equal(options.body.Invoices[0].Contact.Addresses,undefined);
   assert.equal(options.body.Invoices[0].LineItems[0].UnitAmount,75);
   return {};
  }
  return {Invoices:written?[invoice()]:[]};
 }});
 assert.equal((await adapter.submitReservedStep(step)).id,'new');
});
test('discovery failures and ambiguous/mismatched documents cannot authorize a write',async()=>{
 for(const rows of [undefined,[invoice(),invoice()],[{...invoice(),CurrencyCode:'USD'}]]){
  const adapter=createMemberReplacementAccounting({providerTenantId:'books',request:async(_path,options)=>{
   assert.equal(options,undefined);return {Invoices:rows};
  }});
  await assert.rejects(adapter.submitReservedStep(step));
 }
});
test('existing documents are recovered without a replacement financial write',async()=>{
 const adapter=createMemberReplacementAccounting({providerTenantId:'books',request:async(_path,options)=>{
  assert.equal(options,undefined);return {Invoices:[invoice()]};
 }});
 assert.equal((await adapter.submitReservedStep(step)).state,'observed');
});
test('transfer validates both payer and exact allocation coverage',async()=>{
 const transfer={...step,kind:'allocation',amountMinor:5000,creditStep:'credit',invoiceStep:'invoice'};
 const dependencies={credit:{id:'credit'},invoice:{id:'invoice'}};
 const note={CreditNoteID:'credit',Contact:{ContactID:'payer'},CurrencyCode:'GBP',Status:'PAID',
  RemainingCredit:0,Payments:[],Allocations:[{AllocationID:'allocation',Invoice:{InvoiceID:'invoice'},Amount:50}]};
 const target={InvoiceID:'invoice',Contact:{ContactID:'payer'},CurrencyCode:'GBP',Status:'AUTHORISED',AmountCredited:50};
 const adapter=createMemberReplacementAccounting({providerTenantId:'books',request:async path=>
  path.startsWith('CreditNotes/')?{CreditNotes:[note]}:{Invoices:[target]}});
 assert.equal((await adapter.inspect(transfer,dependencies)).id,'allocation');
 note.Payments.push({PaymentID:'unexpected'});
 await assert.rejects(adapter.inspect(transfer,dependencies));
});
