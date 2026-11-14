import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;
  if(!db)return res.status(503).json({error:'Awards unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,req.method==='GET'?'awards.management':'awards.management.configure');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const context=auth.context;
    if(req.method==='GET'){
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const {data,error,count}=await db.from('awards_programme').select('*',{count:'exact'}).eq('tenant_id',context.tenantId)
        .order('created_at',{ascending:false}).order('id').range((page-1)*50,page*50-1);
      if(error)throw error;return res.json({programmes:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use the awards administration page'});
    const {id,version,payload}=req.body||{};
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>50000
      ||id&&(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)||!Number.isSafeInteger(version)||version<1)){
      return res.status(400).json({error:'Invalid programme configuration'});
    }
    const {data,error}=await db.rpc('awards_programme_command',{
      p_tenant:context.tenantId,p_actor_kind:context.memberId?'member':'tenant_user',p_actor:context.memberId||context.tenantUserId,
      p_id:id||null,p_expected_version:version||null,p_payload:payload,
    });
    if(error)throw error;return res.json({programme:data});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514','23502'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Programme configuration unavailable':error.message});
  }
}
