import {createMemberReplacementAccounting} from './memberReplacementAccounting.js';
import {amendmentMinor} from './memberAmendmentFinance.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_accounting_conflict'});};

export function createMemberCancellationAccounting({request,providerTenantId}){
 const writes=createMemberReplacementAccounting({request,providerTenantId});
 async function inspect(step,dependencies={}){
  if(step.kind!=='original_invoice')return writes.inspect(step,dependencies);
  if(step.providerTenantId!==providerTenantId||!step.readOnly||!step.invoiceId){
   fail('Owned original invoice evidence is required.');
  }
  const result=await request(`Invoices/${encodeURIComponent(step.invoiceId)}`);
  const invoice=result?.Invoices?.[0];
  if(result?.Invoices?.length!==1||invoice?.InvoiceID!==step.invoiceId
   ||invoice.Type!=='ACCREC'||!['AUTHORISED','PAID'].includes(invoice.Status)
   ||invoice.CurrencyCode!==step.currency||invoice.Contact?.ContactID!==step.contactId
   ||amendmentMinor(invoice.SubTotal)!==step.amount.netMinor
   ||amendmentMinor(invoice.TotalTax)!==step.amount.vatMinor
   ||amendmentMinor(invoice.Total)!==step.amount.grossMinor
   ||amendmentMinor(invoice.AmountPaid)<(step.minimumPaidMinor||0)
   ||!invoice.LineItems?.length||invoice.LineItems.some(line=>
    line.AccountCode!==step.accountCode||line.TaxType!==step.taxCode)){
   fail('Original invoice ownership or accounting classification changed.');
  }
  return {state:'observed',id:invoice.InvoiceID,
   amountPaidMinor:amendmentMinor(invoice.AmountPaid),amountDueMinor:amendmentMinor(invoice.AmountDue)};
 }
 async function submitReservedStep(step,dependencies={}){
  if(step.kind==='original_invoice')return inspect(step,dependencies);
  return writes.submitReservedStep(step,dependencies);
 }
 return {inspect,submitReservedStep};
}
