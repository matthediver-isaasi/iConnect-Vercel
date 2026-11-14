import {sendEmail} from '../emailService.js';
import {getTenantTrustedBaseUrl} from '../publicBaseUrl.js';
import {openInvitation} from './deliveryCredentials.js';
import {credentialHash} from './credentials.js';
import {renderAwardMessage} from './messageTemplates.js';
async function one(query){const{data,error}=await query.maybeSingle();if(error)throw error;return data;}
export async function deliverAwardsInvitations(db,{send=sendEmail,deadline=Date.now()+45000,secret=process.env.SESSION_SECRET}={}){
  const {data:deliveries,error}=await db.rpc('awards_claim_deliveries',{p_limit:5});
  if(error)throw error;
  const outcomes=[];
  for(const delivery of deliveries){
    const finish=async(action,providerId=null)=>{
      const result=await db.rpc('awards_delivery_result',{p_tenant:delivery.tenant_id,p_id:delivery.id,
        p_claim:delivery.claim_token,p_action:action,p_provider_id:providerId});
      if(result.error||result.data!==true)throw new Error('Delivery acknowledgement was not recorded');
      outcomes.push({id:delivery.id,state:action});
    };
    if(Date.now()>deadline-10000){await finish('retry');continue;}
    let started=false;
    try{
      const context=delivery.recipient_context;
      const appointment=await one(db.from('assessment_appointment').select('*').eq('tenant_id',delivery.tenant_id).eq('id',context.appointment_id));
      if(!appointment||appointment.state!=='invited'||appointment.credential_generation!==context.generation
        ||appointment.expires_at&&Date.parse(appointment.expires_at)<=Date.now()){await finish('cancelled');continue;}
      const round=await one(db.from('assessment_round').select('id,award_id,name,state').eq('tenant_id',delivery.tenant_id).eq('id',appointment.round_id));
      if(!round||round.award_id!==delivery.award_id||round.state==='closed'){await finish('cancelled');continue;}
      const [award,tenant]=await Promise.all([
        one(db.from('awards_competition').select('id,name,state').eq('tenant_id',delivery.tenant_id).eq('id',delivery.award_id)),
        one(db.from('tenant').select('id,slug,domain').eq('id',delivery.tenant_id)),
      ]);
      if(!award||!tenant||['completed','archived'].includes(award.state)){await finish('cancelled');continue;}
      let email,fragment='';
      if(appointment.member_id){
        const member=await one(db.from('member').select('id,email,tenant_id,login_enabled,organization:organization_id(tenant_id)').eq('id',appointment.member_id));
        if(!member||member.login_enabled===false||(member.tenant_id||member.organization?.tenant_id)!==delivery.tenant_id){await finish('cancelled');continue;}
        email=member.email;
      }else{
        if(appointment.contact_id){
          const contact=await one(db.from('organization_contact').select('email,organization:organization_id!inner(tenant_id)').eq('id',appointment.contact_id));
          if(!contact||contact.organization?.tenant_id!==delivery.tenant_id){await finish('cancelled');continue;}
          email=contact.email;
        }else email=appointment.external_email;
        let token;
        try{token=openInvitation(context.envelope,`${delivery.tenant_id}:${appointment.id}`,secret);}
        catch{throw Object.assign(new Error('Invitation encryption configuration changed'),{permanent:true});}
        const hash=credentialHash(token);
        if(!hash)throw new Error('Invalid encrypted invitation');
        const invitation=await one(db.from('assessment_invitation').select('id,expires_at,redeemed_at,revoked_at')
          .eq('tenant_id',delivery.tenant_id).eq('appointment_id',appointment.id).eq('generation',appointment.credential_generation).eq('token_hash',hash));
        if(!invitation||invitation.revoked_at||invitation.redeemed_at||Date.parse(invitation.expires_at)<=Date.now()){await finish('cancelled');continue;}
        fragment=`#token=${token}`;
      }
      if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){await finish('cancelled');continue;}
      const link=`${getTenantTrustedBaseUrl(null,tenant)}/judging${fragment}`;
      const configuration=await one(db.from('awards_message_configuration').select('email_template_id,enabled')
        .eq('tenant_id',delivery.tenant_id).eq('award_id',delivery.award_id).eq('category','judge_invitation'));
      if(configuration?.enabled===false){await finish('cancelled');continue;}
      let template=null;
      if(configuration?.email_template_id){
        template=await one(db.from('email_template').select('subject,body')
          .eq('tenant_id',delivery.tenant_id).eq('id',configuration.email_template_id).eq('is_active',true));
        if(!template)throw Object.assign(new Error('Configured invitation template unavailable'),{permanent:true});
      }
      let content;
      try{content=renderAwardMessage('judge_invitation',{'award.name':award.name,'round.name':round.name,link},template);}
      catch{throw Object.assign(new Error('Invitation template requires correction'),{permanent:true});}
      const marker=await db.rpc('awards_delivery_result',{p_tenant:delivery.tenant_id,p_id:delivery.id,p_claim:delivery.claim_token,p_action:'starting',p_provider_id:null});
      if(marker.error)throw new Error('Delivery claim could not be verified');
      if(marker.data!==true){await finish('cancelled');continue;}
      started=true;
      const result=await send({tenantId:delivery.tenant_id,to:email,...content,
        disableTracking:true,confidentialDiagnostics:true,resolveTransactionalPreferences:false,deadlineAt:deadline});
      if(result?.success===true&&result.messageId)await finish('delivered',result.messageId);
      else await finish(result?.notSubmitted===true?'retry':'attention');
    }catch(error){
      // A provider timeout is not evidence that no email was delivered.
      // Never automatically replay a potentially successful external send.
      try{await finish(started||error.permanent?'attention':'retry');}
      catch{outcomes.push({id:delivery.id,state:'acknowledgement_pending'});}
    }
  }
  return outcomes;
}
