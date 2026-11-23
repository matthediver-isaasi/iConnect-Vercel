import {createFunnelStripeProvider} from './eventFunnelStripe.js';
import {createFunnelCardReversalStore} from './eventFunnelReversalStore.js';
import {recoverFunnelCardReversal} from './eventFunnelCardReversal.js';
import {recoverFunnelVoucherReversal} from './eventFunnelVoucherReversal.js';
import {recoverFunnelInvoiceCredits} from './eventFunnelCreditRecovery.js';
import {recoverFunnelCancellationCleanup} from './eventFunnelCancellationCleanup.js';

/** Server-only recovery of an already reserved, authorized cancellation.
 * Accounting delivery is independent of card and original-owner funding.
 * Both accounting providers use the allocation-aware credit adapter. Explicitly
 * disabling it prevents cancellation; legacy whole-invoice reversal is never a fallback.
 */
export async function recoverFunnelReversal({db,tenantId,orderId,operationId,deadlineAt=Date.now()+45000,
  providerFor=createFunnelStripeProvider({tenantId,deadlineAt}),recoverCredit=recoverFunnelInvoiceCredits,
  recoverCard=recoverFunnelCardReversal,recoverVoucher=recoverFunnelVoucherReversal,
  recoverCleanup=recoverFunnelCancellationCleanup}) {
  const scope={p_tenant:tenantId,p_order:orderId};
  async function read(){
    const result=await db.rpc('event_funnel_reversal_context',scope);
    if(result.error||!result.data?.order||!Array.isArray(result.data.history))throw new Error('Original reversal authority unavailable');
    const operation=result.data.history.find(r=>r.id===operationId);
    if(!operation||operation.tenant_id!==tenantId||operation.order_id!==orderId||operation.state==='released'
      ||result.data.order.id!==orderId||result.data.order.tenant_id!==tenantId||!Array.isArray(operation.allocations))
      throw new Error('Reversal scope unavailable');
    return {...result.data,operation};
  }
  let context=await read();
  const amount=key=>context.operation.allocations.reduce((sum,item)=>{
    if(!Number.isSafeInteger(item[key])||item[key]<0||!Number.isSafeInteger(sum+item[key]))
      throw new Error('Original reversal amounts unavailable');
    return sum+item[key];
  },0);
  const amounts={card:amount('cardMinor'),credit:amount('invoiceMinor'),training:amount('trainingFundMinor'),voucher:amount('voucherMinor')};
  if(amounts.voucher&&(!context.operation.refund_options||typeof context.operation.refund_options!=='object'
    ||Array.isArray(context.operation.refund_options)))throw new Error('Original approved voucher refund options are missing');
  if(amounts.credit&&typeof recoverCredit!=='function')
    throw new Error('Allocation-aware accounting credit recovery is required before cancellation');
  if(!context.operation.cancelled_at){
    const cancelled=await db.rpc('event_funnel_reversal_cancel',{...scope,p_id:operationId});
    if(cancelled.error||!Array.isArray(cancelled.data))throw new Error('Cancellation was not committed');
    context=await read();
    if(!context.operation.cancelled_at)throw new Error('Cancellation commit requires reconciliation');
  }
  const outcomes={};
  async function attempt(name,work){
    if(Date.now()>=deadlineAt-1000){outcomes[name]={status:'retry'};return;}
    try {
      const result=await work();
      outcomes[name]=['complete','not_applicable','retry','needs_review'].includes(result?.status)
        ?result:{status:'needs_review'};
    } catch {outcomes[name]={status:'retry'};}
  }
  await attempt('card',async()=>{
    if(!amounts.card)return {status:'not_applicable'};
    const {order,operation,history}=context;
    if(operation.card_state==='complete')return {
      status:operation.card_receipt?.id&&operation.card_receipt.amountMinor===amounts.card
        &&operation.card_receipt.currency?.toUpperCase()===order.currency?.toUpperCase()?'complete':'needs_review',
    };
    const provider=await providerFor(order.snapshot.paymentAuthority);
    return recoverCard({provider,store:createFunnelCardReversalStore({db,tenantId,orderId,operationId}),
      operation:{id:operationId,tenantId,orderId,state:operation.card_state,amountMinor:amounts.card,
        chargeAmountMinor:Number(order.payable_minor),paymentIntentId:order.payment_intent_id,
        chargeId:order.verified_payment?.capturedCharge?.id,currency:order.currency,authority:order.snapshot.paymentAuthority,
        knownRefunds:history.filter(r=>r.id!==operationId&&r.card_receipt).map(r=>({...r.card_receipt,status:'succeeded'}))}});
  });
  await attempt('training',async()=>{
    const result=await db.rpc('event_funnel_reversal_training',{...scope,p_id:operationId});
    if(result.error||result.data?.amountMinor!==amounts.training)throw new Error('Funding restoration requires recovery');
    return {status:'complete'};
  });
  await attempt('voucher',()=>recoverVoucher({db,operation:context.operation}));
  await attempt('credit',()=>amounts.credit?recoverCredit({db,context,deadlineAt}):{status:'not_applicable'});
  if(context.operation.requires_cleanup)await attempt('cleanup',()=>typeof recoverCleanup==='function'
    ?recoverCleanup({db,context,deadlineAt}):{status:'needs_review'});
  const states=Object.values(outcomes).map(r=>r.status);
  return {status:states.includes('retry')?'retry':states.includes('needs_review')?'needs_review':'complete',outcomes};
}
