import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {validateCriteria} from '../_lib/assessment/scoring.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Criteria revision unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {roundId,version,definition,closesAt,reason}=req.body||{};
    if(typeof roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(roundId)||!Number.isSafeInteger(version)||version<1
      ||typeof reason!=='string'||!reason.trim()||reason.length>20000||typeof closesAt!=='string'
      ||!/(Z|[+-]\d{2}:\d{2})$/.test(closesAt)||!Number.isFinite(Date.parse(closesAt)))return res.status(400).json({error:'Round version, future deadline and reason required'});
    try{validateCriteria(definition);}catch(error){return res.status(400).json({error:error.message});}
    const c=auth.context;
    const {data,error}=await db.rpc('assessment_revise_criteria',{p_tenant:c.tenantId,p_round:roundId,p_version:version,
      p_definition:definition,p_deadline:closesAt,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Criteria revision unavailable':error.message});
  }
}
