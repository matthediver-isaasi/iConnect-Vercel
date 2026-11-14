import {createHash} from 'node:crypto';
import {supabase} from '../_lib/database.js';
import {resolveJudgingAuthority} from '../_lib/assessment/access.js';
import {computeEvidence,computeModerationScore} from '../_lib/assessment/evidence.js';
import {reviewProjection} from '../_lib/assessment/projection.js';
import {attachmentOffset,sendAttachmentChunk} from '../_lib/assessment/attachmentResponse.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Panel unavailable'});
  try{
    const authority=await resolveJudgingAuthority(db,req,{...dependencies,mutate:req.method==='POST'});
    const input=req.method==='GET'?req.query||{}:req.body||{};
    const roundId=input.roundId||null,applicationId=input.applicationId||null,page=Number(input.page||1);
    if(roundId&&!uuid(roundId)||applicationId&&!uuid(applicationId)||!Number.isSafeInteger(page)||page<1||page>10000)
      return res.status(400).json({error:'Invalid panel request'});
    const owner={p_tenant:authority.tenantId,p_member:authority.memberId||null,p_session_hash:authority.sessionHash||null};
    if(req.method==='GET'&&!applicationId){
      const {data,error}=await db.rpc('assessment_panel_dashboard',{...owner,p_round:roundId,p_page:page});
      if(error)throw error;return res.json(data);
    }
    if(!roundId||!applicationId)return res.status(400).json({error:'Round and application required'});
    const target={...owner,p_round:roundId,p_application:applicationId};
    const {command,version,reason,method,answers,overall}=input;
    if(req.method==='POST'){
      if(!Number.isSafeInteger(version)||version<0||typeof reason!=='string'||!reason.trim()||reason.length>20000)
        return res.status(400).json({error:'Current version and reason required'});
      if(command==='conflict'){
        if(!['none','potential','confirmed'].includes(input.state))return res.status(400).json({error:'Conflict decision required'});
        const {data,error}=await db.rpc('assessment_panel_conflict_command',{...target,p_csrf_hash:authority.csrfHash||null,
          p_version:version,p_state:input.state,p_reason:reason});
        if(error)throw error;return res.json(data);
      }
      if(!['message','propose','approve','reopen'].includes(command))return res.status(400).json({error:'Unknown panel command'});
    }
    const result=await db.rpc('assessment_panel_evidence',{...target,p_page:page});
    if(result.error)throw result.error;
    const {evidence,criteria,capabilities,messages,history}=result.data;
    if(req.method==='GET'&&['review','attachment'].includes(input.scope)){
      const {data:snapshot,error}=await db.rpc('assessment_panel_review',target);
      if(error)throw error;const review=reviewProjection(snapshot);
      if(input.scope==='review')return res.json({applicationVersionId:snapshot.id,review});
      if(!uuid(input.attachmentId)||!review.attachments.some(file=>file.id===input.attachmentId))return res.status(404).json({error:'Attachment unavailable'});
      const chunk=await db.rpc('assessment_panel_attachment',{...target,p_attachment:input.attachmentId,p_offset:attachmentOffset(input.offset)});
      if(chunk.error)throw chunk.error;return sendAttachmentChunk(res,chunk.data);
    }
    if(req.method==='GET'&&input.scope==='assessmentHistory'){
      const {data,error}=await db.rpc('assessment_submitted_history',{p_tenant:authority.tenantId,p_round:roundId,p_application:applicationId,p_page:page});
      if(error)throw error;return res.json(data);
    }
    const aggregates=computeEvidence(evidence);
    if(req.method==='GET'){
      const assessments=evidence.assessments.filter(a=>a.state==='submitted').map(({appointmentId,...a})=>({
        ...a,judgeAlias:`Judge ${createHash('sha256').update(`${roundId}:${appointmentId}`).digest('hex').slice(0,8).toUpperCase()}`,
      }));
      const m=evidence.moderation;
      return res.json({application:evidence.application,assessments,criteria,capabilities,messages,history,
        moderation:m?{id:m.id,state:m.state,version:m.version,revision:m.revision?{
          action:m.revision.action,method:m.revision.method,justification:m.revision.justification,score:m.revision.exact_score,
        }:null}:null,...aggregates});
    }
    if(!capabilities?.[command])return res.status(403).json({error:'Your round appointment does not permit this action'});
    let score=null;
    if(command==='propose'){
      if(!aggregates.independent.complete)return res.status(409).json({error:'Required independent assessments are incomplete'});
      try{score=computeModerationScore({method,definition:criteria?.definition,answers,overall});}
      catch(error){return res.status(400).json({error:error.message});}
    }
    const saved=await db.rpc('assessment_panel_moderate',{...target,p_csrf_hash:authority.csrfHash||null,
      p_command:command,p_version:version,p_method:method||null,p_answers:method==='criterion'?answers:null,
      p_score:score,p_average:aggregates.independent.finalAverage,p_sources:aggregates.sourceIds,p_reason:reason});
    if(saved.error)throw saved.error;return res.json(saved.data);
  }catch(error){
    const status=error.status||(error.code==='42501'?403:['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503);
    return res.status(status).json({error:status===503?'Panel temporarily unavailable':error.message});
  }
}
