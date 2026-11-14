import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Round advancement unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.approve');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {sourceRoundId,targetRoundId,selections,reason}=req.body||{};
    if(!uuid(sourceRoundId)||!uuid(targetRoundId)||!Array.isArray(selections)||!selections.length||selections.length>500
      ||selections.some(s=>!uuid(s.applicationId)||!uuid(s.shortlistDecisionId))||typeof reason!=='string'||!reason.trim()||reason.length>20000){
      return res.status(400).json({error:'Confirmed selections, target round and reason required'});
    }
    const c=auth.context;
    const {data,error}=await db.rpc('assessment_advance_round',{p_tenant:c.tenantId,p_source:sourceRoundId,p_target:targetRoundId,
      p_selections:selections,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514','23503'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Round advancement unavailable':error.message});
  }
}
