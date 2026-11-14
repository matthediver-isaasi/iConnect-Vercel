import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {validateCriteria} from '../_lib/assessment/scoring.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Templates unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context;
    if(req.method==='GET'){
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const {data,error}=await db.rpc('assessment_list_templates',{p_tenant:c.tenantId,p_page:page});
      if(error)throw error;return res.json(data);
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {seriesId,revision,name,definition}=req.body||{};
    if(seriesId&&!(typeof seriesId==='string'&&/^[0-9a-f-]{36}$/i.test(seriesId))||!Number.isSafeInteger(revision)||revision<0
      ||typeof name!=='string'||!name.trim()||name.length>300)return res.status(400).json({error:'Template name and version required'});
    try{validateCriteria(definition);}catch(error){return res.status(400).json({error:error.message});}
    const {data,error}=await db.rpc('assessment_save_template',{p_tenant:c.tenantId,p_series:seriesId||null,p_revision:revision,
      p_name:name,p_definition:definition,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId});
    if(error)throw error;return res.json({template:data});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Scoring template action unavailable':error.message});
  }
}
