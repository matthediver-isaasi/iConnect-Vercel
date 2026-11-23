import {buildFunnelCreditLines} from './eventFunnelCreditLines.js';
import {EventInvoiceRecoveryError} from './eventInvoiceRecovery.js';

/** Persist the resolved purchaser and tax evidence, excluding mutable balances.
 * Older prepared invoices without line attribution retain their existing
 * delivery path but require reconciliation before allocation-aware credits.
 */
export async function recordFunnelIssuedInvoice({db,row,invoice}) {
  const snapshot=row.snapshot,links=snapshot?.eventFunnel?.lineAllocations;
  if(!links)return;
  buildFunnelCreditLines({invoice,expectedInvoice:snapshot.invoice,lineAllocations:links,selected:[]});
  if(!invoice.InvoiceID||!invoice.Contact?.ContactID)
    throw new EventInvoiceRecoveryError('funnel_invoice_customer_unverified');
  const evidence={
    InvoiceID:invoice.InvoiceID,Contact:{ContactID:invoice.Contact.ContactID},
    CurrencyCode:invoice.CurrencyCode,LineAmountTypes:invoice.LineAmountTypes,Total:invoice.Total,TotalTax:invoice.TotalTax,
    LineItems:invoice.LineItems.map(line=>({
      LineItemID:line.LineItemID,Description:line.Description,Quantity:line.Quantity,UnitAmount:line.UnitAmount,
      LineAmount:line.LineAmount,TaxAmount:line.TaxAmount,TaxType:line.TaxType,AccountCode:line.AccountCode,
      ...(line.Tracking?.length?{Tracking:line.Tracking.map(t=>({Name:t.Name,Option:t.Option}))}:{}),
    })),
  };
  const result=await db.rpc('event_funnel_invoice_evidence',{p_tenant:row.tenant_id,p_order:row.order_id,
    p_work:row.id,p_token:row.lease_token,p_evidence:evidence});
  if(result.error||result.data!==true)throw new EventInvoiceRecoveryError('funnel_invoice_evidence_unavailable',{retry:true});
}
