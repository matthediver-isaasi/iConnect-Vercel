import {amendmentMinor} from './memberAmendmentFinance.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'replacement_settlement_conflict'});};

/** Re-read exact documents and cash evidence; invoice creation is not payment. */
export async function inspectMemberReplacementSettlement({plan,documents,request,providerTenantId}){
 if(plan.steps.some(s=>s.providerTenantId!==providerTenantId))fail('Accounting organisation changed.');
 const invoiceId=documents.new_invoice?.id;
 if(!invoiceId)fail('Verified replacement invoice required.');
 const rows=(await request(`Invoices/${encodeURIComponent(invoiceId)}`))?.Invoices;
 const invoice=rows?.[0],first=plan.steps[0];
 if(rows?.length!==1||invoice.InvoiceID!==invoiceId||invoice.Type!=='ACCREC'
  ||!['AUTHORISED','PAID'].includes(invoice.Status)||invoice.Contact?.ContactID!==first.contactId
  ||invoice.CurrencyCode!==plan.currency||invoice.Reference!==first.reference
  ||amendmentMinor(invoice.SubTotal)!==plan.targetFullPrice.netMinor
  ||amendmentMinor(invoice.TotalTax)!==plan.targetFullPrice.vatMinor
  ||amendmentMinor(invoice.Total)!==plan.targetFullPrice.grossMinor
  ||amendmentMinor(invoice.AmountCredited)!==plan.transferred.grossMinor
  ||invoice.Prepayments?.length||invoice.Overpayments?.length){
  fail('Replacement invoice settlement ownership or value changed.');
 }
 const credits=invoice.CreditNotes||[];
 if(plan.transferred.grossMinor>0){
  if(credits.length!==1||credits[0].CreditNoteID!==documents.transfer_note?.id
   ||!documents.transfer_allocation?.id)fail('Replacement transfer coverage is incomplete.');
 }else if(credits.length)fail('Unexpected invoice credits.');
 if(!Array.isArray(invoice.Payments)||invoice.Payments.length>25)fail('Complete invoice payment coverage is required.');
 const paymentIds=[],cashPayments=[];
 let paid=0;
 for(const entry of invoice.Payments){
  if(!entry.PaymentID||paymentIds.includes(entry.PaymentID))fail('Ambiguous invoice payment identity.');
  const payments=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments;
  const p=payments?.[0];
  if(payments?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'
   ||p.Invoice?.InvoiceID!==invoiceId||!p.Account?.AccountID
   ||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1))fail('Invoice cash payment is not verified.');
  const amount=amendmentMinor(p.Amount);
  if(amount<=0)fail('Invalid invoice cash amount.');
  const accounts=(await request(`Accounts/${encodeURIComponent(p.Account.AccountID)}`))?.Accounts;
  if(accounts?.length!==1||accounts[0].AccountID!==p.Account.AccountID||accounts[0].Type!=='BANK'
   ||(accounts[0].BankAccountCurrencyCode&&accounts[0].BankAccountCurrencyCode!==plan.currency)){
   fail('Additional collection must be verified as cash, not another liability-funded payment.');
  }
  paid+=amount;paymentIds.push(p.PaymentID);cashPayments.push({paymentId:p.PaymentID,amountMinor:amount});
 }
 if(paid!==amendmentMinor(invoice.AmountPaid)||paid>plan.additionalPaymentMinor
  ||amendmentMinor(invoice.AmountDue)!==plan.additionalPaymentMinor-paid){
  fail('Invoice balance does not reconcile with the approved transfer and cash.');
 }
 const base={provider:'xero',providerTenantId,currency:plan.currency,invoiceId,invoiceNumber:invoice.InvoiceNumber||null,paymentIds,cashPayments,
  amount:plan.targetFullPrice,transferred:plan.transferred,transferCreditNoteId:documents.transfer_note?.id||null,
  transferAllocationId:documents.transfer_allocation?.id||null};
 if(paid!==plan.additionalPaymentMinor||invoice.Status!=='PAID'){
  let paymentUrl=null,paymentLinkError=null;
  try{
   const links=(await request(`Invoices/${encodeURIComponent(invoiceId)}/OnlineInvoice`))?.OnlineInvoices;
   if(links?.length===1){
    const url=new URL(links[0].OnlineInvoiceUrl);
    if(url.protocol==='https:'&&!url.username&&!url.password
     &&(url.hostname==='xero.com'||url.hostname.endsWith('.xero.com')))paymentUrl=url.href;
   }
   if(!paymentUrl)paymentLinkError='A verified payment link is not available yet.';
  }catch{paymentLinkError='The payment link could not be read. Check the existing invoice again; no new invoice is needed.';}
  return {state:'awaiting_payment',evidence:{...base,verified:true,paymentUrl,paymentLinkError,kind:'awaiting_replacement_payment',
   amountDueMinor:plan.additionalPaymentMinor-paid}};
 }
 let surplusEvidence=null;
 if(plan.surplus.grossMinor>0){
  if(plan.choice==='credit'){
   surplusEvidence=documents.credit_backing?.evidence;
   if(surplusEvidence?.kind!=='member_credit_backed'||surplusEvidence.verified!==true
    ||!surplusEvidence.paymentId)fail('Surplus credit is not liability-backed.');
  }else if(plan.choice==='refund'){
   const noteId=documents.surplus_note?.id;
   if(!noteId)fail('Refund note required.');
   const notes=(await request(`CreditNotes/${encodeURIComponent(noteId)}`))?.CreditNotes;
   const note=notes?.[0];
   if(notes?.length!==1||note.CreditNoteID!==noteId||note.Contact?.ContactID!==first.contactId
    ||note.CurrencyCode!==plan.currency||note.Type!=='ACCRECCREDIT'
    ||!['AUTHORISED','PAID'].includes(note.Status)||note.Reference!==`MA:${plan.executionId}`
    ||amendmentMinor(note.Total)!==plan.surplus.grossMinor||note.Allocations?.length
    ||!Array.isArray(note.Payments)||note.Payments.length>25)fail('Refund note ownership or value changed.');
   const refundIds=[];let refunded=0;
   for(const entry of note.Payments){
    if(!entry.PaymentID||refundIds.includes(entry.PaymentID))fail('Ambiguous refund payment.');
    const payments=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments;
    const p=payments?.[0];
    if(payments?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'
     ||p.IsReconciled!==true||p.CreditNote?.CreditNoteID!==noteId||!p.Account?.AccountID
     ||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1))fail('A bank-reconciled refund is required.');
    const accounts=(await request(`Accounts/${encodeURIComponent(p.Account.AccountID)}`))?.Accounts;
    if(accounts?.length!==1||accounts[0].AccountID!==p.Account.AccountID||accounts[0].Type!=='BANK'){
     fail('Refund must be recorded against a real bank account.');
    }
    const amount=amendmentMinor(p.Amount);
    if(amount<=0)fail('Invalid refund amount.');
    refunded+=amount;refundIds.push(p.PaymentID);
   }
   if(refunded>plan.surplus.grossMinor||amendmentMinor(note.RemainingCredit)!==plan.surplus.grossMinor-refunded){
    fail('Refund balance does not reconcile.');
   }
   if(refunded!==plan.surplus.grossMinor)return {state:'awaiting_payment',evidence:{
    ...base,kind:'awaiting_recorded_manual_refund',amountDueMinor:plan.surplus.grossMinor-refunded}};
   surplusEvidence={kind:'refunded',verified:true,documentId:noteId,paymentIds:refundIds};
  }else fail('Unknown surplus treatment.');
 }
 return {state:'settled',evidence:{...base,kind:'replacement_settled',verified:true,surplusEvidence}};
}
