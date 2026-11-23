import {randomUUID} from 'node:crypto';
import {assertStandaloneEventOffer} from './eventFunnelPurchasePolicy.js';
const absent=error=>['42883','PGRST202'].includes(error?.code);
const fail=()=>{throw Object.assign(new Error('Payment preparation is unavailable. Do not submit another payment.'),{statusCode:503});};

// Only for previously unrecorded, standalone event PaymentIntent creation.
// Existing unified/address-policy/public-purchase idempotency remains untouched.
// This evidence never substitutes for verified payment or purchaser ownership.
export async function createFunnelGuardedLegacyIntent({db,stripe,tenantId,eventKind,eventId,ticketIds,parameters},
  {newId=randomUUID}={}) {
  parameters={...parameters,currency:String(parameters?.currency||'').toLowerCase()};
  const id=newId();
  const prepared=await db.rpc('event_funnel_prepare_legacy_intent',{p_tenant:tenantId,p_id:id,p_kind:eventKind,
    p_event:eventId,p_tickets:[...new Set(ticketIds)],p_parameters:parameters});
  if(absent(prepared.error)) {
    const readiness=await db.rpc('event_funnel_readiness');
    if(!absent(readiness.error) && (readiness.error||readiness.data?.version!==1
      ||readiness.data.purchasing!==false||readiness.data.legacyIntentAuthorityInstalled===true)) fail();
    await assertStandaloneEventOffer({db,tenantId,eventKind,eventId,ticketIds});
    return stripe.paymentIntents.create(parameters);
  }
  if(prepared.error?.code==='PT403') throw Object.assign(new Error('This ticket requires its source registration in the same checkout.'),{statusCode:403});
  const authority=prepared.data;
  if(prepared.error||authority?.id!==id||!authority.request_hash
    ||authority.provider_request?.metadata?.event_funnel_legacy_authority_id!==id) fail();
  const payment=authority.payment_intent_id
    ? await stripe.paymentIntents.retrieve(authority.payment_intent_id)
    : await stripe.paymentIntents.create(authority.provider_request,{idempotencyKey:`event-access:${tenantId}:${id}`});
  if(!payment?.id||payment.metadata?.event_funnel_legacy_authority_id!==id
    ||payment.amount!==authority.provider_request.amount||payment.currency!==authority.provider_request.currency) fail();
  const bound=await db.rpc('event_funnel_bind_legacy_intent',{p_tenant:tenantId,p_id:id,
    p_hash:authority.request_hash,p_intent:payment.id});
  if(bound.error||bound.data!==true) fail();
  return payment;
}
