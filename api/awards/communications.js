import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {messageCategories,messageKeys} from '../_lib/assessment/messageTemplates.js';
import {newCredential,credentialHash} from '../_lib/assessment/credentials.js';
import {sealInvitation} from '../_lib/assessment/deliveryCredentials.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
async function one(q){const {data,error}=await q.maybeSingle();if(error)throw error;return data;}
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Award communications unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.communicate');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context,awardId=req.method==='GET'?req.query?.awardId:req.body?.awardId;
    if(!uuid(awardId))return res.status(400).json({error:'Award required'});
    if(req.method==='GET'){
      if(req.query?.deliveryId){
        if(!uuid(req.query.deliveryId))return res.status(400).json({error:'Invalid delivery'});
        const {data,error}=await db.rpc('awards_delivery_control',{p_tenant:c.tenantId,p_award:awardId,p_delivery:req.query.deliveryId,p_command:'read'});
        if(error)throw error;return res.json(data);
      }
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const range=[(page-1)*50,page*50-1];
      const [configs,templates,deliveries,applications,appointments,issues]=await Promise.all([
        db.from('awards_message_configuration').select('id,category,email_template_id,enabled,version,automatic,offset_minutes,automatic_since').eq('tenant_id',c.tenantId).eq('award_id',awardId),
        db.from('email_template').select('id,subject',{count:'exact'}).eq('tenant_id',c.tenantId).eq('is_active',true).order('id').range(...range),
        db.from('awards_delivery').select('id,category,due_at,state,delivered_at,attempts,last_error_code,recipient_context',{count:'exact'})
          .eq('tenant_id',c.tenantId).eq('award_id',awardId).order('due_at',{ascending:false}).order('id').range(...range),
        db.from('awards_application').select('id,reference,eligibility',{count:'exact'}).eq('tenant_id',c.tenantId).eq('award_id',awardId).order('id').range(...range),
        db.from('assessment_appointment').select('id,round_id,role,state,round:assessment_round!inner(award_id,name)',{count:'exact'})
          .eq('tenant_id',c.tenantId).eq('round.award_id',awardId).order('id').range(...range),
        db.from('awards_certificate_issue').select('id,outcome_revision_id,recipient_snapshot',{count:'exact'})
          .eq('tenant_id',c.tenantId).eq('award_id',awardId).order('id').range(...range),
      ]);
      for(const result of [configs,templates,deliveries,applications,appointments,issues])if(result.error)throw result.error;
      return res.json({configurations:configs.data,templates:templates.data,templateTotal:templates.count,
        deliveries:deliveries.data.map(({recipient_context,...delivery})=>({...delivery,recipient:{
          applicationId:recipient_context.application_id,appointmentId:recipient_context.appointment_id,issueId:recipient_context.issue_id}})),
        deliveryTotal:deliveries.count,applications:applications.data,applicationTotal:applications.count,
        appointments:appointments.data,appointmentTotal:appointments.count,
        certificates:issues.data.map(issue=>({id:issue.id,outcomeId:issue.outcome_revision_id,external:!issue.recipient_snapshot.member_id})),certificateTotal:issues.count,
        categories:messageCategories,placeholderKeys:messageKeys,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body,actor={p_tenant:c.tenantId,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId};
    if(input.command==='delivery_control'){
      if(!uuid(input.deliveryId)||!['retry','cancel'].includes(input.action)||typeof input.version!=='string'||!/^[a-f0-9]{32}$/.test(input.version)
        ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)return res.status(400).json({error:'Delivery, version, action and reason required'});
      const {data,error}=await db.rpc('awards_delivery_control',{...actor,p_award:awardId,p_delivery:input.deliveryId,
        p_command:input.action,p_version:input.version,p_reason:input.reason});
      if(error)throw error;return res.json(data);
    }
    if(input.command==='automation'){
      if(!messageCategories.includes(input.category)||typeof input.automatic!=='boolean'||!Number.isSafeInteger(input.version)||input.version<1
        ||!Number.isSafeInteger(input.offsetMinutes)||input.offsetMinutes<0||input.offsetMinutes>525600
        ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)return res.status(400).json({error:'Saved configuration, automatic policy, timing and reason required'});
      const {data,error}=await db.rpc('awards_configure_automatic_messages',{...actor,p_award:awardId,p_category:input.category,
        p_version:input.version,p_automatic:input.automatic,p_offset:input.offsetMinutes,p_reason:input.reason});
      if(error)throw error;return res.json(data);
    }
    if(input.command==='configure'){
      if(!messageCategories.includes(input.category)||input.templateId&&!uuid(input.templateId)||typeof input.enabled!=='boolean'
        ||!Number.isSafeInteger(input.version)||input.version<0)return res.status(400).json({error:'Category, template, setting and version required'});
      const {data,error}=await db.rpc('awards_configure_message',{...actor,p_award:awardId,p_category:input.category,p_template:input.templateId||null,
        p_enabled:input.enabled,p_version:input.version});
      if(error)throw error;return res.json({configuration:data});
    }
    if(input.command!=='schedule'||!messageCategories.includes(input.category)||input.category==='judge_invitation'
      ||!uuid(input.requestId)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000
      ||typeof input.dueAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(input.dueAt)||!Number.isFinite(Date.parse(input.dueAt))){
      return res.status(400).json({error:'Message category, stable request ID, schedule and reason required'});
    }
    const context={};let release=null;
    if(['judge_invitation_reminder','judging_deadline','incomplete_assessment','moderation_invitation'].includes(input.category)){
      if(!uuid(input.appointmentId))return res.status(400).json({error:'Appointment required'});
      const appointment=await one(db.from('assessment_appointment').select('id,credential_generation').eq('tenant_id',c.tenantId).eq('id',input.appointmentId));
      if(!appointment)return res.status(404).json({error:'Appointment unavailable'});
      context.appointment_id=appointment.id;context.generation=appointment.credential_generation;
    }else{
      if(!uuid(input.applicationId))return res.status(400).json({error:'Application required'});
      context.application_id=input.applicationId;
      if(input.category==='shortlist'){
        if(!uuid(input.shortlistId))return res.status(400).json({error:'Released confirmed shortlist required'});
        context.shortlist_id=input.shortlistId;
        release=await one(db.from('awards_delivery_release').select('id').eq('tenant_id',c.tenantId).eq('award_id',awardId).eq('shortlist_id',input.shortlistId));
        if(!release)return res.status(409).json({error:'Authorise shortlist recipient release before scheduling'});
      }else if(['unsuccessful','winner','certificate'].includes(input.category)){
        if(!uuid(input.outcomeId))return res.status(400).json({error:'Released outcome required'});
        context.outcome_id=input.outcomeId;
        release=await one(db.from('awards_delivery_release').select('id').eq('tenant_id',c.tenantId).eq('award_id',awardId).eq('outcome_revision_id',input.outcomeId));
        if(!release)return res.status(409).json({error:'Authorise recipient release before scheduling this message'});
      }
    }
    if(input.category==='certificate'){
      if(!uuid(input.issueId))return res.status(400).json({error:'Issued certificate required'});
      context.issue_id=input.issueId;
    }
    const existing=await one(db.from('awards_delivery').select('id,state,recipient_context,category,award_id,requested_due_at')
      .eq('tenant_id',c.tenantId).eq('deduplication_key',`message:${input.requestId}`));
    if(existing){
      if(existing.award_id!==awardId||existing.category!==input.category||Date.parse(existing.requested_due_at)!==Date.parse(input.dueAt)
        ||Object.entries(context).some(([key,value])=>existing.recipient_context[key]!==value)){
        return res.status(409).json({error:'Request ID belongs to another message'});
      }
      return res.json({id:existing.id,state:existing.state,replayed:true});
    }
    if(input.category==='certificate'){
      if(!uuid(input.issueId))return res.status(400).json({error:'Issued certificate required'});
      const issue=await one(db.from('awards_certificate_issue').select('id,recipient_snapshot').eq('tenant_id',c.tenantId)
        .eq('award_id',awardId).eq('outcome_revision_id',input.outcomeId).eq('id',input.issueId));
      if(!issue)return res.status(404).json({error:'Certificate unavailable'});
      context.issue_id=issue.id;
      if(!issue.recipient_snapshot.member_id){
        const expiry=input.linkExpiresAt;
        if(typeof expiry!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(expiry)||!Number.isFinite(Date.parse(expiry))
          ||Date.parse(expiry)<=Math.max(Date.now(),Date.parse(input.dueAt)))return res.status(400).json({error:'External certificate link expiry must follow its send time'});
        const token=newCredential();
        const link=await db.rpc('awards_certificate_link',{...actor,p_issue:issue.id,p_hash:credentialHash(token),p_expiry:expiry,p_revoke:false});
        if(link.error)throw link.error;
        context.access_id=link.data.access_id;
        context.envelope=sealInvitation(token,`${c.tenantId}:certificate:${issue.id}`,dependencies.deliverySecret);
      }
    }
    const {data,error}=await db.rpc('awards_queue_message',{...actor,p_award:awardId,p_category:input.category,p_context:context,
      p_release:release?.id||null,p_due:input.dueAt,p_request:input.requestId,p_reason:input.reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514','23505'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Award communication could not be completed':error.message});
  }
}
