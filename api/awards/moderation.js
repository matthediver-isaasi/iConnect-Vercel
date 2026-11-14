import { supabase } from '../_lib/database.js';
import {createHash} from 'node:crypto';
import { authorizeAwards } from './index.js';
import { computeEvidence, computeModerationScore } from '../_lib/assessment/evidence.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Moderation unavailable'});
  try{
    const command=req.body?.command;
    let auth=await authorizeAwards(req,database,dependencies.getTenantContext,
      command==='approve'?'awards.management.approve':'awards.management.moderate');
    if(req.method==='GET'&&!auth.context&&auth.status===403){
      auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.approve');
    }
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const context=auth.context;
    const {roundId,applicationId}=req.method==='GET'?req.query||{}:req.body||{};
    if(!uuid(roundId)||!uuid(applicationId))return res.status(400).json({error:'Round and application required'});
    const {data:evidence,error}=await database.rpc('assessment_evidence',{p_tenant:context.tenantId,p_round:roundId,p_application:applicationId});
    if(error)throw error;
    const aggregates=computeEvidence(evidence);
    if(req.method==='GET'){
      // Moderator sees independent assessments, but identity disclosure is a
      // separate permission; aliases are round-local and stable, never names.
      const assessments=evidence.assessments.filter(a=>a.state==='submitted').map(({appointmentId,...a})=>({...a,
        judgeAlias:`Judge ${createHash('sha256').update(`${roundId}:${appointmentId}`).digest('hex').slice(0,8).toUpperCase()}`}));
      let messages=[],history=[],criteria=null;
      const criteriaId=evidence.assessments[0]?.criteriaVersionId;
      if(criteriaId){
        const result=await database.from('assessment_criteria_version').select('id,definition')
          .eq('tenant_id',context.tenantId).eq('round_id',roundId).eq('id',criteriaId).single();
        if(result.error)throw result.error;criteria=result.data;
      }
      if(evidence.moderation){
        const page=Number(req.query?.page||1);
        if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid discussion page'});
        const result=await database.from('assessment_moderation_message').select('id,content,created_at')
          .eq('tenant_id',context.tenantId).eq('moderation_id',evidence.moderation.id).order('created_at').order('id').range((page-1)*50,page*50-1);
        if(result.error)throw result.error;messages=result.data;
        const revisions=await database.from('assessment_moderation_revision')
          .select('id,revision,action,method,criterion_answers,exact_score,original_average,justification,created_at')
          .eq('tenant_id',context.tenantId).eq('moderation_id',evidence.moderation.id)
          .order('revision',{ascending:false}).range((page-1)*50,page*50-1);
        if(revisions.error)throw revisions.error;history=revisions.data;
      }
      const moderation=evidence.moderation?{id:evidence.moderation.id,version:evidence.moderation.version,state:evidence.moderation.state,
        revision:evidence.moderation.revision?{action:evidence.moderation.revision.action,method:evidence.moderation.revision.method,
          justification:evidence.moderation.revision.justification,score:evidence.moderation.revision.exact_score}:null}:null;
      return res.json({application:evidence.application,assessments,moderation,messages,history,criteria,...aggregates});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use the awards administration page'});
    const {version,method,answers,overall,reason}=req.body||{};
    if(!['message','propose','approve','reopen'].includes(command)||!Number.isSafeInteger(version)||version<0
      ||typeof reason!=='string'||!reason.trim()||reason.length>20000)return res.status(400).json({error:'Command, current version and justification required'});
    let score=null;
    if(command==='propose'){
      if(!aggregates.independent.complete)return res.status(409).json({error:'Required independent assessments are incomplete'});
      const source=evidence.assessments.find(a=>a.state==='submitted'&&a.included&&!a.recused);
      const {data:criteria,error:criteriaError}=await database.from('assessment_criteria_version').select('definition')
        .eq('tenant_id',context.tenantId).eq('round_id',roundId).eq('id',source.criteriaVersionId).single();
      if(criteriaError)throw criteriaError;
      try{score=computeModerationScore({method,definition:criteria.definition,answers,overall});}
      catch(error){return res.status(400).json({error:error.message});}
    }
    const {data,error:writeError}=await database.rpc('assessment_moderate',{
      p_tenant:context.tenantId,p_round:roundId,p_application:applicationId,p_actor_kind:context.memberId?'member':'tenant_user',
      p_actor:context.memberId||context.tenantUserId,p_command:command,p_expected_version:version,p_method:method||null,
      p_answers:method==='criterion'?answers:null,p_score:score,p_average:aggregates.independent.finalAverage,
      p_source_revisions:aggregates.sourceIds,p_reason:reason,
    });
    if(writeError)throw writeError;
    return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Moderation temporarily unavailable':error.message});
  }
}
