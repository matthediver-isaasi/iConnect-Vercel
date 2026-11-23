const absent=error=>['42883','PGRST202'].includes(error?.code);
const unavailable=()=>{throw Object.assign(new Error('Event purchase eligibility could not be verified.'),{
  statusCode:503,code:'EVENT_OFFER_POLICY_UNAVAILABLE',
});};
/**
 * New standalone authorizations only. Do not apply to an already frozen
 * payable attempt: its verified original authority must be resolved first.
 * This is not the aggregate same-checkout authorization/conversion guard.
 */
export async function assertStandaloneEventOffer({db,tenantId,eventKind,eventId,ticketIds}) {
  if(!['simple','complex'].includes(eventKind) || !Array.isArray(ticketIds)
    || ticketIds.length>100 || ticketIds.some(id=>typeof id!=='string'||!id)) unavailable();
  const result=await db.rpc('event_funnel_standalone_offer_allowed',{
    p_tenant:tenantId,p_kind:eventKind,p_event:eventId,p_tickets:[...new Set(ticketIds)],
  });
  if(absent(result.error)) {
    const readiness=await db.rpc('event_funnel_readiness');
    // An empty pre-feature schema is different from a missing reader on an
    // activated schema. The latter must never reopen restricted ticket sales.
    if(absent(readiness.error)) return;
    if(!readiness.error && readiness.data?.version===1 && readiness.data.purchasing===false
      && readiness.data.purchasePolicyInstalled!==true) return;
    unavailable();
  }
  if(result.error || typeof result.data!=='boolean') unavailable();
  if(!result.data) throw Object.assign(new Error('This ticket requires its source registration in the same checkout.'),{
    statusCode:403,code:'FUNNEL_PREREQUISITE_REQUIRED',
  });
}
