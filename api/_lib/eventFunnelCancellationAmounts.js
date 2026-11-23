const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_CANCELLATION_EVIDENCE'});};
const integer=value=>{
  const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(n)||n<0)fail('Original cancellation amounts are unavailable');
  return n;
};
const money=value=>{
  if(!['number','string'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))
    fail('Refund amounts must be nonnegative amounts with at most two decimal places');
  return integer(Math.round(Number(value)*100));
};
const fields=['cardMinor','invoiceMinor','trainingFundMinor','voucherMinor'];
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Pure preparation from PRIVATE original order evidence, never live booking
 * price/payment fields. The reserve RPC independently enforces all limits.
 */
export function buildFunnelCancellationAmounts({order,booking,history,operationId,voucherContributions,
  invoiceRequired,refundAllocation={},customRefundAmount=null}){
  if(!order?.id||!order.tenant_id||order.state!=='confirmed'||!['card','account','public_invoice_po','free'].includes(order.payment_method)
    ||booking?.order_id!==order.id||booking.tenant_id!==order.tenant_id
    ||!['booking','complex_event_booking'].includes(booking.booking_source)||!booking.booking_id
    ||!Array.isArray(history)||!operationId||typeof invoiceRequired!=='boolean'
    ||!refundAllocation||Array.isArray(refundAllocation)||typeof refundAllocation!=='object'
    ||Object.keys(refundAllocation).some(key=>!['stripeAmount','invoiceAmount','trainingFundAmount','vouchers'].includes(key)))
    fail('Original cancellation scope is unavailable');
  const matches=item=>item.source===booking.booking_source&&item.id===booking.booking_id;
  const maximum={cardMinor:order.payment_method==='card'?integer(booking.payable_minor):0,
    invoiceMinor:invoiceRequired?integer(booking.payable_minor):0,
    trainingFundMinor:integer(booking.training_fund_minor),voucherMinor:integer(booking.voucher_minor)};
  const remaining={...maximum},voucherUsed=new Map(),seen=new Set();let own;
  for(const op of history){
    if(!op.id||seen.has(op.id)||op.order_id!==order.id||op.tenant_id!==order.tenant_id||!Array.isArray(op.allocations))
      fail('Original refund history is incomplete');
    seen.add(op.id);
    if(op.id===operationId){
      if(op.state==='released')fail('Released refund authority cannot be reused');
      own=op;
      continue;
    }
    if(op.state==='released')continue;
    const selected=op.allocations.filter(matches);
    if(selected.length>1)fail('Duplicate historical refund allocation');
    for(const item of selected){
      for(const field of fields)remaining[field]-=integer(item[field]);
      if(integer(item.voucherMinor)>0){
        if(!Array.isArray(op.voucher_plan))fail('Original voucher refund history is missing');
        const parts=op.voucher_plan.filter(p=>p.source===booking.booking_source&&p.bookingId===booking.booking_id);
        if(parts.reduce((sum,p)=>sum+integer(p.amountMinor),0)!==item.voucherMinor)
          fail('Original voucher refund history is incomplete');
        for(const part of parts)voucherUsed.set(part.voucherId,(voucherUsed.get(part.voucherId)||0)+integer(part.amountMinor));
      }
    }
  }
  for(const field of fields)integer(remaining[field]);
  const prior=own?.allocations.filter(matches);
  if(own&&prior.length!==1)fail('Refund operation belongs to different registrations');
  const defaults=prior?.[0]||remaining;
  const explicitCard=customRefundAmount??refundAllocation.stripeAmount;
  const selected={source:booking.booking_source,id:booking.booking_id,
    cardMinor:explicitCard==null?integer(defaults.cardMinor):money(explicitCard),
    invoiceMinor:refundAllocation.invoiceAmount!=null?money(refundAllocation.invoiceAmount):
      invoiceRequired&&explicitCard!=null?money(explicitCard):integer(defaults.invoiceMinor),
    trainingFundMinor:refundAllocation.trainingFundAmount==null?integer(defaults.trainingFundMinor):money(refundAllocation.trainingFundAmount)};
  if(!Array.isArray(voucherContributions))fail('Original voucher contributions are missing');
  const original=new Map();
  for(const part of voucherContributions){
    if(!uuid(part.voucherId)||original.has(part.voucherId)||integer(part.amountMinor)===0)fail('Original voucher contributions are invalid');
    original.set(part.voucherId,integer(part.amountMinor));
  }
  if([...original.values()].reduce((sum,value)=>sum+value,0)!==maximum.voucherMinor
    ||[...voucherUsed.keys()].some(id=>!original.has(id)))fail('Original voucher contributions do not match the purchase');
  const requested=refundAllocation.vouchers??{};
  if(typeof requested!=='object'||Array.isArray(requested)||Object.keys(requested).some(id=>!original.has(id)))
    fail('A selected voucher did not fund this registration');
  if(Object.values(requested).some(value=>value==null))fail('A selected voucher refund amount is missing');
  const ownParts=own?.voucher_plan?.filter(p=>p.source===booking.booking_source&&p.bookingId===booking.booking_id);
  if(own&&(!Array.isArray(ownParts)||ownParts.reduce((sum,p)=>sum+integer(p.amountMinor),0)!==integer(defaults.voucherMinor)))
    fail('Original reserved voucher choices are missing');
  selected.voucherAmounts={};
  for(const [id,amount] of original){
    const available=integer(amount-(voucherUsed.get(id)||0));
    const saved=ownParts?.filter(p=>p.voucherId===id).reduce((sum,p)=>sum+integer(p.amountMinor),0);
    const value=requested[id]==null?(saved??available):money(requested[id]);
    if(value>available)fail('Selected voucher refund exceeds its remaining original share');
    selected.voucherAmounts[id]=value;
  }
  selected.voucherMinor=Object.values(selected.voucherAmounts).reduce((sum,value)=>sum+value,0);
  for(const field of fields){
    integer(selected[field]);
    if(selected[field]>remaining[field])fail('Refund exceeds its remaining purchased allocation');
    if(prior&&selected[field]!==integer(defaults[field]))fail('Approved refund amounts cannot change on retry');
  }
  if(ownParts&&ownParts.some(part=>selected.voucherAmounts[part.voucherId]!==part.amountMinor))
    fail('Approved voucher choices cannot change on retry');
  return selected;
}
