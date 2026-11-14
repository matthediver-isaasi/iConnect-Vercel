import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Round lifecycle unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {roundId,version,state,closesAt,reason}=req.body||{};
    if(req.body?.command==='reopen_award'){
      const {awardId}=req.body,c=auth.context;
      if(typeof awardId!=='string'||!/^[0-9a-f-]{36}$/i.test(awardId)||!Number.isSafeInteger(version)||version<1
        ||typeof reason!=='string'||!reason.trim()||reason.length>2000)return res.status(400).json({error:'Award, version and correction reason required'});
      const {data,error}=await db.rpc('awards_reopen_review',{p_tenant:c.tenantId,p_award:awardId,p_version:version,
        p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:reason});
      if(error)throw error;return res.json({award:data});
    }
    if(typeof roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(roundId)||!Number.isSafeInteger(version)||version<1
      ||!['judging','moderation','closed'].includes(state)||typeof reason!=='string'||!reason.trim()||reason.length>20000
      ||closesAt&&(typeof closesAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(closesAt)||!Number.isFinite(Date.parse(closesAt)))){
      return res.status(400).json({error:'Round version, target state, reason and timezone-aware deadline required'});
    }
    const c=auth.context;
    const {data,error}=await db.rpc('assessment_round_transition',{p_tenant:c.tenantId,p_round:roundId,p_version:version,p_target:state,
      p_closes_at:closesAt||null,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:reason});
    if(error)throw error;return res.json({round:data});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Round transition unavailable':error.message});
  }
}
