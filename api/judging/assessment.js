import { supabase } from '../_lib/database.js';
import { resolveJudgingAuthority, ownedAssignment } from '../_lib/assessment/access.js';
import { saveAssessment } from '../_lib/assessment/revisions.js';
import { reviewProjection } from '../_lib/assessment/projection.js';
const validId=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Judging unavailable'});
  try{
    const authority=await resolveJudgingAuthority(database,req,{...dependencies,mutate:req.method==='POST'});
    const assignmentId=req.method==='GET'?req.query?.assignmentId:req.body?.assignmentId;
    if(!validId(assignmentId))return res.status(400).json({error:'Assignment ID required'});
    const assignment=await ownedAssignment(database,authority,assignmentId);
    if(req.method==='POST'){
      const input=req.body;
      if(JSON.stringify(input).length>200000)return res.status(413).json({error:'Assessment is too large'});
      if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||!validId(input.requestId)
        ||typeof input.submit!=='boolean'||!validId(input.criteriaVersionId)||!validId(input.applicationVersionId)){
        return res.status(400).json({error:'Invalid assessment version or request'});
      }
      const result=await saveAssessment(database,authority,input);
      return res.json(result);
    }
    const {data:application,error:applicationError}=await database.from('awards_application').select('id,reference,eligibility')
      .eq('tenant_id',authority.tenantId).eq('award_id',assignment.award_id).eq('id',assignment.application_id).maybeSingle();
    if(applicationError)throw applicationError;
    if(!application||application.eligibility!=='eligible')return res.status(403).json({error:'Application is not available for judging'});
    const {data:criteria,error:criteriaError}=await database.from('assessment_criteria_version').select('id,definition,revision')
      .eq('tenant_id',authority.tenantId).eq('round_id',assignment.round_id).eq('id',assignment.criteria_version_id).maybeSingle();
    if(criteriaError)throw criteriaError;
    const {data:revisions,error:revisionError}=await database.from('assessment_revision')
      .select('id,revision,state,answers,exact_score,submitted_at').eq('tenant_id',authority.tenantId)
      .eq('assignment_id',assignment.id).order('revision',{ascending:false}).limit(1);
    if(revisionError)throw revisionError;
    const {data:snapshot,error:snapshotError}=await database.from('awards_application_version')
      .select('form_snapshot,answer_snapshot,display_snapshot,attachment_manifest').eq('tenant_id',authority.tenantId)
      .eq('application_id',assignment.application_id).eq('id',assignment.application_version_id).maybeSingle();
    if(snapshotError)throw snapshotError;
    if(!snapshot)return res.status(503).json({error:'Review snapshot unavailable'});
    return res.json({assignment:{id:assignment.id,version:assignment.version,conflict:assignment.conflict,
      applicationVersionId:assignment.application_version_id,criteriaVersionId:assignment.criteria_version_id},
      application:{reference:application.reference,...reviewProjection(snapshot)},criteria,assessment:revisions[0]||null});
  }catch(error){
    const status=error.status|| (['40001','PT409'].includes(error.code)?409:error.code==='42501'?403:
      ['P0001','23505','ASSESSMENT_INCOMPLETE'].includes(error.code)?400:503);
    return res.status(status).json({error:status===503?'Judging is temporarily unavailable':error.message,
      ...(error.code==='ASSESSMENT_INCOMPLETE'?{details:error.details}:{} )});
  }
}
