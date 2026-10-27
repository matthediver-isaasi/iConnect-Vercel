import {amendmentResult} from './memberAmendmentSettlement.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createMemberCancellationNotifications({db,sendEmail}){
 async function send(context,record,job){
  if(record.tenant_id!==context.tenantId||record.member_id!==context.memberId
   ||record.id!==job.request_id||!record.access_ended_at||job.state!=='claimed'||!job.claim_token){
   throw Error('Owned applied cancellation and exclusive delivery claim required');
  }
  if(!['notify_access','notify_finance'].includes(job.kind)
   ||(job.kind==='notify_finance'&&record.financial_state!=='settled')){
   throw Error('Cancellation notification is not ready');
  }
  const member=amendmentResult(await db.from('member').select('id,email')
   .eq('tenant_id',context.tenantId).eq('id',context.memberId).maybeSingle());
  if(!member?.email||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(member.email)){
   return {state:'manual_review',message:'Member email address needs review',evidence:{notSubmitted:true}};
  }
  const formattedDate=new Intl.DateTimeFormat('en-GB',{dateStyle:'long',timeZone:'UTC'})
   .format(new Date(`${record.effective_date}T00:00:00Z`));
  const text=job.kind==='notify_access'
   ?`Your membership was cancelled with effect from ${formattedDate}.\n\n`
    +'Any unpaid balance for membership service you have already used remains payable. '
    +'Payments, refunds and member credit are handled separately from ending membership access.\n\n'
    +'Paying an outstanding invoice does not restart the cancelled membership. '
    +'This cancellation does not affect a separate new membership you have purchased.\n\n'
    +'Please contact your membership team if you need help.'
   :'The final balance for your cancelled membership has now been resolved.\n\n'
    +'Any payment, refund or member credit is recorded against your account. '
    +'Settling an old invoice does not restart the cancelled membership.\n\n'
    +'Please contact your membership team if you need help.';
  const deliver=sendEmail||(await import('./emailService.js')).sendSystemEmail;
  const sent=await deliver({tenantId:context.tenantId,to:member.email,
   subject:job.kind==='notify_access'?'Your membership cancellation':'Your membership final balance',
   text,html:text.split('\n\n').map(p=>`<p>${escape(p)}</p>`).join(''),
   disableTracking:true,confidentialDiagnostics:true});
  const messageId=sent?.messageId||sent?.id;
  if(sent?.success&&typeof messageId==='string'&&messageId){
   return {state:'done',evidence:{messageId}};
  }
  if(sent?.notSubmitted===true){
   return {state:'pending',delaySeconds:Math.max(60,Number(sent.retryAfter)||60),
    message:'Notification was not submitted',evidence:{notSubmitted:true}};
  }
  return {state:'uncertain',message:'Delivery outcome requires reconciliation',evidence:{}};
 }
 return {send};
}
