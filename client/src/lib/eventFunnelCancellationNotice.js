export function funnelCancellationRecoveryNotice(result){
  if(!result?.operationId||!result.orderId)return null;
  if(result.recovery==='complete')return {
    warning:false,text:'Shared checkout cancellation recovery completed.'};
  return {warning:true,text:result.recovery==='needs_review'
    ?'Cancellation approved. Shared checkout refunds or access cleanup need attention. Open the event registration report to inspect recovery.'
    :'Cancellation approved. Shared checkout refunds and access cleanup are pending. Open the event registration report to check or retry recovery.'};
}
