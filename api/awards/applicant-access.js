import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Applicant access unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.applications');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const input=req.method==='GET'?req.query||{}:req.body||{},page=Number(input.page||1);
    if(!uuid(input.applicationId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Application and page required'});
    if(req.method==='POST'&&(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json')))return res.status(403).json({error:'Use awards administration'});
    if(req.method==='POST'&&(typeof input.version!=='string'||!/^[a-f0-9]{32}$/.test(input.version)
      ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000))return res.status(400).json({error:'Access version and reason required'});
    const c=auth.context;
    const {data,error}=await db.rpc('awards_applicant_access_control',{p_tenant:c.tenantId,p_application:input.applicationId,
      p_command:req.method==='GET'?'read':'revoke',p_page:page,p_version:input.version||null,
      p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:input.reason||null});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:error.code==='P0001'?400:503;
    return res.status(status).json({error:status===503?'Applicant access unavailable':error.message});
  }
}
