import { randomUUID } from 'node:crypto';
import { createFormAlertToken } from './formAlertCapabilities.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';
import { sendEmail } from './emailService.js';

const escape = value => String(value).replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[char]));

export function formAlertDeliveryOutcome(result, attempts) {
  if(result?.success===true) return {status:'sent',outcome_code:'provider_accepted',provider_id:result.messageId||result.id||null};
  if(result?.ambiguousEffect===true) return {status:'attention',outcome_code:'ambiguous_provider_acceptance'};
  const safe=result?.notSubmitted===true || (Number(result?.status)>=400 && Number(result?.status)<500);
  return {status:safe && attempts<5 ? 'retry':'attention',
    outcome_code:safe?'provider_rejected':'unknown_provider_outcome'};
}

export async function deliverFormAlerts(db,{send=sendEmail,now=Date.now(),limit=20}={}) {
  const deadline=Date.now()+45000;
  // A process lost while sending might have reached Mailgun. Do not reclaim it.
  for(const [patch,filter] of [
    [{status:'attention',outcome_code:'send_interrupted'},q=>q.eq('status','sending').lt('claimed_at',new Date(now-300000).toISOString())],
    [{status:'expired',token_hash:null},q=>q.lt('expires_at',new Date(now).toISOString()).neq('status','expired')],
  ]) {
    const {error}=await filter(db.from('form_alert_delivery').update(patch));
    if(error) throw error;
  }
  const {error:cleanupError}=await db.from('form_alert_read_limit').delete().lt('window_start',new Date(now-3600000).toISOString());
  if(cleanupError) throw cleanupError;
  const {data:pending,error}=await db.from('form_alert_delivery').select('id')
    .in('status',['pending','retry']).lte('available_at',new Date(now).toISOString())
    .order('available_at').order('id').limit(Math.min(limit,20));
  if(error) throw error;
  const outcomes=[];
  for(const item of pending||[]) {
    if(Date.now()>deadline-15000) break;
    const {token,hash}=createFormAlertToken();
    const claimId=randomUUID();
    const {data:claimed,error:claimError}=await db.rpc('claim_form_submission_alert',{
      p_delivery_id:item.id,p_claim_id:claimId,p_token_hash:hash,
    });
    if(claimError) throw claimError;
    const delivery=claimed?.[0];
    if(!delivery) continue;
    let outcome;
    let sendStarted=false;
    try {
      const {data:tenant,error:tenantError}=await db.from('tenant').select('id,slug,domain').eq('id',delivery.tenant_id).maybeSingle();
      if(tenantError || !tenant?.id) throw new Error('tenant_unavailable');
      const {data:form,error:formError}=await db.from('form').select('id,form_type')
        .eq('tenant_id',delivery.tenant_id).eq('id',delivery.form_id).maybeSingle();
      if(formError || !form) throw new Error('form_unavailable');
      const {data:submission,error:submissionError}=await db.from('form_submission')
        .select('created_date,is_anonymous,survey_version_id').eq('tenant_id',delivery.tenant_id)
        .eq('form_id',delivery.form_id).eq('id',delivery.submission_id).maybeSingle();
      if(submissionError || !submission) throw new Error('submission_unavailable');
      if((form.form_type==='survey' || delivery.form_snapshot?.form_type==='survey')
        && !submission.survey_version_id) throw new Error('policy_unavailable');
      let anonymous=submission.is_anonymous===true;
      if(submission.survey_version_id) {
        const {data:version,error:versionError}=await db.from('survey_version').select('survey_settings')
          .eq('tenant_id',delivery.tenant_id).eq('form_id',delivery.form_id)
          .eq('id',submission.survey_version_id).maybeSingle();
        if(versionError || !version?.survey_settings) throw new Error('policy_unavailable');
        anonymous ||= (version.survey_settings.response_identity || 'identified') !== 'identified';
      }
      const url=new URL('/api/public/form-alert-view',getTenantTrustedBaseUrl(null,tenant));
      url.hash=token;
      const name=String(delivery.form_snapshot?.name||'Form').replace(/[\r\n]/g,' ');
      const date=anonymous ? String(submission.created_date).slice(0,10)
        : new Date(submission.created_date).toLocaleString('en-GB',{timeZone:'UTC',timeZoneName:'short'});
      // No recipient answer data, tracking, footer tokens or inbox copies.
      sendStarted=true;
      const result=await send({
        tenantId:delivery.tenant_id,to:delivery.recipient,
        subject:`New Form Submission – ${name}`,
        text:`${name}\nSubmitted: ${date}\n${url.href}`,
        html:`<p>${escape(name)}</p><p>Submitted: ${escape(date)}</p><p><a href="${escape(url.href)}">View submission</a></p>`,
        disableTracking:true,skipFooter:true,resolveTransactionalPreferences:false,
        confidentialDiagnostics:true,
        campaignDeadlineAt:deadline,
      });
      outcome=formAlertDeliveryOutcome(result,delivery.attempts);
    } catch {
      // Unknown exceptions may occur after provider acceptance; never auto-replay.
      outcome=sendStarted ? {status:'attention',outcome_code:'delivery_interrupted'}
        : formAlertDeliveryOutcome({notSubmitted:true},delivery.attempts);
    }
    const patch={...outcome,available_at:new Date(now+60000*Math.pow(2,delivery.attempts)).toISOString()};
    if(outcome.status==='sent') patch.sent_at=new Date().toISOString();
    else patch.token_hash=null;
    const {error:finishError}=await db.from('form_alert_delivery').update(patch)
      .eq('id',delivery.id).eq('claim_id',claimId).eq('status','sending').is('revoked_at',null);
    if(finishError) throw finishError; // Leave sending: the next sweep flags attention, never resends.
    outcomes.push({id:delivery.id,status:outcome.status});
  }
  return outcomes;
}
