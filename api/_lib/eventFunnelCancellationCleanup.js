import {deliverFunnelCancellationNotifications} from './eventFunnelCancellationNotifications.js';
import {recoverFunnelZoomRevocation} from './eventFunnelZoomRevocation.js';
import {deliverFunnelCreditEmails} from './eventFunnelCreditEmail.js';
/** Notifications have a private write barrier; only the database attests completion. */
export async function recoverFunnelCancellationCleanup({db,context,deadlineAt,notifications=deliverFunnelCancellationNotifications,
  providers=recoverFunnelZoomRevocation,creditEmails=deliverFunnelCreditEmails}) {
  const {operation,order}=context||{};
  if(!operation?.lease_id)return {status:'needs_review'};
  if(!order||operation.tenant_id!==order.tenant_id||operation.order_id!==order.id)
    throw new Error('Cancellation cleanup scope changed');
  const outcomes=[];
  // Provider or mail outages cannot starve the other independent cleanup legs.
  for(const work of [notifications,providers,creditEmails]){
    try{outcomes.push((await work({db,context,deadlineAt}))?.status||'needs_review');}
    catch{outcomes.push('retry');}
  }
  if(outcomes.includes('retry'))return {status:'retry'};
  if(outcomes.some(status=>!['complete','not_applicable'].includes(status)))return {status:'needs_review'};
  const result=await db.rpc('event_funnel_cancellation_cleanup_quiet',{
    p_tenant:order.tenant_id,p_order:order.id,p_id:operation.id,p_lease:operation.lease_id});
  if(result.error){
    if(['42883','PGRST202'].includes(result.error.code))return {status:'needs_review'};
    throw new Error('Cancellation cleanup could not be verified');
  }
  if(result.data?.operationId!==operation.id||!['complete','needs_review'].includes(result.data?.status))
    throw new Error('Cancellation cleanup result changed');
  if(result.data.status==='complete'&&result.data.receipt?.version!==1)
    throw new Error('Cancellation cleanup receipt unavailable');
  return {status:result.data.status};
}
