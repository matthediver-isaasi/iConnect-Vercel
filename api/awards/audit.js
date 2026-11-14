import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Audit history unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.report');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const {awardId}=req.query||{},page=Number(req.query?.page||1);
    if(typeof awardId!=='string'||!/^[0-9a-f-]{36}$/i.test(awardId)||!Number.isSafeInteger(page)||page<1||page>10000){
      return res.status(400).json({error:'Award and page required'});
    }
    const {data,error,count}=await db.from('awards_audit_event')
      .select('id,action,subject_id,reason,changes,created_at',{count:'exact'})
      .eq('tenant_id',auth.context.tenantId).eq('award_id',awardId)
      .order('created_at',{ascending:false}).order('id',{ascending:false}).range((page-1)*50,page*50-1);
    if(error)throw error;return res.json({events:data,total:count,page,pageSize:50});
  }catch{return res.status(503).json({error:'Audit history could not be loaded'});}
}
