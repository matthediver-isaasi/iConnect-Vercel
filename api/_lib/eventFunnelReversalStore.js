/** Bind every financial write to the already-authorized immutable operation. */
export function createFunnelCardReversalStore({db,tenantId,orderId,operationId}) {
  if(!db?.rpc||[tenantId,orderId,operationId].some(id=>typeof id!=='string'||!id))
    throw new Error('A complete reversal identity is required');
  async function call(id,action,receipt=null) {
    if(id!==operationId)throw new Error('Reversal identity changed');
    const result=await db.rpc('event_funnel_reversal_card',{
      p_tenant:tenantId,p_order:orderId,p_id:operationId,p_action:action,p_receipt:receipt,
    });
    if(result.error||typeof result.data!=='boolean')throw new Error('Reversal evidence could not be persisted');
    return result.data;
  }
  return {
    begin:id=>call(id,'begin'),
    complete:async(id,receipt)=>{
      if(await call(id,'complete',receipt)!==true)throw new Error('Refund receipt conflicts with recorded evidence');
    },
  };
}
