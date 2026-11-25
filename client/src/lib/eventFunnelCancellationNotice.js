export function funnelCancellationRecoveryNotice(result){
  if(!result?.operationId||!result.orderId)return null;
  if(result.recovery==='complete')return {
    warning:false,text:'Shared checkout cancellation recovery completed.'};
  return {warning:true,text:result.recovery==='needs_review'
    ?'Cancellation approved. Shared checkout refunds or access cleanup need attention. Open the event registration report to inspect recovery.'
    :'Cancellation approved. Shared checkout refunds and access cleanup are pending. Open the event registration report to check or retry recovery.'};
}

// Complimentary memberships from the cancelled booking: unused benefits are
// withdrawn; a benefit already applied to a membership period is kept.
export function funnelMembershipBenefitNotice(result){
  const items=result?.membershipBenefits;
  if(items==null)return null;
  if(items==='unavailable')return {warning:true,text:'Complimentary membership outcome could not be confirmed. Check the member or organisation membership screen.'};
  if(!items.length)return null;
  const lines=items.map(item=>{
    const name=item.scheduleName||'Complimentary membership';
    return item.state==='withdrawn'?`${name}: unused benefit withdrawn.`
      :item.state==='consumed'?`${name}: already applied to a membership period, so it was kept.`
      :item.state==='reserved'?`${name}: held by a membership checkout in progress, so it was not withdrawn. Review that membership payment.`
      :`${name}: still available because another qualifying booking remains.`;
  });
  return {warning:items.some(item=>['consumed','reserved'].includes(item.state)),text:lines.join(' ')};
}
