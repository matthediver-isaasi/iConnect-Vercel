import {buildFunnelCreditLines} from './eventFunnelCreditLines.js';
import {EventInvoiceRecoveryError,recoveryIdentity} from './eventInvoiceRecovery.js';
import {eventInvoiceBookingReference,recoveryInvoiceMarker} from './eventInvoiceRecoveryXero.js';

// Invoice creation appends one discovery reference to the first line. Accept
// exactly the suffix this work item's creator writes, nothing else.
function expectedIssuedInvoice(row,invoice){
  const expected=row.snapshot.invoice,first=expected?.LineItems?.[0];
  const actual=invoice?.LineItems?.find(line=>typeof line?.Description==='string'
    &&typeof first?.Description==='string'&&line.Description.startsWith(first.Description))?.Description;
  if(!actual||actual===first.Description)return expected;
  const suffixes=[];
  if(row.booking_group_reference){
    suffixes.push(eventInvoiceBookingReference(row.booking_group_reference));
    if(row.source)suffixes.push(recoveryInvoiceMarker(recoveryIdentity(row.tenant_id,row.source,row.booking_group_reference)));
  }
  const suffix=suffixes.find(value=>actual===first.Description+value);
  if(!suffix)return expected;
  return {...expected,LineItems:expected.LineItems.map((line,i)=>i===0?{...line,Description:line.Description+suffix}:line)};
}

/** Persist the resolved purchaser and tax evidence, excluding mutable balances.
 * Older prepared invoices without line attribution retain their existing
 * delivery path but require reconciliation before allocation-aware credits.
 */
export async function recordFunnelIssuedInvoice({db,row,invoice}) {
  const snapshot=row.snapshot,links=snapshot?.eventFunnel?.lineAllocations;
  if(!links)return;
  try {
    buildFunnelCreditLines({invoice,expectedInvoice:expectedIssuedInvoice(row,invoice),lineAllocations:links,selected:[]});
  } catch(error) {
    if(error instanceof EventInvoiceRecoveryError)throw error;
    // The invoice exists; a mismatch with its frozen lines needs a person.
    throw new EventInvoiceRecoveryError('funnel_invoice_lines_changed');
  }
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
