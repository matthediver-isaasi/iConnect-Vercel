import {buildXeroSalesInvoicePayload} from './xero.js';
import {amendmentMinor} from './memberAmendmentFinance.js';
import {inspectMemberCreditBacking,memberCreditBackingPayload} from './memberCreditBacking.js';

const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'replacement_accounting_conflict'});};
/** Internal adapter. The execution journal, not this adapter, authorizes writes. */
export function createMemberReplacementAccounting({request,providerTenantId}){
 async function submit(path,options){
  try{return await request(path,options);}
  catch(error){
   if(error?.status===429&&error?.code==='accounting_rate_limited')error.replacementWriteRejected=true;
   throw error;
  }
 }
 function owned(step){
  if(step.providerTenantId!==providerTenantId)fail('Accounting organisation changed.');
 }
 function verifyDocument(step,document){
  owned(step);
  const invoice=step.kind==='invoice',id=document?.[invoice?'InvoiceID':'CreditNoteID'];
  if(!id||document.Type!==(invoice?'ACCREC':'ACCRECCREDIT')
   ||!['AUTHORISED','PAID'].includes(document.Status)
   ||document.Contact?.ContactID!==step.contactId||document.CurrencyCode!==step.currency
   ||document.Reference!==step.reference||document.LineItems?.length!==1
   ||document.LineItems[0].AccountCode!==step.accountCode||document.LineItems[0].TaxType!==step.taxCode
   ||amendmentMinor(document.SubTotal)!==step.amount.netMinor
   ||amendmentMinor(document.TotalTax)!==step.amount.vatMinor
   ||amendmentMinor(document.Total)!==step.amount.grossMinor)fail('Replacement document differs from its reserved financial plan.');
  return {id,document};
 }
 async function inspectDocument(step){
  owned(step);
  const resource=step.kind==='invoice'?'Invoices':'CreditNotes';
  const where=encodeURIComponent(`Reference==${JSON.stringify(step.reference)}`);
  const rows=(await request(`${resource}?where=${where}&page=1&pageSize=100`))?.[resource];
  if(!Array.isArray(rows)||rows.length>=100||rows.some(d=>d.Reference!==step.reference)){
   fail('Complete accounting document discovery is required.');
  }
  if(!rows.length)return {state:'absent'};
  if(rows.length!==1)fail('More than one accounting document uses this execution reference.');
  return {state:'observed',...verifyDocument(step,rows[0])};
 }
 async function inspectAllocation(step,dependencies){
  owned(step);
  const note=dependencies[step.creditStep],invoice=dependencies[step.invoiceStep];
  if(!note?.id||!invoice?.id)fail('Verified transfer documents are required.');
  const notes=(await request(`CreditNotes/${encodeURIComponent(note.id)}`))?.CreditNotes;
  const invoices=(await request(`Invoices/${encodeURIComponent(invoice.id)}`))?.Invoices;
  if(notes?.length!==1||invoices?.length!==1)fail('Transfer documents are unavailable.');
  const n=notes[0],i=invoices[0];
  if(n.CreditNoteID!==note.id||i.InvoiceID!==invoice.id
   ||n.Contact?.ContactID!==step.contactId||i.Contact?.ContactID!==step.contactId
   ||n.CurrencyCode!==step.currency||i.CurrencyCode!==step.currency
   ||!['AUTHORISED','PAID'].includes(n.Status)||!['AUTHORISED','PAID'].includes(i.Status)
   ||!Array.isArray(n.Allocations)||!Array.isArray(n.Payments)||n.Payments.length){
   fail('Transfer payer, currency, status or allocation coverage changed.');
  }
  if(!n.Allocations.length){
   if(amendmentMinor(n.RemainingCredit)!==step.amountMinor||amendmentMinor(i.AmountCredited)!==0
    ||amendmentMinor(i.AmountDue)<step.amountMinor)fail('Available transfer value changed.');
   return {state:'absent',creditNoteId:note.id,invoiceId:invoice.id};
  }
  const allocation=n.Allocations[0];
  if(n.Allocations.length!==1||!allocation.AllocationID||allocation.Invoice?.InvoiceID!==invoice.id
   ||amendmentMinor(allocation.Amount)!==step.amountMinor||amendmentMinor(n.RemainingCredit)!==0
   ||amendmentMinor(i.AmountCredited)!==step.amountMinor){
   fail('Transfer allocation does not match the approved amount and invoice.');
  }
  return {state:'observed',id:allocation.AllocationID,creditNoteId:note.id,invoiceId:invoice.id};
 }
 async function inspect(step,dependencies={}){
  if(step.kind==='backing_payment'){
   owned(step);
   const id=dependencies[step.creditStep]?.id;
   if(!id)fail('Verified surplus note required before backing credit.');
   const rows=(await request(`CreditNotes/${encodeURIComponent(id)}`))?.CreditNotes;
   if(rows?.length!==1||rows[0].CreditNoteID!==id)fail('Surplus note is unavailable.');
   const result=await inspectMemberCreditBacking({request,document:rows[0],context:{
    xeroTenantId:step.providerTenantId,reference:step.reference,contactId:step.contactId,currency:step.currency,
    amounts:step.amount,issueDate:step.issueDate,memberCreditLiabilityBinding:step.liabilityBinding,
   }});
   return result.state==='settled'?{state:'observed',id:result.evidence.paymentId,evidence:result.evidence}
    :{state:'absent',creditNoteId:id};
  }
  return step.kind==='allocation'?inspectAllocation(step,dependencies):inspectDocument(step);
 }
 async function submitReservedStep(step,dependencies={}){
  owned(step);
  // Callers must consume a durable write claim first. A successful provider
  // write followed by a failed read is an unknown outcome, never another write.
  let before;
  try{before=await inspect(step,dependencies);}
  catch(error){
   // This read precedes every write, so an explicit read throttle also proves
   // that this claimed attempt has not submitted money.
   if(error?.status===429&&error?.code==='accounting_rate_limited')error.replacementWriteRejected=true;
   throw error;
  }
  if(before.state==='observed')return before;
  if(step.kind==='backing_payment'){
   await submit('Payments',{method:'PUT',key:`${step.reference}:member-credit`,
    body:memberCreditBackingPayload({
     xeroTenantId:step.providerTenantId,reference:step.reference,contactId:step.contactId,currency:step.currency,
     amounts:step.amount,issueDate:step.issueDate,memberCreditLiabilityBinding:step.liabilityBinding,
    },before.creditNoteId)});
  }else if(step.kind==='allocation'){
   await submit(`CreditNotes/${encodeURIComponent(before.creditNoteId)}/Allocations`,{
    method:'PUT',key:`MR:allocation:${before.creditNoteId}:${before.invoiceId}`,
    body:{Allocations:[{Invoice:{InvoiceID:before.invoiceId},Amount:step.amountMinor/100,Date:step.issueDate}]},
   });
  }else{
   const amount={netMinor:step.amount.netMinor,taxMinor:step.amount.vatMinor,grossMinor:step.amount.grossMinor};
   const payload=buildXeroSalesInvoicePayload({
    customerId:step.contactId,currency:step.currency,issueDate:step.issueDate,dueDate:step.issueDate,
    customerReference:step.reference,idempotencyKey:step.reference,...amount,
    lines:[{description:`Membership replacement; original invoice ${step.sourceInvoiceId}`,
     quantity:'1',accountCode:step.accountCode,taxCode:step.taxCode,...amount}],
   });
   if(step.kind==='invoice')await submit('Invoices',{method:'POST',key:step.reference,body:payload});
   else{
    const {DueDate,...credit}=payload.Invoices[0];
    await submit('CreditNotes',{method:'POST',key:step.reference,
     body:{CreditNotes:[{...credit,Type:'ACCRECCREDIT'}]}});
   }
  }
  return inspect(step,dependencies);
 }
 return {inspect,submitReservedStep};
}
