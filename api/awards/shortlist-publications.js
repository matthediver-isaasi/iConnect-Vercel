import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Shortlist publication unavailable'});
  try{
    let auth=await authorizeAwards(req,db,dependencies.getTenantContext,req.body?.command==='release'?'awards.management.communicate':'awards.management.publish');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.communicate');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.approve');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context;
    if(req.method==='GET'){
      const awardId=req.query?.awardId,page=Number(req.query?.page||1);
      if(!uuid(awardId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Award and page required'});
      const {data,error}=await db.rpc('awards_shortlist_catalog',{p_tenant:c.tenantId,p_award:awardId,p_page:page});
      if(error)throw error;return res.json(data);
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body||{},actor={p_tenant:c.tenantId,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId};
    if(!uuid(input.shortlistId)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000)return res.status(400).json({error:'Shortlist decision and reason required'});
    if(input.command==='release'){
      const {data,error}=await db.rpc('awards_shortlist_release',{...actor,p_shortlist:input.shortlistId,p_reason:input.reason});
      if(error)throw error;return res.json({...data,sent:false});
    }
    if(input.command!=='publish'||!['publish','correct','retract'].includes(input.action)||!['public','member'].includes(input.audience)
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.eventLinkId&&!uuid(input.eventLinkId))return res.status(400).json({error:'Publication action and version required'});
    const p=input.projection||{};
    if(input.action!=='retract'&&(typeof p.title!=='string'||!p.title.trim()||p.title.length>300
      ||typeof p.recipient!=='string'||p.recipient.length>300||typeof p.summary!=='string'||p.summary.length>5000))return res.status(400).json({error:'Authorised public text required'});
    const {data,error}=await db.rpc('awards_publish_shortlist',{...actor,p_shortlist:input.shortlistId,p_event:input.eventLinkId||null,
      p_audience:input.audience,p_action:input.action,p_revision:input.expectedRevision,p_projection:p,p_reason:input.reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Shortlist publication unavailable':error.message});
  }
}
