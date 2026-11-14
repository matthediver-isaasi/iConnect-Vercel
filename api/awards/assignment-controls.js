import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Assignments unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context;
    if(req.method==='GET'){
      const roundId=req.query?.roundId,page=Number(req.query?.page||1);
      if(!uuid(roundId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Round and page required'});
      if(req.query?.scope==='panel'){
        const {data,error,count}=await db.from('assessment_panel_conflict')
          .select('id,appointment_id,application_id,state,reason,version',{count:'exact'})
          .eq('tenant_id',c.tenantId).eq('round_id',roundId).order('id').range((page-1)*50,page*50-1);
        if(error)throw error;return res.json({conflicts:data,total:count,page,pageSize:50});
      }
      const {data,error,count}=await db.from('assessment_assignment')
        .select('id,appointment_id,application_id,state,included,inclusion_reason,conflict,conflict_reason,decline_reason,version',{count:'exact'})
        .eq('tenant_id',c.tenantId).eq('round_id',roundId).order('id').range((page-1)*50,page*50-1);
      if(error)throw error;return res.json({assignments:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body||{};
    if(!uuid(input.id)||!Number.isSafeInteger(input.version)||input.version<1||typeof input.reason!=='string'
      ||!input.reason.trim()||input.reason.length>20000)return res.status(400).json({error:'Current record, version and reason required'});
    const actor={p_tenant:c.tenantId,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:input.reason,p_version:input.version};
    let result;
    if(input.command==='panel_conflict'){
      if(!['cleared','confirmed'].includes(input.state))return res.status(400).json({error:'Conflict review decision required'});
      result=await db.rpc('assessment_panel_review_conflict',{...actor,p_conflict:input.id,p_state:input.state});
    }else if(input.command==='availability'){
      if(typeof input.available!=='boolean'||!Number.isSafeInteger(input.capacity)||input.capacity<0||input.capacity>10000
        ||typeof input.expiresAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt)||!Number.isFinite(Date.parse(input.expiresAt))){
        return res.status(400).json({error:'Availability, capacity and explicit expiry timezone required'});
      }
      result=await db.rpc('assessment_appointment_availability',{...actor,p_appointment:input.id,p_available:input.available,p_capacity:input.capacity,p_expiry:input.expiresAt});
    }else{
      if(!['remove','restore','exclude','include','clear_conflict','confirm_conflict'].includes(input.command))return res.status(400).json({error:'Unknown assignment command'});
      result=await db.rpc('assessment_assignment_command',{...actor,p_assignment:input.id,p_command:input.command});
    }
    if(result.error)throw result.error;return res.json(result.data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Assignment change unavailable':error.message});
  }
}
