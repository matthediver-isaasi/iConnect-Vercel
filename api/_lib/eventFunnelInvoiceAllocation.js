// Private accounting preparation only. Never charge a provider or reinterpret
// mutable event settings here. Delivery must use these per-event allocations,
// not apply the entire aggregate PaymentIntent to each invoice.
const fail=()=>{throw Object.assign(new Error('The shared checkout accounting evidence is inconsistent.'),{code:'FUNNEL_INVOICE_EVIDENCE_INVALID'});};
const money=value=>{
  if(typeof value==='string' && /^\d+$/.test(value)) value=Number(value);
  if(!Number.isSafeInteger(value)||value<0) fail();
  return value;
};
const uuid=value=>{
  if(typeof value!=='string'||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) fail();
  return value.toLowerCase();
};
const sum=values=>values.reduce((total,value)=>money(total+money(value)),0);
const currency=value=>{
  if(typeof value!=='string'||!/^[A-Za-z]{3}$/.test(value)) fail();
  return value.toUpperCase();
};

export function buildFunnelInvoiceAllocations({order,allocations}) {
  if(order?.state!=='confirmed'||!Array.isArray(allocations)) fail();
  const plan=order.snapshot,orderId=uuid(order.id),tenantId=uuid(order.tenant_id);
  if(plan?.version!==1||!['per_event','consolidated'].includes(plan.invoiceMode)
    ||!Array.isArray(plan.lines)||!plan.lines.length||!plan.invoiceCustomer
    ||plan.paymentMethod!==order.payment_method||currency(plan.currency)!==currency(order.currency)) fail();
  const payableMinor=money(order.payable_minor);
  if(payableMinor!==money(plan.payableMinor)) fail();
  const card=order.payment_method==='card';
  if(card) {
    const payment=order.verified_payment;
    if(!order.payment_intent_id||payment?.id!==order.payment_intent_id||payment.status!=='succeeded'
      ||money(payment.amount)!==payableMinor||money(payment.amountReceived)!==payableMinor
      ||currency(payment.currency)!==currency(order.currency)
      ||!['live','test'].includes(plan.paymentAuthority?.mode)
      ||payment.livemode!==(plan.paymentAuthority.mode==='live')) fail();
  } else if(!['account','public_invoice_po','free'].includes(order.payment_method)||plan.submissionAccepted!==true
    ||order.payment_method==='free'&&payableMinor!==0) fail();
  const byBooking=new Map();
  for(const row of allocations) {
    if(uuid(row.tenant_id)!==tenantId||uuid(row.order_id)!==orderId) fail();
    const key=`${row.booking_source}:${uuid(row.booking_id)}`;
    if(byBooking.has(key)) fail();
    byBooking.set(key,row);
  }
  const events=new Map(),consumed=new Set();
  for(const line of plan.lines) {
    if(!['simple','complex'].includes(line.eventKind)||!Array.isArray(line.registrations)||!line.registrations.length) fail();
    const eventId=uuid(line.eventId),source=line.eventKind==='simple'?'booking':'complex_event_booking';
    const key=`${line.eventKind}:${eventId}`;
    const group=events.get(key)||{key,eventKind:line.eventKind,eventId,bookingSource:source,
      bookingIds:[],registrationLines:[],grossMinor:0,payableMinor:0,trainingFundMinor:0,voucherMinor:0};
    for(const booking of line.registrations) {
      const bookingId=uuid(booking.id),bookingKey=`${source}:${bookingId}`,row=byBooking.get(bookingKey);
      if(!row||consumed.has(bookingKey)||uuid(row.event_id)!==eventId
        ||row.node_id!==line.nodeId||row.ticket_id!==line.ticketId) fail();
      for(const [stored,snapshot] of [['gross_minor','grossMinor'],['payable_minor','payableMinor'],
        ['training_fund_minor','trainingFundMinor'],['voucher_minor','voucherMinor'],['places','places']]) {
        if(money(row[stored])!==money(booking[snapshot])) fail();
      }
      if(money(booking.grossMinor)!==sum([booking.payableMinor,booking.trainingFundMinor,booking.voucherMinor])) fail();
      consumed.add(bookingKey);group.bookingIds.push(bookingId);
    }
    for(const [field,amount] of [['grossMinor',line.amountMinor],['payableMinor',line.payableMinor],
      ['trainingFundMinor',line.trainingFundMinor],['voucherMinor',line.voucherMinor]]) {
      if(sum(line.registrations.map(row=>row[field]))!==money(amount)) fail();
      group[field]=sum([group[field],amount]);
    }
    group.registrationLines.push(structuredClone(line));events.set(key,group);
  }
  if(consumed.size!==byBooking.size||sum([...events.values()].map(row=>row.payableMinor))!==payableMinor
    ||sum([...events.values()].map(row=>row.trainingFundMinor))!==money(plan.trainingFundMinor)
    ||sum([...events.values()].map(row=>row.voucherMinor))!==money(plan.voucherMinor)) fail();
  const groups=[...events.values()].sort((a,b)=>a.key.localeCompare(b.key));
  const invoiceGroups=plan.invoiceMode==='consolidated'?[groups]:groups.map(group=>[group]);
  return invoiceGroups.map(items=>{
    const amountMinor=sum(items.map(row=>row.payableMinor));
    return {
      key:`event-funnel-invoice:${orderId}:${plan.invoiceMode==='consolidated'?'all':items[0].key}`,
      tenantId,orderId,invoiceMode:plan.invoiceMode,currency:currency(order.currency),
      amountMinor,applicable:amountMinor>0,paymentMethod:order.payment_method,
      contact:structuredClone(plan.invoiceCustomer),events:structuredClone(items),
      settlement:card&&amountMinor>0?{kind:'event_funnel_allocation',paymentIntentId:order.payment_intent_id,
        chargeAmountMinor:payableMinor,amountMinor,
        // A consolidated invoice still preserves each event's share.
        allocations:items.map(row=>({eventKind:row.eventKind,eventId:row.eventId,amountMinor:row.payableMinor}))}:null,
    };
  });
}
