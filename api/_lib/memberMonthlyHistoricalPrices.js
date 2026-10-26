import {AmendmentCalculationError,amendmentDay,amendmentMoneyParts} from './memberAmendmentMoney.js';
import {membershipServiceAnniversary,reconcileVariableMonthlyService} from './memberVariableMonthlyService.js';

const fail=message=>{throw new AmendmentCalculationError(message);};
const minor=value=>{
  if(value==null || value==='' || typeof value==='boolean')fail('Historical invoice money is missing.');
  const n=Number(value),p=Math.round(n*100);
  if(!Number.isSafeInteger(p)||p<0||Math.abs(n*100-p)>0.000001)fail('Historical invoice money is inexact.');
  return p;
};
async function xeroInvoice(tenantId,id,{timeoutMs=12000}={}) {
  const {getAccountingProvider}=await import('./accountingProvider.js');
  const provider=await getAccountingProvider(tenantId);
  if(provider.name!=='xero')fail('Historical monthly invoice verification currently requires Xero.');
  const credentials=await provider.getRawAccessToken(tenantId);
  const response=await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(id)}`,{
    headers:{Authorization:`Bearer ${credentials.accessToken}`,'xero-tenant-id':credentials.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(timeoutMs),
  });
  if(!response.ok)fail('Historical invoice could not be verified; retry without changing the membership.');
  const body=await response.json();
  if(body.Invoices?.length!==1)fail('Historical invoice evidence is ambiguous.');
  return body.Invoices[0];
}
export { xeroInvoice as readMonthlyXeroInvoice, minor as monthlyInvoiceMinor };

// Read-only. The input is produced by memberMonthlyPurchaseAuthority, never by
// posted form answers. Gross service price is not the cash paid after vouchers.
export function createMemberMonthlyHistoricalPrices({db,readInvoice=xeroInvoice}) {
  async function list(table,filters) {
    const rows=[];
    for(let offset=0;;offset+=500) {
      let q=db.from(table).select('*');
      for(const [key,value] of Object.entries(filters))q=q.eq(key,value);
      const result=await q.order('id').range(offset,offset+499);
      if(result.error || !Array.isArray(result.data))fail('Historical billing records could not be read.');
      rows.push(...result.data);if(result.data.length<500)return rows;
    }
  }
  return {async load(input,throughExclusiveDate) {
    const deadline=Date.now()+25000;
    const {tenantId,memberId,purchase,agreement,plan,authority}=input;
    const term={startDate:purchase?.term_start_date,renewalDate:purchase?.membership_renewal_date};
    if(!tenantId || !memberId || !authority || [purchase,agreement,plan].some(
      row=>!row || row.tenant_id!==tenantId || row.member_id!==memberId)
      || purchase.billing_agreement_id!==agreement.id || plan.billing_agreement_id!==agreement.id
      || authority.purchaseId!==purchase.id || authority.planId!==plan.id
      || authority.agreementId!==agreement.id || authority.provider!=='gocardless'
      || authority.pricingBasis!=='monthly_price' || agreement.organization_id || plan.organization_id) {
      fail('A resolved personal dynamic Direct Debit purchase is required.');
    }
    const through=amendmentDay(throughExclusiveDate);
    if(through<amendmentDay(term.startDate)||through>amendmentDay(term.renewalDate))fail('Service date is outside the purchased term.');
    const reservations=await list('gocardless_collection_reservations',{tenant_id:tenantId,plan_id:plan.id});
    const periods=[],seen=new Set();
    for(let ordinal=1;membershipServiceAnniversary(term.startDate,ordinal-1)<throughExclusiveDate;ordinal++) {
      if(ordinal>120)fail('Historical monthly evidence exceeds the supported lookup range.');
      const matches=reservations.filter(r=>r.collection_number===ordinal);
      if(matches.length!==1)fail(`Exactly one historical price is required for service month ${ordinal}.`);
      const r=matches[0],snapshot=r.price_snapshot;
      if(r.billing_agreement_id!==agreement.id || r.term_key!==purchase.term_key
        || r.currency!==authority.currency || snapshot?.currency!==authority.currency
        || !Number.isSafeInteger(snapshot.monthly_amount_minor) || snapshot.monthly_amount_minor<=0
        || r.amount_minor!==snapshot.monthly_amount_minor || !r.gocardless_payment_id) {
        fail('Historical full-service price or funding allocation needs reconciliation.');
      }
      const payments=await list('gocardless_payments',{tenant_id:tenantId,plan_id:plan.id,gocardless_payment_id:r.gocardless_payment_id});
      const payment=payments.length===1?payments[0]:null;
      const invoiceId=payment?.accounting_invoice_id || payment?.xero_invoice_id;
      if(!invoiceId || (payment.accounting_provider && payment.accounting_provider!=='xero')
        || (payment.accounting_invoice_id && payment.xero_invoice_id && payment.accounting_invoice_id!==payment.xero_invoice_id)
        || seen.has(invoiceId))fail('A unique source-linked historical invoice is required.');
      seen.add(invoiceId);
      const remaining=deadline-Date.now();
      if(remaining<1000)fail('Historical invoice verification exceeded its time budget; retry without changing the membership.');
      const invoice=await readInvoice(tenantId,invoiceId,{timeoutMs:Math.min(12000,remaining)});
      if(invoice?.InvoiceID!==invoiceId || invoice.Type!=='ACCREC'
        || !['AUTHORISED','PAID'].includes(invoice.Status) || invoice.CurrencyCode!==authority.currency
        || invoice.CreditNotes?.length || Number(invoice.AmountCredited||0)!==0
        || !invoice.Contact?.ContactID || invoice.LineItems?.length!==1)fail('Historical invoice is adjusted, foreign or ambiguous.');
      const amounts=amendmentMoneyParts({netMinor:minor(invoice.SubTotal),vatMinor:minor(invoice.TotalTax),grossMinor:minor(invoice.Total)});
      if(amounts.grossMinor!==snapshot.monthly_amount_minor)fail('Invoice does not prove the full historical service price.');
      const start=membershipServiceAnniversary(term.startDate,ordinal-1);
      const end=membershipServiceAnniversary(term.startDate,ordinal);
      if(end>term.renewalDate)fail('A shortened final service period needs explicit period-price evidence.');
      periods.push({ordinal,evidenceId:`${r.id}:${invoiceId}`,providerPaymentId:r.gocardless_payment_id,
        collectionDate:payment.charge_date,sourceRecordId:purchase.id,currency:authority.currency,
        serviceStartDate:start,serviceEndExclusiveDate:end,verified:true,...amounts});
    }
    const evidence={sourceRecordId:purchase.id,currency:authority.currency,throughExclusiveDate,
      complete:true,basis:'membership_start_anniversaries',periods};
    return {evidence,deliveredService:reconcileVariableMonthlyService({
      sourceRecordId:purchase.id,currency:authority.currency,term,throughExclusiveDate,evidence})};
  }};
}
