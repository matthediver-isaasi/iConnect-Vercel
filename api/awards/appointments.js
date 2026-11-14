import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Appointment administration unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const page=Number(req.query?.page||1);
    if(!Number.isSafeInteger(page)||page<1||page>1000)return res.status(400).json({error:'Invalid page'});
    if(req.query?.search!==undefined){
      if(!['member','contact'].includes(req.query.kind)||typeof req.query.search!=='string'
        ||req.query.search.trim().length<2||req.query.search.length>200)return res.status(400).json({error:'Select an identity type and enter at least two search characters'});
      const {data,error}=await db.rpc('awards_identity_lookup',{
        p_tenant:auth.context.tenantId,p_kind:req.query.kind,p_query:req.query.search,p_page:page,
      });
      if(error)throw error;return res.json(data);
    }
    if(typeof req.query?.roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(req.query.roundId))return res.status(400).json({error:'Round required'});
    const {data,error,count}=await db.from('assessment_appointment')
      .select('id,round_id,member_id,contact_id,external_email,external_name,role,state,available,capacity,expires_at,version',{count:'exact'})
      .eq('tenant_id',auth.context.tenantId).eq('round_id',req.query.roundId).order('id').range((page-1)*25,page*25-1);
    if(error)throw error;return res.json({appointments:data,total:count,page,pageSize:25});
  }catch{return res.status(503).json({error:'Appointment administration temporarily unavailable'});}
}
