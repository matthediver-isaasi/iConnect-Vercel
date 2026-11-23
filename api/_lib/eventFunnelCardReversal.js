const review=reason=>({status:'needs_review',reason});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
/**
 * A claimed, server-owned reversal operation is required. The store owns the
 * durable write barrier; its begin() must atomically reject a second writer.
 * Provider listing must return the complete refund set, never one page.
 */
export async function recoverFunnelCardReversal({operation,store,provider}) {
  const op=operation;
  if(!op?.id||!op.orderId||!op.tenantId||!op.paymentIntentId||!op.chargeId
    ||!op.authority||typeof op.currency!=='string'||!/^[A-Z]{3}$/i.test(op.currency)
    ||!integer(op.amountMinor)||!integer(op.chargeAmountMinor)
    ||op.amountMinor>op.chargeAmountMinor||!['reserved','writing','complete'].includes(op.state)
    ||!Array.isArray(op.knownRefunds))return review('invalid_operation');
  if(op.amountMinor===0)return {status:'not_applicable'};
  if(op.state==='complete')return {status:'complete'};
  const authority=await provider.authority();
  if(authority.accountFingerprint!==op.authority.accountFingerprint||authority.mode!==op.authority.mode
    ||!authority.accountFingerprint||!['test','live'].includes(authority.mode))return review('payment_authority_changed');
  const charge=await provider.retrieveCharge(op.chargeId);
  if(charge.id!==op.chargeId||charge.payment_intent!==op.paymentIntentId||charge.amount!==op.chargeAmountMinor
    ||charge.currency?.toUpperCase()!==op.currency?.toUpperCase()
    ||charge.livemode!==(authority.mode==='live')||charge.paid!==true||charge.captured!==true
    ||!integer(charge.amount_refunded))return review('charge_evidence_mismatch');
  const listing=await provider.listAllRefunds(op.chargeId);
  if(listing?.complete!==true||!Array.isArray(listing.refunds))return {status:'retry',reason:'incomplete_refund_listing'};
  const known=new Map(),seen=new Set();
  for(const receipt of op.knownRefunds) {
    if(!receipt?.id||known.has(receipt.id)||!integer(receipt.amountMinor))return review('invalid_refund_history');
    known.set(receipt.id,receipt);
  }
  let matched=null,refunded=0;
  for(const refund of listing.refunds) {
    if(!refund?.id||seen.has(refund.id)||refund.charge!==op.chargeId||refund.payment_intent!==op.paymentIntentId
      ||refund.currency?.toUpperCase()!==op.currency?.toUpperCase()||!integer(refund.amount))
      return review('refund_evidence_mismatch');
    seen.add(refund.id);
    if(!['succeeded','pending','requires_action','failed','canceled'].includes(refund.status))return review('unknown_refund_state');
    if(refund.status==='succeeded')refunded+=refund.amount;
    if(!integer(refunded))return review('invalid_refund_total');
    if(refund.metadata?.event_funnel_reversal===op.id) {
      if(matched||refund.amount!==op.amountMinor)return review('ambiguous_operation_refund');
      matched=refund;
    } else {
      const receipt=known.get(refund.id);
      if(!receipt||receipt.amountMinor!==refund.amount||receipt.status!==refund.status)
        return review('unallocated_provider_refund');
    }
  }
  if([...known.keys()].some(id=>!seen.has(id))||refunded!==charge.amount_refunded)return {status:'retry',reason:'refund_history_not_reconciled'};
  if(matched) {
    if(matched.status==='succeeded') {
      await store.complete(op.id,{id:matched.id,amountMinor:matched.amount,currency:matched.currency});
      return {status:'complete'};
    }
    return matched.status==='pending'?{status:'retry',reason:'refund_pending'}:review('refund_requires_attention');
  }
  // An empty listing is not proof that a prior timed-out POST never arrived.
  if(op.state==='writing')return review('refund_submission_uncertain');
  if(listing.refunds.some(r=>['pending','requires_action'].includes(r.status)))return {status:'retry',reason:'other_refund_pending'};
  if(op.amountMinor>charge.amount-charge.amount_refunded)return review('insufficient_charge_balance');
  if(provider.canWrite&&!provider.canWrite())return {status:'retry',reason:'write_budget_exhausted'};
  if(await store.begin(op.id)!==true)return {status:'retry',reason:'write_not_claimed'};
  let refund;
  try {
    refund=await provider.createRefund({charge:op.chargeId,amount:op.amountMinor,
      metadata:{event_funnel_reversal:op.id,event_funnel_order:op.orderId}},
    {idempotencyKey:`event-funnel-reversal:${op.id}`});
  } catch {
    return review('refund_submission_uncertain');
  }
  if(refund?.id&&refund.charge===op.chargeId&&refund.payment_intent===op.paymentIntentId
    &&refund.amount===op.amountMinor&&refund.currency?.toUpperCase()===op.currency?.toUpperCase()
    &&refund.metadata?.event_funnel_reversal===op.id&&refund.status==='succeeded') {
    await store.complete(op.id,{id:refund.id,amountMinor:refund.amount,currency:refund.currency});
    return {status:'complete'};
  }
  return {status:'retry',reason:'refund_receipt_pending'};
}
