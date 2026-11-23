import {recoverFunnelReversal} from './eventFunnelReversalRecovery.js';
const legs=['card','training','voucher','credit'];
/** Server-only single leased operation. Scheduling and tenant activation remain
 * separate from this runner; a browser closing cannot discard its durable job.
 */
export async function runFunnelReversalWorker({db,tenantId=null,operationId=null,deadlineAt=Date.now()+45000,
  recover=recoverFunnelReversal}){
  if(deadlineAt-Date.now()<2000)return {status:'budget_exhausted'};
  const claimed=await db.rpc('event_funnel_reversal_claim',{p_tenant:tenantId,p_id:operationId});
  if(claimed.error)throw new Error('Cancellation recovery claim unavailable');
  const job=claimed.data;
  if(job==null)return {status:'idle'};
  if(!job.id||!job.tenant_id||!job.order_id||!job.lease_id
    ||(tenantId&&job.tenant_id!==tenantId)||(operationId&&job.id!==operationId))
    throw new Error('Cancellation recovery claim scope changed');
  let result;
  try{
    result=await recover({db,tenantId:job.tenant_id,orderId:job.order_id,operationId:job.id,deadlineAt});
  }catch{result={outcomes:{}};}
  const outcomes=Object.fromEntries([...legs,...(job.requires_cleanup?['cleanup']:[])].map(key=>[key,
    ['complete','not_applicable','retry','needs_review'].includes(result?.outcomes?.[key]?.status)?
      result.outcomes[key].status:'retry']));
  const saved=await db.rpc('event_funnel_reversal_finish',{p_tenant:job.tenant_id,p_order:job.order_id,p_id:job.id,
    p_lease:job.lease_id,p_outcomes:outcomes});
  if(saved.error)throw new Error('Cancellation recovery outcome requires reconciliation');
  if(saved.data!==true)return {status:'lease_lost',operationId:job.id};
  return {status:Object.values(outcomes).includes('retry')?'retry':
    Object.values(outcomes).includes('needs_review')?'needs_review':'complete',operationId:job.id,outcomes};
}
