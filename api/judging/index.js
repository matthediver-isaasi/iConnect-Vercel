import { supabase } from '../_lib/database.js';
import { resolveJudgingAuthority } from '../_lib/assessment/access.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Judging unavailable'});
  try{
    const authority=await resolveJudgingAuthority(database,req,{...dependencies,mutate:req.method==='POST'});
    if(req.method==='GET'){
      const page=Number(req.query?.page||1);
      if(!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const {data,error}=await database.rpc('assessment_dashboard',{
        p_tenant:authority.tenantId,p_member:authority.memberId||null,p_session_hash:authority.sessionHash||null,p_page:page,
      });
      if(error)throw error;
      return res.json(data);
    }
    if(!authority.memberId)return res.status(403).json({error:'Use your invitation to respond'});
    const {appointmentId,version,accept}=req.body||{};
    if(typeof appointmentId!=='string'||!/^[0-9a-f-]{36}$/i.test(appointmentId)||!Number.isInteger(version)||version<1||typeof accept!=='boolean'){
      return res.status(400).json({error:'Invalid invitation response'});
    }
    const {data,error}=await database.rpc('assessment_respond_member',{
      p_tenant:authority.tenantId,p_member:authority.memberId,p_appointment:appointmentId,p_expected_version:version,p_accept:accept,
    });
    if(error)throw error;
    return res.json(data);
  }catch(error){
    const status=error.status|| (['40001','PT409'].includes(error.code)?409:error.code==='42501'?403:503);
    return res.status(status).json({error:status===503?'Judging temporarily unavailable':error.message});
  }
}
