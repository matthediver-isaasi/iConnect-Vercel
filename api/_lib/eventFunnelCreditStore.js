export function createFunnelCreditStore({db,tenantId,orderId,jobId}) {
  if(!db?.rpc||[tenantId,orderId,jobId].some(id=>typeof id!=='string'||!id))throw new Error('Credit scope is required');
  async function call(id,action,value=null){
    if(id!==jobId)throw new Error('Credit identity changed');
    const result=await db.rpc('event_funnel_credit_operation',{
      p_tenant:tenantId,p_order:orderId,p_id:jobId,p_action:action,p_value:value,
    });
    if(result.error||typeof result.data!=='boolean')throw new Error('Credit journal unavailable');
    return result.data;
  }
  return {prepare:(id,plan)=>call(id,'prepare',plan),begin:id=>call(id,'begin'),
    beginAllocation:(id,amountMinor)=>call(id,'allocate',{amountMinor}),
    complete:(id,receipt)=>call(id,'complete',receipt)};
}
