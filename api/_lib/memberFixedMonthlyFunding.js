import { readMonthlyXeroInvoice, monthlyInvoiceMinor as minor } from './memberMonthlyHistoricalPrices.js';
import { amendmentTermDays, prorateAmendmentMoney } from './memberAmendmentMoney.js';
const fail=message=>{throw Object.assign(new Error(message),{status:422,code:'fixed_monthly_evidence_required'});};
export async function readMemberFixedMonthlyFunding({db,input,funding,readInvoice=readMonthlyXeroInvoice}){
  const {tenantId,memberId,purchase,agreement,plan,authority,effectiveDate}=input;
  if(authority.pricingBasis!=='annual_instalments' || !['stripe','gocardless'].includes(authority.provider)
    || !Array.isArray(funding?.payments) || funding.sourceRecordId!==purchase.id
    || funding.planId!==plan.id || funding.agreementId!==agreement.id || funding.pendingGrossMinor!==0
    || funding.provider!==authority.provider || funding.currency!==authority.currency) {
    fail('Complete fixed monthly provider evidence is required.');
  }
  const amounts=purchase.commitment_snapshot?.amounts;
  if(!amounts || ['final_cost','vat_amount','total_with_vat'].some(k=>minor(amounts[k])!==minor(purchase[k]))) {
    fail('Original annual prices must match the signed purchase snapshot.');
  }
  const sourcePrice={netMinor:minor(amounts.final_cost),vatMinor:minor(amounts.vat_amount),grossMinor:minor(amounts.total_with_vat)};
  const terms=agreement.metadata[authority.provider==='stripe'?'card':'dd'];
  if(sourcePrice.netMinor+sourcePrice.vatMinor!==sourcePrice.grossMinor
    || sourcePrice.grossMinor!==minor(terms.plan_total)) fail('Original annual obligation is inconsistent.');
  const rows=[],table=authority.provider==='stripe'?'membership_instalment_invoices':'gocardless_payments';
  for(let offset=0;;offset+=500){
    const {data,error}=await db.from(table).select('*').eq('tenant_id',tenantId).eq('plan_id',plan.id)
      .order('id').range(offset,offset+499);
    if(error||!Array.isArray(data)) fail('Monthly invoice linkage is unavailable.');
    rows.push(...data);if(data.length<500)break;
  }
  const seen=new Set(),invoices=new Set(),settledFunding=[],deadline=Date.now()+25000;
  for(const payment of funding.payments){
    if(!payment.id || seen.has(payment.id) || !payment.settled || payment.date>=effectiveDate
      || !authority.collectionDates.includes(payment.date)) fail('Monthly cash or collection dates need reconciliation.');
    seen.add(payment.id);
    const matches=rows.filter(r=>(authority.provider==='stripe'?r.external_payment_id:r.gocardless_payment_id)===payment.id);
    const row=matches.length===1?matches[0]:null;
    const invoiceId=row?.accounting_invoice_id||row?.xero_invoice_id;
    if(!row || !invoiceId || invoices.has(invoiceId)
      || (row.accounting_provider && row.accounting_provider!=='xero')
      || (row.accounting_invoice_id && row.xero_invoice_id && row.accounting_invoice_id!==row.xero_invoice_id)
      || (authority.provider==='stripe' && (row.provider!=='stripe'||row.billing_agreement_id!==agreement.id
        || row.amount_minor!==payment.amountMinor || row.currency?.toUpperCase()!==authority.currency))) {
      fail('A unique purchase-linked accounting invoice is required for each receipt.');
    }
    invoices.add(invoiceId);
    const remaining=deadline-Date.now();
    if(remaining<1000)fail('Invoice verification exceeded its time budget.');
    const invoice=await readInvoice(tenantId,invoiceId,{timeoutMs:Math.min(12000,remaining)});
    if(invoice?.InvoiceID!==invoiceId || invoice.Type!=='ACCREC'
      || !['AUTHORISED','PAID'].includes(invoice.Status) || invoice.CurrencyCode!==authority.currency
      || !invoice.Contact?.ContactID || invoice.LineItems?.length!==1
      || (invoice.CreditNotes?.length||0)>0 || Number(invoice.AmountCredited||0)!==0) {
      fail('Monthly invoice tax or credit adjustments need reconciliation.');
    }
    const netMinor=minor(invoice.SubTotal),vatMinor=minor(invoice.TotalTax),grossMinor=minor(invoice.Total);
    if(netMinor+vatMinor!==grossMinor || grossMinor!==payment.amountMinor)fail('Invoice and verified receipt amounts differ.');
    settledFunding.push({id:`${authority.provider}:${payment.id}`,sourceRecordId:purchase.id,currency:authority.currency,
      state:'settled',ownerType:'member',ownerId:memberId,kind:'cash',netMinor,vatMinor,grossMinor,invoiceEvidenceId:invoiceId});
  }
  if(authority.collectionDates.filter(date=>date<effectiveDate)
    .some(date=>funding.payments.filter(p=>p.date===date).length!==1)
    || settledFunding.reduce((sum,p)=>sum+p.grossMinor,0)!==funding.settledGrossMinor) {
    fail('Outstanding or missing past collections need reconciliation.');
  }
  const days=amendmentTermDays(purchase.term_start_date,purchase.membership_renewal_date,effectiveDate);
  const unused=prorateAmendmentMoney(sourcePrice,days.remainingDays,days.totalDays);
  return {sourcePrice,fundingEvidence:{
    sourceRecordId:purchase.id,currency:authority.currency,asOfDate:effectiveDate,complete:true,
    settledFunding,pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0,grossMinor:0},
    deliveredService:{sourceRecordId:purchase.id,throughExclusiveDate:effectiveDate,verified:true,
      netMinor:sourcePrice.netMinor-unused.netMinor,vatMinor:sourcePrice.vatMinor-unused.vatMinor,
      grossMinor:sourcePrice.grossMinor-unused.grossMinor},
  }};
}
