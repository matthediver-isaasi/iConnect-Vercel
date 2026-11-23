import {assertLegacyFunnelReversalAllowed} from './eventFunnelReversalBoundary.js';
import {buildFunnelCancellationAmounts} from './eventFunnelCancellationAmounts.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_CANCELLATION_EVIDENCE'});};
/** Server-only preparation after the endpoint loads and authorizes cancellation
 * requests. No provider calls or writes. Final approval must bind these requests
 * and reserve all prepared allocations atomically.
 */
export async function prepareFunnelCancellation({db,tenantId,requests,operationId,amountsByRequest={}}){
  if(!tenantId||!operationId||!Array.isArray(requests)||!requests.length||requests.length>1000
    ||requests.some(r=>!r.id||r.tenant_id!==tenantId||!r.booking_id
      ||!['booking','complex_event_booking'].includes(r.booking_source||'booking'))
    ||new Set(requests.map(r=>r.id)).size!==requests.length
    ||new Set(requests.map(r=>`${r.booking_source||'booking'}:${r.booking_id}`)).size!==requests.length
    ||!amountsByRequest||typeof amountsByRequest!=='object'||Array.isArray(amountsByRequest)
    ||Object.keys(amountsByRequest).some(id=>!requests.some(r=>r.id===id)))
    fail('Cancellation request scope is invalid');
  const bookings=requests.map(r=>({id:r.booking_id,source:r.booking_source||'booking'}));
  const report=await db.rpc('event_funnel_invoice_report',{p_tenant:tenantId,p_bookings:bookings});
  if(['42883','PGRST202'].includes(report.error?.code)){
    // Partial migration rollout must not let a missing reader bypass an
    // already-installed shared-checkout financial guard.
    for(const source of ['booking','complex_event_booking']){
      const ids=bookings.filter(b=>b.source===source).map(b=>b.id);
      if(ids.length)await assertLegacyFunnelReversalAllowed({db,tenantId,source,bookingIds:ids});
    }
    return {kind:'legacy'};
  }
  if(report.error||!Array.isArray(report.data))fail('Original checkout ownership is unavailable');
  if(!report.data.length)return {kind:'legacy'};
  if(report.data.length!==bookings.length
    ||new Set(report.data.map(row=>`${row.bookingSource}:${row.bookingId}`)).size!==bookings.length
    ||report.data.some(row=>!bookings.some(b=>b.source===row.bookingSource&&b.id===row.bookingId))
    ||new Set(report.data.map(row=>row.orderId)).size!==1||!report.data[0].orderId)
    fail('Mixed checkout cancellations require separate approval');
  const orderId=report.data[0].orderId;
  const read=await db.rpc('event_funnel_reversal_context',{p_tenant:tenantId,p_order:orderId});
  if(read.error||read.data?.order?.id!==orderId||read.data.order.tenant_id!==tenantId
    ||!Array.isArray(read.data.allocations)||!Array.isArray(read.data.history))
    fail('Original cancellation authority is unavailable');
  const context=read.data,plan=context.order.snapshot;
  // Version 1 invoices positive payable amounts (including public PO), not
  // funding-only value. An unavailable customer/provider payload may delay the
  // credit leg, but must not prevent preparing cancellation of a paid booking.
  if(plan?.version!==1||!['per_event','consolidated'].includes(plan.invoiceMode)
    ||plan.paymentMethod!==context.order.payment_method||plan.currency!==context.order.currency
    ||!Array.isArray(plan.lines))fail('Original invoicing policy is unavailable');
  const items=requests.map(request=>{
    const source=request.booking_source||'booking';
    const booking=context.allocations.find(row=>row.booking_source===source&&row.booking_id===request.booking_id);
    if(!booking)fail('Original registration allocation is missing');
    const original=context.order.snapshot.lines.filter(line=>(line.eventKind==='simple'?'booking':'complex_event_booking')===source)
      .flatMap(line=>line.registrations).filter(row=>row.id===booking.booking_id);
    if(original.length!==1)fail('Original registration accounting authority is incomplete');
    const choices=amountsByRequest[request.id]||{};
    if(typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).some(key=>!['refundAllocation','customRefundAmount'].includes(key)))
      fail('Invalid cancellation amount choices');
    return buildFunnelCancellationAmounts({order:context.order,booking,history:context.history,operationId,
      invoiceRequired:Number(booking.payable_minor)>0,voucherContributions:original[0].voucherContributions||
        (Number(booking.voucher_minor)===0?[]:null),...choices});
  });
  return {kind:'funnel',tenantId,orderId,operationId,requestIds:requests.map(r=>r.id),items};
}
