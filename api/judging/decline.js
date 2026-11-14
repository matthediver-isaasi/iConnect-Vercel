import {supabase} from '../_lib/database.js';
import {resolveJudgingAuthority} from '../_lib/assessment/access.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Judging unavailable'});
  try{
    const authority=await resolveJudgingAuthority(db,req,{...dependencies,mutate:true});
    const {assignmentId,version,reason}=req.body||{};
    if(typeof assignmentId!=='string'||!/^[0-9a-f-]{36}$/i.test(assignmentId)||!Number.isSafeInteger(version)||version<1
      ||typeof reason!=='string'||!reason.trim()||reason.length>2000)return res.status(400).json({error:'Assignment version and reason required'});
    const {data,error}=await db.rpc('assessment_decline_assignment',{p_tenant:authority.tenantId,p_assignment:assignmentId,
      p_member:authority.memberId||null,p_session_hash:authority.sessionHash||null,p_csrf_hash:authority.csrfHash||null,
      p_version:version,p_reason:reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=error.status||(error.code==='42501'?403:['40001','PT409'].includes(error.code)?409:error.code==='P0001'?400:503);
    return res.status(status).json({error:status===503?'Assignment decline unavailable':error.message});
  }
}
