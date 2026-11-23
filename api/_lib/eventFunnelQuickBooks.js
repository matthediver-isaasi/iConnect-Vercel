import {processAccountingRequest} from './accountingRequestQueue.js';

/** Handoff/readback uses the original saved key; caller data never supplies a
 * provider company, invoice contents or a settlement amount. */
export async function deliverFunnelQuickBooks({db,job,key,deadlineAt,
  processRequest=processAccountingRequest}) {
  const scope={p_tenant:job.tenant_id,p_order:job.order_id,p_token:job.lease_token,p_key:key};
  const handoff=async()=>{
    const result=await db.rpc('event_funnel_quickbooks_handoff',scope);
    if(result.error||!['complete','needs_review','pending','not_applicable'].includes(result.data?.status)) {
      throw new Error('Original QuickBooks invoice handoff requires retry');
    }
    return result.data;
  };
  const original=await handoff();
  if(original.status!=='pending') return original;
  if(!original.requestId) throw new Error('Original QuickBooks request is missing');
  await processRequest({db,requestId:original.requestId,deadlineAt});
  // Queue success alone is not evidence that every participating booking was
  // linked. Read back the dedicated durable handoff contract.
  return handoff();
}
