import {supabase} from '../_lib/database.js';
import {resolveJudgingAuthority,ownedAssignment} from '../_lib/assessment/access.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;
  if(!db)return res.status(503).json({error:'Judging unavailable'});
  try{
    const authority=await resolveJudgingAuthority(db,req,{...dependencies,mutate:true});
    const {assignmentId,version,conflict,reason}=req.body||{};
    if(typeof assignmentId!=='string'||!/^[0-9a-f-]{36}$/i.test(assignmentId)||!Number.isSafeInteger(version)||version<1
      ||!['none','potential','confirmed'].includes(conflict)||typeof reason!=='string'||reason.length>10000
      ||conflict!=='none'&&!reason.trim())return res.status(400).json({error:'A valid conflict declaration and explanation are required'});
    await ownedAssignment(db,authority,assignmentId,{declaringConflict:true});
    const {data,error}=await db.rpc('assessment_declare_conflict',{
      p_tenant:authority.tenantId,p_assignment:assignmentId,p_member:authority.memberId||null,
      p_session_hash:authority.sessionHash||null,p_csrf_hash:authority.csrfHash||null,p_expected_version:version,p_conflict:conflict,p_reason:reason,
    });
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=error.status|| (['40001','PT409'].includes(error.code)?409:error.code==='42501'?403:error.code==='P0001'?400:503);
    return res.status(status).json({error:status===503?'Conflict declaration could not be saved':error.message});
  }
}
