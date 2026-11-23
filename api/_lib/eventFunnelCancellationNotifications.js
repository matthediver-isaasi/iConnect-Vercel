const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function buildFunnelCancellationMessage(job,tenantId) {
  if(job.tenant_id!==tenantId||!job.recipient||!job.booking_id||!job.booking_source)
    throw new Error('Cancellation message scope unavailable');
  const reference=job.booking?.booking_reference||job.booking?.booking_group_reference||job.booking_id;
  // This confirms cancellation only. Refunds and accounting can still be
  // recovering independently, so do not describe approved amounts as refunded.
  return {tenantId,to:job.recipient,subject:'Booking cancellation approved',
    html:`<p>Your event registration has been cancelled.</p><p>Booking reference: ${escape(reference)}</p>`+
      '<p>Any approved refund or credit is handled separately. This message does not confirm that a refund has completed.</p>'};
}
export async function deliverFunnelCancellationNotifications({db,context,deadlineAt=Date.now()+15000,send,now=()=>Date.now()}){
  const {order,operation}=context;
  const call=async(action,message=null,payload=null)=>{
    const result=await db.rpc('event_funnel_cancellation_message_operation',{p_tenant:order.tenant_id,
      p_order:order.id,p_id:operation.id,p_lease:operation.lease_id,p_action:action,p_message:message,p_payload:payload});
    if(['42883','PGRST202'].includes(result.error?.code))return {status:'needs_review',jobs:[]};
    if(result.error||!result.data)throw new Error('Cancellation message progress unavailable');
    return result.data;
  };
  const plan=await call('read');
  if(!Array.isArray(plan.jobs))throw new Error('Cancellation message plan unavailable');
  for(const job of plan.jobs){
    if(deadlineAt-now()<8000)break;
    const envelope=buildFunnelCancellationMessage(job,order.tenant_id);
    const begun=await call('begin',job.id,envelope);
    if(begun.status!=='send')continue;
    if(begun.payload?.to!==envelope.to||begun.payload?.tenantId!==order.tenant_id)
      throw new Error('Cancellation envelope changed');
    let result;
    try {
      if(deadlineAt-now()<8000)result={notSubmitted:true};
      else result=await (send||(await import('./emailService.js')).sendEmail)({...begun.payload,deadlineAt,confidentialDiagnostics:true});
    }catch{result={success:false};}
    await call('finish',job.id,{outcome:result?.success===true?'accepted':
      result?.notSubmitted===true?'not_submitted':'unknown',messageId:result?.messageId||null});
  }
  return {status:(await call('read')).status};
}
