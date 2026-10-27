import {amendmentMinor as minor} from './memberAmendmentFinance.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_balance_unverified'});};

/** Read-only settlement evidence. Creating an invoice, note or accounting
 * payment is not proof that a member paid or received a bank refund. */
export async function inspectMemberCancellationBalance({plan,steps,adapter,request}){
 if(steps.length!==plan.steps.length||steps.some(s=>s.state!=='observed')){
  return {state:'awaiting_reconciliation',evidence:{reason:'financial_steps_pending'}};
 }
 const dependencies=Object.fromEntries(steps.map(s=>[s.step_key,s.evidence]));
 const documents=new Map();
 for(const step of plan.steps){
  const observed=await adapter.inspect(step,dependencies);
  if(observed.state!=='observed'||observed.id!==dependencies[step.key]?.id){
   fail('Financial evidence changed after its journal observation.');
  }
  documents.set(step.key,observed);
 }
 const base={verified:true,requestId:plan.requestId,currency:plan.currency};
 let dueMinor=0;
 const invoiceIds=[],paymentIds=new Set(),bankIds=new Set();
 for(const step of plan.steps.filter(s=>['original_invoice','invoice'].includes(s.kind))){
  const id=documents.get(step.key).id;
  const rows=(await request(`Invoices/${encodeURIComponent(id)}`))?.Invoices;
  const invoice=rows?.[0];
  if(rows?.length!==1||invoice.InvoiceID!==id||invoice.Contact?.ContactID!==step.contactId
   ||invoice.CurrencyCode!==plan.currency||!['AUTHORISED','PAID'].includes(invoice.Status)
   ||minor(invoice.Total)!==step.amount.grossMinor||!Array.isArray(invoice.Payments)
   ||invoice.Payments.length>25)fail('Complete owned invoice payment evidence required.');
  const credited=plan.steps.filter(s=>s.kind==='allocation'&&s.invoiceStep===step.key)
   .reduce((total,s)=>total+s.amountMinor,0);
  if(minor(invoice.AmountCredited)!==credited||minor(invoice.AmountDue)<0
   ||minor(invoice.AmountPaid)+credited+minor(invoice.AmountDue)!==step.amount.grossMinor){
   fail('Original credits or receivable balances changed.');
  }
  let paid=0;
  for(const entry of invoice.Payments){
   if(!entry.PaymentID||paymentIds.has(entry.PaymentID))fail('Duplicate or unidentified invoice payment.');
   const payments=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments,p=payments?.[0];
   if(payments?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'
    ||p.Invoice?.InvoiceID!==id||p.CreditNote||p.Prepayment||p.Overpayment||!p.Account?.AccountID
    ||minor(p.Amount)<=0||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1)){
    fail('A paid balance requires verified, owned payment evidence.');
   }
   paid+=minor(p.Amount);paymentIds.add(p.PaymentID);bankIds.add(p.Account.AccountID);
  }
  if(paid!==minor(invoice.AmountPaid))fail('Invoice payment coverage is incomplete.');
  dueMinor+=minor(invoice.AmountDue);invoiceIds.push(id);
 }
 if(bankIds.size){
  const accounts=(await request('Accounts'))?.Accounts;
  if(!Array.isArray(accounts)||[...bankIds].some(id=>accounts.filter(a=>a.AccountID===id&&a.Type==='BANK').length!==1)){
   fail('Non-cash funding needs its original-owner reconciliation.');
  }
 }
 if(dueMinor)return {state:'awaiting_payment',evidence:{...base,dueMinor,invoiceIds}};
 if(plan.choice==='credit'){
  const backing=documents.get('backing')?.evidence;
  if(!backing?.verified||backing.kind!=='member_credit_backed'||backing.retainedCreditMinor!==0){
   fail('Exact liability backing is required before member-credit issuance.');
  }
  return {state:'settled',evidence:{...backing,...base}};
 }
 if(plan.choice==='refund'){
  const note=documents.get('surplus_note')?.document,descriptor=plan.steps.find(s=>s.key==='surplus_note');
  if(!note||!descriptor||!Array.isArray(note.Payments)||!Array.isArray(note.Allocations)
   ||note.Allocations.length||note.Payments.length>25)fail('Complete unallocated refund note required.');
  if(!note.Payments.length&&minor(note.RemainingCredit)===plan.surplusMinor){
   return {state:'awaiting_refund',evidence:{...base,documentId:note.CreditNoteID,amountMinor:plan.surplusMinor,
    requiredPaymentReference:`${descriptor.reference}:refund`}};
  }
  const refunds=new Set(),refundBanks=new Set();let refunded=0;
  for(const entry of note.Payments){
   if(!entry.PaymentID||refunds.has(entry.PaymentID))fail('Duplicate refund payment.');
   const rows=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments,p=rows?.[0];
   if(rows?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'||p.IsReconciled!==true
    ||p.CreditNote?.CreditNoteID!==note.CreditNoteID||p.Invoice||p.Prepayment||p.Overpayment
    ||!p.Account?.AccountID||p.Reference!==`${descriptor.reference}:refund`||minor(p.Amount)<=0
    ||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1))fail('Exact-reference bank-reconciled refund evidence required.');
   refunds.add(p.PaymentID);refundBanks.add(p.Account.AccountID);refunded+=minor(p.Amount);
  }
  const accounts=(await request('Accounts'))?.Accounts;
  if(!Array.isArray(accounts)||[...refundBanks].some(id=>accounts.filter(a=>a.AccountID===id&&a.Type==='BANK').length!==1)
   ||refunded>plan.surplusMinor||minor(note.RemainingCredit)<0
   ||refunded+minor(note.RemainingCredit)!==plan.surplusMinor)fail('Full cash refund is not verified.');
  if(refunded<plan.surplusMinor)return {state:'awaiting_refund',evidence:{...base,
   documentId:note.CreditNoteID,paymentIds:[...refunds],refundedMinor:refunded,
   remainingMinor:plan.surplusMinor-refunded,requiredPaymentReference:`${descriptor.reference}:refund`}};
  return {state:'settled',evidence:{...base,kind:'refund_paid',documentId:note.CreditNoteID,
   paymentIds:[...refunds],refundedMinor:refunded}};
 }
 return {state:'settled',evidence:{...base,kind:plan.choice==='collect'?'debt_paid':'zero_balance',
  invoiceIds,paymentIds:[...paymentIds],dueMinor:0}};
}
