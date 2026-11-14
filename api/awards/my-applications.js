import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {getSessionMember} from '../_lib/session.js';
import {validateAmendmentEvidence} from '../_lib/assessment/amendmentValidation.js';
import {captureReviewAttachments} from '../_lib/assessment/attachments.js';
import {buildReviewDisplaySnapshot} from '../_lib/assessment/displaySnapshot.js';
import {amendmentChoiceAccess} from '../_lib/assessment/amendmentChoiceAccess.js';
import {reviewProjection} from '../_lib/assessment/projection.js';
import {attachmentOffset,sendAttachmentChunk} from '../_lib/assessment/attachmentResponse.js';
const uuid=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Applications unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    // Only the separate scoped external endpoint supplies this internal option.
    // Every domain command independently revalidates the grant.
    const access=dependencies.externalAccessHash?{p_access_hash:dependencies.externalAccessHash}:{};
    const member=dependencies.externalAccessHash?{id:null,tenant_id:tenant?.id}:await (dependencies.getMember||getSessionMember)(req);
    if(!tenant?.id||!member||(member.tenant_id||member.organization?.tenant_id)!==tenant.id)return res.status(401).json({error:'Member sign-in required'});
    if(req.method==='GET'){
      if(req.query?.review==='1'||req.query?.attachmentId){
        const {applicationId,attachmentId}=req.query;
        if(!uuid(applicationId)||attachmentId&&!uuid(attachmentId))return res.status(400).json({error:'Application evidence reference required'});
        const owner={p_tenant:tenant.id,p_member:member.id,p_application:applicationId,...access};
        const {data:snapshot,error}=await db.rpc('awards_applicant_review',owner);
        if(error)throw error;
        const review=reviewProjection(snapshot);
        if(!attachmentId)return res.json({applicationVersionId:snapshot.id,review});
        if(!review.attachments.some(file=>file.id===attachmentId))return res.status(404).json({error:'Attachment unavailable'});
        const chunk=await db.rpc('awards_applicant_attachment',{...owner,p_attachment:attachmentId,p_offset:attachmentOffset(req.query?.offset)});
        if(chunk.error)throw chunk.error;return sendAttachmentChunk(res,chunk.data);
      }
      const applicationId=req.query?.applicationId||null,page=Number(req.query?.page||1);
      if(applicationId&&!uuid(applicationId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid application request'});
      if(req.query?.edit==='1'){
        if(!applicationId)return res.status(400).json({error:'Application required'});
        const {data,error}=await db.rpc('awards_amendment_editor',{p_tenant:tenant.id,p_member:member.id,p_application:applicationId,...access});
        if(error)throw error;
        const choices=await amendmentChoiceAccess({db,req,tenantId:tenant.id,formId:data.form?.id,resolveAccess:dependencies.resolveFormAccess});
        return res.json({...data,existingChoiceAccess:choices});
      }
      const {data,error}=await db.rpc('awards_applicant_status',{p_tenant:tenant.id,p_member:member.id,p_application:applicationId,p_page:page,...access});
      if(error)throw error;return res.json(data);
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use your application page'});
    const {applicationId,version,reason,command}=req.body||{};
    if(command==='amend'){
      const {requestId,answers}=req.body;
      if(!uuid(applicationId)||!uuid(requestId)||!Number.isSafeInteger(version)||version<1
        ||typeof reason!=='string'||!reason.trim()||reason.length>2000||!answers||typeof answers!=='object'
        ||Array.isArray(answers)||JSON.stringify(answers).length>500000)return res.status(400).json({error:'Application version, amendment request, answers and reason required'});
      const prepared=await db.rpc('awards_prepare_amendment',{p_tenant:tenant.id,p_member:member.id,p_application:applicationId,
        p_submission:requestId,p_version:version,p_answers:answers,...access});
      if(prepared.error)throw prepared.error;
      if(prepared.data.replayed){
        let savedQuery=db.from('awards_amendment').select('id,application_version_id,reason').eq('tenant_id',tenant.id)
          .eq('application_id',applicationId).eq('submission_id',requestId);
        savedQuery=member.id?savedQuery.eq('member_id',member.id):savedQuery.is('member_id',null);
        const saved=await savedQuery.maybeSingle();
        if(saved.error)throw saved.error;
        if(saved.data){
          if(saved.data.reason!==reason)return res.status(409).json({error:'Amendment request ID already used with another reason'});
          return res.json({id:saved.data.id,applicationVersionId:saved.data.application_version_id,replayed:true,
            effects:'review_evidence_only',judgeAdoption:'unchanged'});
        }
      }
      const changes=await db.rpc('awards_amendment_choice_changes',{p_tenant:tenant.id,p_application:applicationId,p_submission:requestId});
      if(changes.error)throw changes.error;
      if(!Array.isArray(changes.data))throw new Error('Linked answer authority unavailable');
      let choiceAccess=false;
      if(changes.data.length){
        choiceAccess=await amendmentChoiceAccess({db,req,tenantId:tenant.id,formId:prepared.data.form.id,resolveAccess:dependencies.resolveFormAccess});
        if(!choiceAccess)return res.status(403).json({error:'Linked answers are read-only without existing form access'});
      }
      const validation=await validateAmendmentEvidence({db,tenantId:tenant.id,form:prepared.data.form,answers:prepared.data.answers});
      const hidden=new Set(validation.hiddenFieldIds);
      if(changes.data.some(id=>hidden.has(id)||!prepared.data.form.fields?.some(field=>field.id===id)||prepared.data.form.fields?.some(field=>field.id===id&&(field.hidden===true||field.hidden==='true'||field.due_diligence))))
        return res.status(403).json({error:'Hidden linked answers cannot be changed'});
      await captureReviewAttachments(db,{tenantId:tenant.id,submissionId:requestId,copyFromApplication:applicationId});
      const result=await db.rpc('awards_record_amendment',{p_tenant:tenant.id,p_member:member.id,p_application:applicationId,
        p_submission:requestId,p_expected_version:version,p_reason:reason,...access,p_existing_choice_access:choiceAccess,
        p_display:await buildReviewDisplaySnapshot(db,{tenantId:tenant.id,submissionId:requestId,copyFromApplication:applicationId})});
      if(result.error)throw result.error;
      return res.json({...result.data,effects:'review_evidence_only',judgeAdoption:'unchanged'});
    }
    if(command!=='withdraw'||!uuid(applicationId)||!Number.isSafeInteger(version)||version<1||typeof reason!=='string'||!reason.trim()||reason.length>2000){
      return res.status(400).json({error:'Application, current version and withdrawal reason required'});
    }
    const {data,error}=await db.rpc('awards_application_decide',{p_tenant:tenant.id,p_application:applicationId,p_expected_version:version,
      p_actor_kind:'member',p_actor:member.id,p_state:'withdrawn',p_reason:reason,p_self_service:true});
    if(error)throw error;
    return res.json({id:data.id,version:data.version,status:'Withdrawn'});
  }catch(error){
    const status=error.status|| (['40001','PT409'].includes(error.code)?409:error.code==='42501'?403:error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:503);
    return res.status(status).json({error:status===503?'Your application could not be loaded or changed':error.message,
      ...(status===400&&error.details?{details:error.details}:{})});
  }
}
