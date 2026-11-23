import {buildFunnelInvoiceAllocations} from './eventFunnelInvoiceAllocation.js';
const legs=['cardMinor','invoiceMinor','trainingFundMinor','voucherMinor'];
const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_REVERSAL_EVIDENCE_INVALID'});};
function minor(value) {
  if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);
  if(!Number.isSafeInteger(value)||value<0)fail('Invalid reversal amount');
  return value;
}
const sum=values=>values.reduce((a,b)=>minor(a+minor(b)),0);
function key(item) {
  if(!['booking','complex_event_booking'].includes(item?.source)||typeof item.id!=='string')fail('Invalid registration selection');
  return `${item.source}:${item.id.toLowerCase()}`;
}

/** Exact proportional allocation, capped at each original recipient's share.
 * No floating-point products: large totals and penny remainders stay exact.
 */
export function allocateFunnelMinor(total,caps) {
  total=minor(total);caps=caps.map(minor);
  const maximum=sum(caps);
  if(total>maximum)fail('Requested reversal exceeds the selected remaining amount');
  if(!maximum)return caps.map(()=>0);
  const denominator=BigInt(maximum),amount=BigInt(total);
  const parts=caps.map((cap,index)=>({index,value:Number(amount*BigInt(cap)/denominator),
    remainder:amount*BigInt(cap)%denominator}));
  let remainder=total-sum(parts.map(p=>p.value));
  for(const part of [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)) {
    if(!remainder)break;
    if(part.value<caps[part.index]){part.value++;remainder--;}
  }
  if(remainder)fail('Reversal allocation did not balance');
  return parts.map(p=>p.value);
}

/** Private arithmetic authority, not permission to cancel or call a provider.
 * History must be the complete server-owned operation ledger for this order.
 * Uncertain, pending and completed effects all consume the same limits.
 * Provider-side refunds outside that ledger must still be reconciled before
 * execution; this arithmetic does not assert that none have occurred.
 */
export function funnelReversalLimits({order,allocations,selected,history}) {
  const invoices=buildFunnelInvoiceAllocations({order,allocations});
  if(!Array.isArray(selected)||!selected.length||!Array.isArray(history))fail('A complete reversal scope is required');
  const all=new Map();
  for(const invoice of invoices)for(const event of invoice.events)for(const line of event.registrationLines)
    for(const booking of line.registrations) {
      const item={source:event.bookingSource,id:booking.id,eventId:event.eventId,nodeId:line.nodeId,ticketId:line.ticketId,
        invoiceKey:invoice.key,places:booking.places,cardMinor:order.payment_method==='card'?minor(booking.payableMinor):0,
        invoiceMinor:invoice.applicable?minor(booking.payableMinor):0,
        trainingFundMinor:minor(booking.trainingFundMinor),voucherMinor:minor(booking.voucherMinor)};
      all.set(key(item),item);
    }
  const original=new Map([...all].map(([identity,item])=>[identity,{...item}]));
  const operationIds=new Set();
  for(const operation of history) {
    if(typeof operation?.id!=='string'||!operation.id||operationIds.has(operation.id)||operation.tenant_id!==order.tenant_id||operation.order_id!==order.id
      ||!['reserved','processing','retry','needs_review','complete','released'].includes(operation.state)
      ||!Array.isArray(operation.allocations)||!operation.allocations.length)fail('Reversal history is incomplete or inconsistent');
    operationIds.add(operation.id);
    const consumed=new Set();
    for(const usage of operation.allocations) {
      const identity=key(usage),item=all.get(identity);
      if(!item||consumed.has(identity))fail('Reversal history contains an unrelated or repeated registration');
      consumed.add(identity);
      for(const leg of legs) {
        const amount=minor(usage[leg]);
        if(amount>original.get(identity)[leg])fail('Recorded reversal exceeds its purchased allocation');
        if(operation.state==='released')continue;
        if(amount>item[leg])fail('Recorded reversals exceed the original purchased amount');
        item[leg]-=amount;
      }
    }
  }
  const keys=selected.map(key);
  if(new Set(keys).size!==keys.length||keys.some(id=>!all.has(id)))fail('Selected registration does not belong to this checkout');
  const items=keys.sort().map(id=>({...all.get(id)}));
  return {version:1,tenantId:order.tenant_id,orderId:order.id,currency:invoices[0].currency,
    invoiceMode:order.snapshot.invoiceMode,items,
    limits:Object.fromEntries(legs.map(leg=>[leg,sum(items.map(item=>item[leg]))]))};
}

/** The caller chooses amounts using existing cancellation policy/UI. This
 * helper deliberately invents no refund defaults, fees or credit eligibility.
 */
export function allocateFunnelReversal(input,requested) {
  if(!requested||Object.keys(requested).length!==legs.length||legs.some(leg=>!Object.hasOwn(requested,leg)))
    fail('Each reversal amount must be explicit');
  const result=funnelReversalLimits(input);
  const amounts=Object.fromEntries(legs.map(leg=>[leg,minor(requested[leg])]));
  const shares=Object.fromEntries(legs.map(leg=>[leg,allocateFunnelMinor(amounts[leg],result.items.map(item=>item[leg]))]));
  return {...result,requested:amounts,items:result.items.map((item,index)=>({
    ...item,...Object.fromEntries(legs.map(leg=>[leg,shares[leg][index]])),
  }))};
}
