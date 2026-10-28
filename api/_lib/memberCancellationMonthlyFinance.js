import {createMemberCancellationCashReader} from './memberCancellationCash.js';
import {createMemberMonthlyHistoricalPrices} from './memberMonthlyHistoricalPrices.js';
import {amendmentMinor as minor} from './memberAmendmentFinance.js';
import {amendmentMoneyParts,amendmentTermDays,prorateAmendmentMoney} from './memberAmendmentMoney.js';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
import {planMembershipChangeSettlement} from './membershipChangePolicy.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {agreementInvoicingMode} from './membershipInstalmentInvoicing.js';

const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'monthly_cancellation_evidence_required'});};
const zero=()=>({netMinor:0,vatMinor:0,grossMinor:0});
const add=(a,b)=>amendmentMoneyParts({netMinor:a.netMinor+b.netMinor,vatMinor:a.vatMinor+b.vatMinor});
const portion=(amount,gross)=>{
 if(!Number.isSafeInteger(gross)||gross<0||gross>amount.grossMinor)fail('Invoice payment is outside its original amount.');
 const net=gross===0?0:Number((BigInt(amount.netMinor)*BigInt(gross)+BigInt(amount.grossMinor)/2n)/BigInt(amount.grossMinor));
 return amendmentMoneyParts({netMinor:net,vatMinor:gross-net});
};

// Internal resolver, never a browser-supplied financial envelope. Retired
// purchases remain retired: this does not impersonate an active amendment.
export function createMemberCancellationMonthlyFinance({db,finance,cashReader=createMemberCancellationCashReader({db})}){
 async function list(table,filters){
  const rows=[];
  for(let offset=0;offset<2000;offset+=200){
   let q=db.from(table).select('*');
   for(const [key,value] of Object.entries(filters))q=q.eq(key,value);
   const {data,error}=await q.order('id').range(offset,offset+199);
   if(error||!Array.isArray(data))fail('Complete purchase accounting linkage could not be read.');
   rows.push(...data);if(data.length<200)return rows;
  }
  fail('Purchase evidence exceeds the supported verification range.');
 }
 return async function resolve(context,record){
  if(record.tenant_id!==context.tenantId||record.member_id!==context.memberId||!record.access_ended_at){
   fail('Owned applied cancellation required.');
  }
  const {sourceSnapshot:source,agreementSnapshot:agreement,planSnapshot:plan}=record.authority;
  const cash=await cashReader.read(record);
  if(!cash.complete||cash.unresolved.length||cash.sourceRecordId!==source.id
   ||cash.planId!==plan.id||cash.agreementId!==agreement.id||cash.currency!==source.currency){
   fail('Provider collections must be completely reconciled before cancellation accounting.');
  }
  const dynamic=plan.provider==='gocardless'&&plan.metadata?.collection_mode==='dynamic';
  if(agreement.metadata?.voucher_funding||agreement.metadata?.dd?.voucher_funding||agreement.metadata?.card?.voucher_funding){
   fail('Original voucher funding must be returned to its owner before personal settlement.');
  }
  if(dynamic){
   const reservations=await list('gocardless_collection_reservations',{tenant_id:context.tenantId,plan_id:plan.id});
   const resolved=new Set([...cash.payments,...cash.failed].map(p=>p.id));
   if(reservations.some(r=>!r.gocardless_payment_id||!resolved.has(r.gocardless_payment_id))){
    fail('A local Direct Debit reservation still needs reconciliation; provider silence is not proof of cancellation.');
   }
  }
  const amounts=source.commitment_snapshot?.amounts;
  if(!amounts||['final_cost','vat_amount','total_with_vat'].some(k=>minor(amounts[k])!==minor(source[k]))){
   fail('Original signed membership prices are unavailable or changed.');
  }
  const sourcePrice=amendmentMoneyParts({netMinor:minor(amounts.final_cost),vatMinor:minor(amounts.vat_amount),
   grossMinor:minor(amounts.total_with_vat)});
  if(!dynamic&&minor(agreement.metadata?.[plan.provider==='stripe'?'card':'dd']?.plan_total)!==sourcePrice.grossMinor){
   fail('The signed annual instalment obligation differs from the purchase.');
  }
  const accounting=await finance.accountingClient(context.tenantId),xeroTenantId=accounting.xeroTenantId;
  const deadline=Date.now()+25000;
  const request=(...args)=>{
   if(Date.now()>deadline)fail('Accounting verification exceeded its time budget; retry without changing the membership.');
   return accounting.request(...args);
  };
  const readInvoice=async(_tenant,id)=>{
   const rows=(await request(`Invoices/${encodeURIComponent(id)}`))?.Invoices;
   if(rows?.length!==1)fail('Original accounting invoice could not be uniquely verified.');
   return rows[0];
  };
  const mirrors=await list(plan.provider==='stripe'?'membership_instalment_invoices':'gocardless_payments',
   {tenant_id:context.tenantId,plan_id:plan.id});
  const annual=agreementInvoicingMode(agreement)==='annual';
  const links=new Map();
  const sourceId=source.accounting_invoice_id||source.xero_invoice_id;
  if(source.accounting_invoice_id&&source.xero_invoice_id&&source.accounting_invoice_id!==source.xero_invoice_id){
   fail('Original invoice links disagree.');
  }
  if(annual&&(!sourceId||dynamic))fail('Annual cancellation requires its signed fixed-price annual invoice.');
  if(!annual&&sourceId&&!mirrors.some(r=>(r.accounting_invoice_id||r.xero_invoice_id)===sourceId)){
   fail('The displayed invoice is not linked to an owned instalment.');
  }
  if(sourceId)links.set(sourceId,source.term_start_date);
  for(const row of mirrors){
   if(row.billing_agreement_id&&row.billing_agreement_id!==agreement.id)fail('Invoice linkage belongs to another agreement.');
   const invoiceId=row.accounting_invoice_id||row.xero_invoice_id;
   if(row.accounting_provider&&row.accounting_provider!=='xero')fail('Accounting provider changed.');
   if(row.accounting_invoice_id&&row.xero_invoice_id&&row.accounting_invoice_id!==row.xero_invoice_id){
    fail('Monthly invoice links disagree.');
   }
   const payment=cash.payments.find(p=>p.id===(plan.provider==='stripe'?row.external_payment_id:row.gocardless_payment_id));
   if(payment&&!invoiceId&&!sourceId)fail('A settled receipt is still waiting for its accounting invoice.');
   if(invoiceId){
    if(annual&&invoiceId!==sourceId)fail('Annual and instalment invoicing cannot be combined without reconciliation.');
    const date=payment?.date||row.charge_date||source.term_start_date;
    links.set(invoiceId,links.has(invoiceId)&&links.get(invoiceId)<date?links.get(invoiceId):date);
   }
  }
  if(!sourceId&&cash.payments.some(p=>mirrors.filter(r=>
   (plan.provider==='stripe'?r.external_payment_id:r.gocardless_payment_id)===p.id).length!==1)){
   fail('Every receipt requires one owned accounting linkage.');
  }
  if(!links.size||links.size>100)fail('Original invoicing must be complete before cancellation settlement.');
  const invoices=[],paymentIds=new Set();let settled=zero(),billed=zero(),contactId=null;
  for(const [id,date] of links){
   const doc=await readInvoice(context.tenantId,id);
   if(doc.InvoiceID!==id||doc.Type!=='ACCREC'||!['AUTHORISED','PAID'].includes(doc.Status)
    ||doc.CurrencyCode!==source.currency||!doc.Contact?.ContactID||doc.LineItems?.length!==1
    ||doc.CreditNotes?.length||minor(doc.AmountCredited||0)!==0||doc.Prepayments?.length
    ||doc.Overpayments?.length||!Array.isArray(doc.Payments)||doc.Payments.length>100){
    fail('Adjusted, foreign or incomplete accounting invoices require reconciliation.');
   }
   contactId ||= doc.Contact.ContactID;
   if(contactId!==doc.Contact.ContactID)fail('Purchase invoices have different billing contacts.');
   const amount=amendmentMoneyParts({netMinor:minor(doc.SubTotal),vatMinor:minor(doc.TotalTax),grossMinor:minor(doc.Total)});
   if(annual&&['netMinor','vatMinor','grossMinor'].some(k=>amount[k]!==sourcePrice[k])){
    fail('The annual invoice differs from the signed purchase price.');
   }
   const paid=portion(amount,minor(doc.AmountPaid)),due=portion(amount,minor(doc.AmountDue));
   // Derive the remainder from the paid allocation, avoiding independent VAT rounding.
   due.netMinor=amount.netMinor-paid.netMinor;due.vatMinor=amount.vatMinor-paid.vatMinor;
   if(paid.grossMinor+due.grossMinor!==amount.grossMinor)fail('Invoice balances do not reconcile.');
   let observed=0;const ids=[];
   for(const entry of doc.Payments){
    if(!entry.PaymentID||paymentIds.has(entry.PaymentID))fail('Duplicate or missing accounting payment.');
    const rows=(await request(`Payments/${encodeURIComponent(entry.PaymentID)}`))?.Payments,p=rows?.[0];
    if(rows?.length!==1||p.PaymentID!==entry.PaymentID||p.Status!=='AUTHORISED'||p.Invoice?.InvoiceID!==id
     ||p.CreditNote||p.Prepayment||p.Overpayment||!p.Account?.AccountID
     ||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1)||minor(p.Amount)<=0){
     fail('Original accounting payment evidence is not complete.');
    }
    observed+=minor(p.Amount);paymentIds.add(p.PaymentID);ids.push(p.PaymentID);
   }
   if(observed!==paid.grossMinor)fail('Accounting payments differ from the invoice balance.');
   invoices.push({id,sourceRecordId:source.id,currency:source.currency,providerTenantId:xeroTenantId,
    contactId,status:doc.Status,serviceStartDate:date,amount,paid,due,paymentIds:ids,
    creditedMinor:0,prepaymentMinor:0,overpaymentMinor:0,
    accountCode:doc.LineItems[0].AccountCode,taxCode:doc.LineItems[0].TaxType});
   settled=add(settled,paid);billed=add(billed,amount);
  }
  if(settled.grossMinor!==cash.settledGrossMinor)fail('Accounting receipts differ from verified provider cash.');
  const funding={complete:true,sourceRecordId:source.id,currency:source.currency,asOfDate:record.effective_date,
   settledFunding:invoices.filter(i=>i.paid.grossMinor).map(i=>({id:`xero:${i.id}`,sourceRecordId:source.id,
    currency:source.currency,state:'settled',kind:'cash',ownerType:'member',ownerId:context.memberId,...i.paid})),
   pendingCollections:[],failedCollections:[],outstandingDue:zero()};
  const term={startDate:source.term_start_date,renewalDate:source.membership_renewal_date};
  if(dynamic){
   const history=await createMemberMonthlyHistoricalPrices({db,readInvoice}).load({
    tenantId:context.tenantId,memberId:context.memberId,purchase:source,agreement,plan,
    authority:{purchaseId:source.id,agreementId:agreement.id,planId:plan.id,
     provider:'gocardless',pricingBasis:'monthly_price',currency:source.currency},
   },record.effective_date);
   funding.variableMonthlyService=history.evidence;
  }else{
   const days=amendmentTermDays(term.startDate,term.renewalDate,record.effective_date);
   const unused=prorateAmendmentMoney(sourcePrice,days.remainingDays,days.totalDays);
   funding.deliveredService={sourceRecordId:source.id,throughExclusiveDate:record.effective_date,verified:true,
    netMinor:sourcePrice.netMinor-unused.netMinor,vatMinor:sourcePrice.vatMinor-unused.vatMinor,
    grossMinor:sourcePrice.grossMinor-unused.grossMinor};
  }
  const calculation=calculateAmendmentTerms({sourceRecordId:source.id,memberId:context.memberId,currency:source.currency,
   frequency:'monthly',pricingBasis:dynamic?'monthly_price':'annual_instalments',sourcePrice,term,
   effectiveDate:record.effective_date,evidence:funding,behaviour:'retain_term',action:'cancel',
   cancellationTiming:record.timing,settlementAtTermEnd:record.timing==='end_of_term'});
  const treatment=planMembershipChangeSettlement({calculation,policy:record.authority.policySnapshot.policy,
   issuedAt:record.access_ended_at});
  if(treatment.surplusEligibleMinor<calculation.surplusMinor&&cash.payments.some(p=>
   !p.paidAt||!Number.isFinite(Date.parse(p.paidAt))||Date.parse(p.paidAt)>Date.parse(record.access_ended_at))){
   fail('Late or undated receipts cannot be forfeited as prepaid membership value.');
  }
  const fresh=await cashReader.read(record);
  if(monthlyAmendmentFingerprint(fresh)!==monthlyAmendmentFingerprint(cash)){
   fail('Provider evidence changed during accounting verification; refresh before approving.');
  }
  return {calculation,evidence:{complete:true,provider:'xero',providerTenantId:xeroTenantId,contactId,
   sourceRecordId:source.id,currency:source.currency,pendingCollections:[],disputedPayments:[],invoices,cash,
   providerEvidence:{provider:'xero',xeroTenantId,sourceInvoiceId:invoices.length===1?invoices[0].id:null,
    contactId,currency:source.currency,originalPaymentIds:[...paymentIds].sort(),originalPaidMinor:settled.grossMinor,
    originalAmounts:billed,accountCode:invoices[0].accountCode,taxCode:invoices[0].taxCode}}};
 };
}
