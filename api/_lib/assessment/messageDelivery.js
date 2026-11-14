import {sendEmail} from '../emailService.js';
import {getTenantTrustedBaseUrl} from '../publicBaseUrl.js';
import {renderAwardMessage} from './messageTemplates.js';
import {openInvitation,sealInvitation} from './deliveryCredentials.js';
import {credentialHash,newCredential} from './credentials.js';
async function one(q){const{data,error}=await q.maybeSingle();if(error)throw error;return data;}
export async function resolveAwardMessage(db,delivery,{secret=process.env.SESSION_SECRET}={}){
  const tenantId=delivery.tenant_id,context=delivery.recipient_context;
  const [award,tenant]=await Promise.all([
    one(db.from('awards_competition').select('id,name,closes_at').eq('tenant_id',tenantId).eq('id',delivery.award_id)),
    one(db.from('tenant').select('id,slug,domain').eq('id',tenantId)),
  ]);
  if(!award||!tenant)throw new Error('Award recipient context unavailable');
  const base=getTenantTrustedBaseUrl(null,tenant);
  if(!base)throw new Error('Trusted tenant URL unavailable');
  let email,link=`${base}/award-applications`,roundName='',reference='',outcomeName='',deadline=award.closes_at||'';
  if(context.appointment_id){
    const appointment=await one(db.from('assessment_appointment').select('id,member_id,contact_id,external_email,round_id')
      .eq('tenant_id',tenantId).eq('id',context.appointment_id));
    if(!appointment)throw new Error('Appointment unavailable');
    const round=await one(db.from('assessment_round').select('name,closes_at').eq('tenant_id',tenantId).eq('award_id',award.id).eq('id',appointment.round_id));
    if(!round)throw new Error('Round unavailable');
    roundName=round.name;deadline=round.closes_at||'';link=`${base}/judging`;
    if(appointment.member_id){
      const member=await one(db.from('member').select('email,tenant_id,organization:organization_id(tenant_id)').eq('id',appointment.member_id));
      if(!member||(member.tenant_id||member.organization?.tenant_id)!==tenantId)throw new Error('Member unavailable');
      email=member.email;
    }else if(appointment.contact_id){
      const contact=await one(db.from('organization_contact').select('email,organization:organization_id(tenant_id)').eq('id',appointment.contact_id));
      if(contact?.organization?.tenant_id!==tenantId)throw new Error('Contact unavailable');email=contact.email;
    }else email=appointment.external_email;
  }else{
    const application=await one(db.from('awards_application').select('id,member_id,submission_id,reference')
      .eq('tenant_id',tenantId).eq('award_id',award.id).eq('id',context.application_id));
    if(!application)throw new Error('Application unavailable');
    reference=application.reference;
    if(application.member_id){
      const member=await one(db.from('member').select('email,tenant_id,organization:organization_id(tenant_id)').eq('id',application.member_id));
      if(!member||(member.tenant_id||member.organization?.tenant_id)!==tenantId)throw new Error('Member unavailable');email=member.email;
      link+=`?applicationId=${application.id}`;
    }else{
      const submission=await one(db.from('form_submission').select('submitted_by_email').eq('tenant_id',tenantId).eq('id',application.submission_id));
      email=submission?.submitted_by_email;
      link=base;
      if(delivery.category!=='certificate'){
        const token=newCredential(),binding=`${tenantId}:applicant:${application.id}:${delivery.id}`;
        const access=await db.rpc('awards_issue_applicant_access',{p_tenant:tenantId,p_application:application.id,
          p_delivery:delivery.id,p_claim:delivery.claim_token,p_hash:credentialHash(token),p_envelope:sealInvitation(token,binding,secret)});
        if(access.error)throw Object.assign(new Error('Applicant access unavailable'),{cancelled:access.error.code==='42501'});
        email=access.data.email;
        let credential;
        try{credential=openInvitation(access.data.envelope,binding,secret);}
        catch{throw Object.assign(new Error('Applicant access encryption requires attention'),{permanent:true});}
        if(!credentialHash(credential))throw Object.assign(new Error('Invalid applicant credential'),{permanent:true});
        link=`${base}/award-application?applicationId=${application.id}#token=${credential}`;
      }
    }
    if(context.outcome_id){
      const outcome=await one(db.from('awards_outcome_revision').select('category_snapshot').eq('tenant_id',tenantId).eq('id',context.outcome_id).eq('application_id',application.id));
      if(!outcome)throw new Error('Outcome unavailable');outcomeName=outcome.category_snapshot?.name||'';
    }
    if(delivery.category==='certificate'){
      link=`${base}/award-certificate?issueId=${context.issue_id}`;
      if(!application.member_id){
        const token=openInvitation(context.envelope,`${tenantId}:certificate:${context.issue_id}`,secret);
        link+=`#token=${token}`;
      }
    }
  }
  if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Object.assign(new Error('Canonical recipient email unavailable'),{permanent:true});
  const configuration=await one(db.from('awards_message_configuration').select('email_template_id,enabled')
    .eq('tenant_id',tenantId).eq('award_id',award.id).eq('category',delivery.category));
  if(configuration?.enabled===false)throw Object.assign(new Error('Message disabled'),{cancelled:true});
  let template=null;
  if(configuration?.email_template_id){
    template=await one(db.from('email_template').select('subject,body').eq('tenant_id',tenantId).eq('id',configuration.email_template_id).eq('is_active',true));
    if(!template)throw new Error('Configured email template unavailable');
  }
  try{return{email,...renderAwardMessage(delivery.category,{'award.name':award.name,'round.name':roundName,
    'application.reference':reference,'outcome.name':outcomeName,deadline,link},template)};}
  catch(error){throw Object.assign(error,{permanent:true});}
}
export async function deliverAwardMessages(db,{send=sendEmail,deadline=Date.now()+45000,secret=process.env.SESSION_SECRET}={}){
  const {data,error}=await db.rpc('awards_claim_messages',{p_limit:5});if(error)throw error;
  const outcomes=[];
  for(const delivery of data||[]){
    let started=false;
    const finish=async(action,providerId=null)=>{
      const result=await db.rpc('awards_delivery_result',{p_tenant:delivery.tenant_id,p_id:delivery.id,p_claim:delivery.claim_token,p_action:action,p_provider_id:providerId});
      if(result.error||result.data!==true)throw new Error('Delivery acknowledgement failed');
      outcomes.push({id:delivery.id,state:action});
    };
    try{
      if(Date.now()>deadline-10000){await finish('retry');continue;}
      const content=await resolveAwardMessage(db,delivery,{secret});
      const marker=await db.rpc('awards_delivery_result',{p_tenant:delivery.tenant_id,p_id:delivery.id,p_claim:delivery.claim_token,p_action:'starting',p_provider_id:null});
      if(marker.error)throw marker.error;
      if(marker.data!==true){await finish('cancelled');continue;}
      started=true;
      const result=await send({tenantId:delivery.tenant_id,to:content.email,subject:content.subject,html:content.html,text:content.text,
        disableTracking:true,confidentialDiagnostics:true,resolveTransactionalPreferences:false,deadlineAt:deadline});
      await finish(result?.success===true&&result.messageId?'delivered':result?.notSubmitted===true?'retry':'attention',result?.messageId||null);
    }catch(error){
      try{await finish(started||error.permanent?'attention':error.cancelled?'cancelled':'retry');}
      catch{outcomes.push({id:delivery.id,state:'acknowledgement_pending'});}
    }
  }
  return outcomes;
}
