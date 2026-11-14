import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Panel policy unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {roundId,version,proposers,approvers,discussion,reason}=req.body||{};
    if(typeof roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(roundId)||!Number.isSafeInteger(version)||version<1
      ||[proposers,approvers,discussion].some(list=>!Array.isArray(list)||list.length>3||new Set(list).size!==list.length||list.some(role=>!['judge','chair','approver'].includes(role)))
      ||typeof reason!=='string'||!reason.trim()||reason.length>20000)return res.status(400).json({error:'Round version, permitted roles and reason required'});
    const c=auth.context;
    const {data,error}=await db.rpc('assessment_panel_policy',{p_tenant:c.tenantId,p_round:roundId,p_version:version,
      p_proposers:proposers,p_approvers:approvers,p_discussion:discussion,p_actor_kind:c.memberId?'member':'tenant_user',
      p_actor:c.memberId||c.tenantUserId,p_reason:reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Panel policy unavailable':error.message});
  }
}
