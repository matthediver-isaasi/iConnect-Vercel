import { createFunnelOrderStore } from './eventFunnelOrderStore.js';
import { createFunnelPaymentService } from './eventFunnelPayment.js';
import { createFunnelStripeProvider } from './eventFunnelStripe.js';

export function createFunnelRecoveryPaymentAdapter({db,tenantId,providerFor=createFunnelStripeProvider({tenantId})}) {
  const store=createFunnelOrderStore({db,tenantId,finalize:async ({orderId,evidence})=>{
    const result=await db.rpc('event_funnel_finalize_order',{p_tenant:tenantId,p_order:orderId,p_evidence:evidence});
    if(result.error || result.data?.state!=='confirmed') throw new Error('Original registration commit requires retry');
    return result.data;
  }});
  return {store,service:createFunnelPaymentService({store,providerFor})};
}

/**
 * A bounded, leased sweep. Payment recovery never depends on invoice delivery.
 * Adapter failures retain financial authority and stock; no error payload from
 * a provider is persisted or returned to the caller.
 */
export async function recoverEventFunnelOrders({db,paymentFor,
  limit=8,budgetMs=30000,now=()=>Date.now()}={}) {
  if(typeof paymentFor!=='function' || !Number.isInteger(limit) || limit<1 || limit>20
    || !Number.isFinite(budgetMs) || budgetMs<1000 || budgetMs>45000) throw new Error('Invalid funnel recovery configuration');
  const deadline=now()+budgetMs;
  const result={checked:0,confirmed:0,cancelled:0,pending:0,retry:0};
  // Claim one item at a time so a depleted time budget cannot strand a batch.
  for(let index=0;index<limit && now()<deadline-1000;index++) {
    const claim=await db.rpc('event_funnel_recovery_claim',{p_limit:1});
    if(claim.error || !Array.isArray(claim.data)) throw new Error('Funnel recovery queue unavailable');
    const order=claim.data[0];if(!order) break;
    result.checked++;
    try {
      const {service,store}=await paymentFor(order.tenant_id);
      let outcome;
      const expiry=Date.parse(order.snapshot?.reservationExpiresAt);
      const expired=Number.isFinite(expiry) && expiry<=now();
      if(order.payment_method==='card' && !order.payment_request && !order.payment_intent_id && !expired) {
        outcome={state:'pending'};
      } else {
        outcome=await service.reconcile(order);
        if(expired && order.payment_method==='card' && !['confirmed','cancelled','failed'].includes(outcome.state)) {
          const current=await store.read(order.id);
          // An unknown provider-create result must first bind its original PI.
          // If that is still uncertain, cancel() retains stock rather than
          // treating the absence of a local ID as evidence of no payment.
          outcome=await service.cancel(current);
        }
      }
      if(outcome.state==='confirmed') result.confirmed++;
      else if(outcome.state==='cancelled') result.cancelled++;
      else result.pending++;
    } catch {
      result.retry++;
    } finally {
      const finished=await db.rpc('event_funnel_recovery_finish',{
        p_tenant:order.tenant_id,p_order:order.id,p_token:order.lease_token});
      if(finished.error || finished.data!==true) throw new Error('Funnel recovery lease completion unavailable');
    }
  }
  return result;
}

export async function deliverEventFunnelOrders({db,kind,deliver,limit=8,budgetMs=30000,now=()=>Date.now()}={}) {
  if(!['invoices','confirmations','integrations'].includes(kind) || typeof deliver!=='function'
    || !Number.isInteger(limit) || limit<1 || limit>20 || !Number.isFinite(budgetMs) || budgetMs<1000 || budgetMs>45000) {
    throw new Error('Invalid funnel delivery configuration');
  }
  const deadline=now()+budgetMs,result={checked:0,delivered:0,retry:0,needs_review:0};
  for(let index=0;index<limit && now()<deadline-1000;index++) {
    const claim=await db.rpc('event_funnel_delivery_claim',{p_kind:kind,p_limit:1});
    if(claim.error || !Array.isArray(claim.data)) throw new Error('Funnel delivery queue unavailable');
    const job=claim.data[0];if(!job) break;
    result.checked++;
    let status='retry';
    try {
      // The adapter must establish its own provider idempotency/ambiguity
      // barrier. A lease is not proof that an external effect was delivered.
      const outcome=await deliver(job,{deadlineAt:deadline});
      if(['delivered','needs_review'].includes(outcome?.status)) status=outcome.status;
    } catch {}
    const finished=await db.rpc('event_funnel_delivery_finish',{
      p_tenant:job.tenant_id,p_order:job.order_id,p_kind:kind,p_token:job.lease_token,p_status:status});
    if(finished.error || finished.data!==true) throw new Error('Funnel delivery lease completion unavailable');
    result[status]++;
  }
  return result;
}
