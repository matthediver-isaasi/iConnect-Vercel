import {supabase} from '../_lib/database.js';
import {resolveJudgingAuthority} from '../_lib/assessment/access.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Peer assessments unavailable'});
  try{
    const authority=await resolveJudgingAuthority(db,req,dependencies);
    const assignmentId=req.query?.assignmentId,page=Number(req.query?.page||1);
    if(typeof assignmentId!=='string'||!/^[0-9a-f-]{36}$/i.test(assignmentId)||!Number.isSafeInteger(page)||page<1||page>10000)
      return res.status(400).json({error:'Assignment and page required'});
    const {data,error}=await db.rpc('assessment_peer_view',{p_tenant:authority.tenantId,p_assignment:assignmentId,
      p_member:authority.memberId||null,p_session_hash:authority.sessionHash||null,p_page:page});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=error.status||(error.code==='42501'?403:503);
    return res.status(status).json({error:status===503?'Peer assessments unavailable':error.message});
  }
}
