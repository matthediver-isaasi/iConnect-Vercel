import { supabase } from '../_lib/database.js';
import { authorizeAwards } from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Database unavailable'});
  try{
    let auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.applications');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.moderate');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.approve');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error,code:auth.code});
    const context=auth.context;
    if(req.method==='GET'){
      if(!uuid(req.query?.awardId))return res.status(400).json({error:'Award ID required'});
      const page=Number(req.query.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>100000)return res.status(400).json({error:'Invalid page'});
      const {data,error,count}=await database.from('awards_application')
        .select('id,reference,eligibility,eligibility_reason,duplicate_flag,version,created_at,submission_id',{count:'exact'})
        .eq('tenant_id',context.tenantId).eq('award_id',req.query.awardId).order('created_at',{ascending:false}).order('id')
        .range((page-1)*50,page*50-1);
      if(error)throw error;
      return res.json({applications:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||!String(req.headers?.['content-type']||'').startsWith('application/json')
      ||req.headers?.['sec-fetch-site']==='cross-site')return res.status(403).json({error:'Use the awards administration page'});
    const {applicationId,version,state,reason}=req.body||{};
    if(!uuid(applicationId)||!Number.isSafeInteger(version)||version<1
      ||!['pending','eligible','ineligible','withdrawn','disqualified'].includes(state)
      ||typeof reason!=='string'||!reason.trim()||reason.length>10000)return res.status(400).json({error:'Application, version, state and reason required'});
    const {data,error}=await database.rpc('awards_application_decide',{
      p_tenant:context.tenantId,p_application:applicationId,p_expected_version:version,
      p_actor_kind:context.memberId?'member':'tenant_user',p_actor:context.memberId||context.tenantUserId,
      p_state:state,p_reason:reason,p_self_service:false,
    });
    if(error)throw error;
    return res.json({application:data});
  }catch(error){
    const status=['42P01','PGRST202','PGRST205'].includes(error.code)?503:['40001','PT409'].includes(error.code)?409:
      error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:500;
    return res.status(status).json({error:status===503?'Awards database setup is not installed':status===500?'Unable to process application request':error.message});
  }
}
