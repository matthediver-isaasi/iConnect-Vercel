import {grantedBenefitsForBooking,loadFunnelOrderBenefits,renderGrantedBenefitsHtml} from './eventFunnelMembershipNotice.js';
const restorePayload=value=>JSON.parse(JSON.stringify(value),(key,item)=>
  item?.type==='Buffer'&&Array.isArray(item.data)?Buffer.from(item.data):item);

export async function deliverFunnelConfirmations({db,job,deadlineAt=Date.now()+15000,
  render,send,now=()=>Date.now()}) {
  const operation=async(action,item=null,payload=null)=>{
    const result=await db.rpc('event_funnel_confirmation_operation',{p_tenant:job.tenant_id,
      p_order:job.order_id,p_token:job.lease_token,p_action:action,p_item:item,p_payload:payload});
    if(result.error||!result.data) throw new Error('Confirmation progress could not be verified');
    return result.data;
  };
  const initial=await operation('read');
  if(!Array.isArray(initial.jobs)) throw new Error('Confirmation plan unavailable');
  // Granted in the same transaction as order confirmation, so the evidence is
  // complete before any confirmation is composed. Only first-time envelopes
  // use it: a stored envelope is always resent unchanged.
  const benefits=initial.jobs.length?await loadFunnelOrderBenefits(db,job.tenant_id,job.order_id):[];
  for(const item of initial.jobs) {
    if(deadlineAt-now()<8000) break;
    if(!item.receipt_token)throw new Error('Confirmation receipt schema is not ready');
    const benefitHtml=renderGrantedBenefitsHtml(grantedBenefitsForBooking(benefits,item.booking_id??item.booking?.id));
    const renderConfirmation=render||(await import('./eventConfirmationEmail.js')).sendConfirmationEmailsFromTemplate;
    await renderConfirmation(item.event_id,item.booking,null,null,null,job.tenant_id,{
      emailConfigs:[item.template],deadlineAt,requireCheckin:true,
      send:async payload=>{
        if(deadlineAt-now()<8000) return {success:false,notSubmitted:true};
        // The original envelope survives known-not-submitted retries; a
        // writing marker never expires into permission to send again.
        const envelope=benefitHtml?{...payload,html:`${payload.html||''}${benefitHtml}`}:payload;
        const claimed=await operation('begin',item.id,JSON.parse(JSON.stringify(envelope)));
        if(claimed.status==='delivered') return {success:true};
        if(claimed.status!=='send') return {success:false,error:'Confirmation requires review'};
        let result;
        try {
          if(deadlineAt-now()<8000) result={success:false,notSubmitted:true};
          else {
            const sender=send||(await import('./emailService.js')).sendEmail;
            result=await sender({...restorePayload(claimed.payload),deadlineAt,
              funnelReceipt:item.receipt_token?{id:item.id,token:item.receipt_token}:null});
          }
        } catch {result={success:false};}
        await operation('finish',item.id,{outcome:result?.success===true?'delivered':
          result?.notSubmitted===true?'not_submitted':'unknown',
          messageId:typeof result?.messageId==='string'?result.messageId.replace(/^<|>$/g,''):null});
        return result||{success:false};
      },
    });
  }
  return {status:(await operation('read')).status};
}
