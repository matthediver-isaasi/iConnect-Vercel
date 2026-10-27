import {amendmentMinor as minor} from './memberAmendmentFinance.js';
import {createMemberCancellationAccounting} from './memberCancellationAccounting.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
const fail=()=>{throw Object.assign(new Error('Cancellation credit source requires reconciliation.'),{status:409,code:'cancellation_credit_source_changed'});};

// Input comes exclusively from the protected credit-provenance RPC. Never
// accept these source snapshots or accounting identities from a browser.
export async function verifyCancellationCreditSource({
 amendment,request,xeroTenantId,verifyBankAccounts,verifyCard,verifyMonthlyCash,
}){
 const proof=amendment.cancellationProof,r=proof?.record,source=proof?.sourceEvidence,steps=proof?.steps;
 if(!r?.access_ended_at||r.id!==amendment.id||r.tenant_id!==amendment.tenant_id
  ||r.member_id!==amendment.member_id||source?.complete!==true||source.sourceRecordId!==r.source_record_id
  ||source.providerTenantId!==xeroTenantId||source.currency!==amendment.quote.currency
  ||!Array.isArray(source.invoices)||!source.invoices.length||source.invoices.length>1000
  ||!Array.isArray(steps)||steps.length>2100||steps.some(s=>s.request_id!==r.id||s.state!=='observed'))fail();
 const dependencies=Object.fromEntries(steps.map(s=>[s.step_key,s.evidence]));
 if(Object.keys(dependencies).length!==steps.length)fail();
 const adapter=createMemberCancellationAccounting({request,providerTenantId:xeroTenantId});
 for(const step of steps){
  const observed=await adapter.inspect(step.descriptor,dependencies);
  if(observed.state!=='observed'||observed.id!==step.evidence?.id)fail();
 }
 const payments=new Set(),banks=new Set(),invoices=new Set();
 for(const invoice of source.invoices){
  if(!invoice.id||invoices.has(invoice.id)||invoice.contactId!==source.contactId
   ||invoice.providerTenantId!==xeroTenantId||invoice.currency!==source.currency)fail();
  invoices.add(invoice.id);
  const rows=(await request(`Invoices/${encodeURIComponent(invoice.id)}`))?.Invoices,doc=rows?.[0];
  if(rows?.length!==1||doc.InvoiceID!==invoice.id||doc.Contact?.ContactID!==source.contactId
   ||doc.CurrencyCode!==source.currency||!['AUTHORISED','PAID'].includes(doc.Status)
   ||minor(doc.Total)!==invoice.amount.grossMinor||minor(doc.AmountPaid)!==invoice.paid.grossMinor
   ||!Array.isArray(doc.Payments)||doc.Payments.length>25)fail();
  let paid=0;const ids=[];
  for(const entry of doc.Payments){
   if(!entry.PaymentID||payments.has(entry.PaymentID))fail();
   const rows=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments,p=rows?.[0];
   if(rows?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'
    ||p.Invoice?.InvoiceID!==invoice.id||p.CreditNote||p.Prepayment||p.Overpayment
    ||!p.Account?.AccountID||minor(p.Amount)<=0||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1))fail();
   paid+=minor(p.Amount);ids.push(p.PaymentID);payments.add(p.PaymentID);banks.add(p.Account.AccountID);
  }
  if(paid!==invoice.paid.grossMinor)fail();
  const expected=invoice.paymentIds||(source.invoices.length===1?source.providerEvidence?.originalPaymentIds:null);
  if(!Array.isArray(expected)||JSON.stringify([...expected].sort())!==JSON.stringify(ids.sort()))fail();
 }
 if(r.source_snapshot.commitment_snapshot?.payment_frequency==='upfront'){
  await verifyCard(amendment);
  if(r.source_snapshot.payment_method!=='stripe'&&banks.size)await verifyBankAccounts(request,[...banks]);
 }else{
  if(!source.cash?.complete||!Array.isArray(source.cash.payments)||!verifyMonthlyCash)fail();
  const current=await verifyMonthlyCash(r);
  const receipts=cash=>monthlyAmendmentFingerprint([...cash.payments].sort((a,b)=>a.id.localeCompare(b.id)));
  if(!current.complete||!Array.isArray(current.unresolved)||current.unresolved.length||!Array.isArray(current.payments)
   ||current.provider!==source.cash.provider||current.currency!==source.currency
   ||receipts(current)!==receipts(source.cash))fail();
 }
 return source.providerEvidence;
}
