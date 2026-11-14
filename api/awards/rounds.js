import { supabase } from '../_lib/database.js';
import { authorizeAwards } from './index.js';
import { validateCriteria } from '../_lib/assessment/scoring.js';
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Database unavailable'});
  try {
    const command=req.body?.command;
    const capability=req.method==='GET'?'awards.management':command==='appoint'?'awards.management.assign':'awards.management.configure';
    const auth=await authorizeAwards(req,database,dependencies.getTenantContext,capability);
    if(!auth.context)return res.status(auth.status).json({error:auth.error,code:auth.code});
    const context=auth.context;
    const awardId=req.method==='GET'?req.query?.awardId:req.body?.awardId;
    if(!validId(awardId))return res.status(400).json({error:'Award ID required'});
    if(req.method==='GET'){
      if(req.query?.roundId){
        if(!validId(req.query.roundId))return res.status(400).json({error:'Invalid round ID'});
        const {data:round,error:roundError}=await database.from('assessment_round').select('*')
          .eq('tenant_id',context.tenantId).eq('award_id',awardId).eq('id',req.query.roundId).maybeSingle();
        if(roundError)throw roundError;
        if(!round)return res.status(404).json({error:'Round unavailable'});
        const {data:criteria,error:criteriaError}=await database.from('assessment_criteria_version').select('id,revision,definition,template_version_id')
          .eq('tenant_id',context.tenantId).eq('round_id',round.id).order('revision',{ascending:false}).limit(1);
        if(criteriaError)throw criteriaError;
        return res.json({round,criteria:criteria[0]||null});
      }
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const {data,error,count}=await database.from('assessment_round').select('*',{count:'exact'})
        .eq('tenant_id',context.tenantId).eq('award_id',awardId).order('position').range((page-1)*50,page*50-1);
      if(error)throw error;
      return res.json({rounds:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||!String(req.headers?.['content-type']||'').startsWith('application/json')
      ||req.headers?.['sec-fetch-site']==='cross-site')return res.status(403).json({error:'Use the awards administration page'});
    const {roundId,version,payload}=req.body||{};
    if(!['create','configure','criteria','appoint','start'].includes(command)||!payload||typeof payload!=='object'||Array.isArray(payload)
      ||JSON.stringify(payload).length>200000
      ||command!=='create'&&(!validId(roundId)||!Number.isSafeInteger(version)||version<1)){
      return res.status(400).json({error:'Invalid round command'});
    }
    if(command==='criteria')validateCriteria(payload.definition);
    for(const key of ['opens_at','closes_at','expires_at']){
      if(payload[key]!=null && (typeof payload[key]!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(payload[key])
        ||!Number.isFinite(Date.parse(payload[key])))) return res.status(400).json({error:'Dates must include an explicit timezone offset'});
    }
    if(command==='appoint'&&payload.external_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.external_email)){
      return res.status(400).json({error:'A valid judge email is required'});
    }
    const {data,error}=await database.rpc('assessment_configure_round',{
      p_tenant:context.tenantId,p_award:awardId,p_round:command==='create'?null:roundId,
      p_expected_version:command==='create'?null:version,p_actor_kind:context.memberId?'member':'tenant_user',
      p_actor:context.memberId||context.tenantUserId,p_command:command,p_payload:payload,
    });
    if(error)throw error;
    return res.json({round:data});
  }catch(error){
    const status=['42P01','PGRST202','PGRST205'].includes(error.code)?503:['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:
      ['P0001','23514','23503','23505','22P02','22007'].includes(error.code)||!error.code?400:500;
    return res.status(status).json({error:status===503?'Awards database setup is not installed':status===500?'Unable to process round request':error.message});
  }
}
