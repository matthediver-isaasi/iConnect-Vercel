import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Event awards unavailable'});
  try{
    let auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'events.browse-events.create');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const ctx=auth.context;
    if(req.method==='GET'){
      if(req.query?.progress==='1'){
        const {linkId}=req.query,page=Number(req.query.page||1);
        if(!uuid(linkId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Event association and page required'});
        const {data,error}=await db.rpc('awards_event_progress',{p_tenant:ctx.tenantId,p_link:linkId,p_page:page});
        if(error)throw error;return res.json(data);
      }
      const {eventId,type}=req.query||{},page=Number(req.query?.page||1);
      if(!uuid(eventId)||!['event','complex'].includes(type)||!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Event and type required'});
      const {data,error,count}=await db.from('awards_event_link').select('*,award:awards_competition(id,name,state),programme:awards_programme(id,name)',{count:'exact'})
        .eq('tenant_id',ctx.tenantId).eq(type==='complex'?'complex_event_id':'event_id',eventId).order('id').range((page-1)*50,page*50-1);
      if(error)throw error;return res.json({links:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const {id,version,payload}=req.body||{};
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||id&&(!uuid(id)||!Number.isSafeInteger(version)||version<1)){
      return res.status(400).json({error:'Valid event association required'});
    }
    if(!id&&([payload.award_id,payload.programme_id].filter(uuid).length!==1
      ||[payload.event_id,payload.complex_event_id].filter(uuid).length!==1))return res.status(400).json({error:'Select one award or programme and one event'});
    const {data,error}=await db.rpc('awards_event_command',{
      p_tenant:ctx.tenantId,p_actor_kind:ctx.memberId?'member':'tenant_user',p_actor:ctx.memberId||ctx.tenantUserId,
      p_id:id||null,p_expected_version:version||null,p_payload:payload,
    });
    if(error)throw error;return res.json({link:data});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514','23505','23503'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Event awards temporarily unavailable':error.message});
  }
}
