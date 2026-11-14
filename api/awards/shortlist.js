import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {loadRankings,prepareShortlist} from '../_lib/assessment/rankings.js';
import {shortlistRecommendations} from '../_lib/assessment/scoring.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Shortlisting unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.approve');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body||{},ctx=auth.context;
    if(typeof input.roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.roundId)||!['preview','record'].includes(input.command)){
      return res.status(400).json({error:'Round and command required'});
    }
    const rankings=await loadRankings(db,ctx.tenantId,input.roundId);
    if(input.command==='preview'){
      const recommendation=shortlistRecommendations(rankings.entries.filter(e=>!e.moderationRequired||e.moderationState==='approved'),input);
      return res.json({...rankings,recommendation});
    }
    if(!input.fingerprints||Object.keys(input.fingerprints).length!==Object.keys(rankings.fingerprints).length
      ||Object.entries(rankings.fingerprints).some(([id,value])=>input.fingerprints[id]!==value)){
      return res.status(409).json({error:'Rankings changed; generate a fresh preview'});
    }
    const {decisions}=prepareShortlist(rankings,input);
    const {data,error}=await db.rpc('assessment_record_shortlist',{
      p_tenant:ctx.tenantId,p_round:input.roundId,p_actor_kind:ctx.memberId?'member':'tenant_user',p_actor:ctx.memberId||ctx.tenantUserId,
      p_mode:input.mode,p_decisions:decisions,p_fingerprints:rankings.fingerprints,p_reason:input.reason,
    });
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514'].includes(error.code)||!error.code?400:503;
    return res.status(status).json({error:status===503?'Shortlisting temporarily unavailable':error.message});
  }
}
