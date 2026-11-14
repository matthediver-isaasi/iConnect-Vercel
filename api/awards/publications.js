import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Publication unavailable'});
  try{
    let auth=await authorizeAwards(req,db,dependencies.getTenantContext,
      req.body?.command==='release'?'awards.management.communicate':'awards.management.publish');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.approve');
    if(req.method==='GET'&&!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.communicate');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const ctx=auth.context;
    if(req.method==='GET'){
      const awardId=req.query?.awardId,page=Number(req.query?.page||1);
      if(!uuid(awardId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Award and page required'});
      if(req.query?.scope==='eventLinks'){
        const {data,error}=await db.rpc('awards_publication_event_links',{p_tenant:ctx.tenantId,p_award:awardId,p_page:page});
        if(error)throw error;return res.json(data);
      }
      const {data,error,count}=await db.from('awards_publication_revision')
        .select('id,outcome_revision_id,event_link_id,revision,audience,action,safe_projection,reason,created_at',{count:'exact'})
        .eq('tenant_id',ctx.tenantId).eq('award_id',awardId).order('created_at',{ascending:false}).order('id').range((page-1)*50,page*50-1);
      if(error)throw error;return res.json({publications:data,total:count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body||{},actor={p_tenant:ctx.tenantId,p_actor_kind:ctx.memberId?'member':'tenant_user',p_actor:ctx.memberId||ctx.tenantUserId};
    if(!uuid(input.outcomeId)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000)return res.status(400).json({error:'Outcome and reason required'});
    if(input.command==='release'){
      const {data,error}=await db.rpc('awards_release_outcome',{...actor,p_outcome:input.outcomeId,p_reason:input.reason});
      if(error)throw error;return res.json({...data,delivery:'authorised',sent:false});
    }
    if(input.command!=='publish'||!['publish','correct','retract'].includes(input.action)||!['public','member'].includes(input.audience)
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.eventLinkId&&!uuid(input.eventLinkId)){
      return res.status(400).json({error:'Publication action, audience and current revision required'});
    }
    const p=input.projection||{};
    if(input.action!=='retract'&&(typeof p.title!=='string'||!p.title.trim()||p.title.length>300
      ||typeof p.recipient!=='string'||p.recipient.length>300||typeof p.summary!=='string'||p.summary.length>5000)){
      return res.status(400).json({error:'Enter only the text authorised for publication'});
    }
    const {data,error}=await db.rpc('awards_publish_outcome',{...actor,p_outcome:input.outcomeId,p_event_link:input.eventLinkId||null,
      p_audience:input.audience,p_action:input.action,p_expected_revision:input.expectedRevision,p_projection:p,p_reason:input.reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Publication action unavailable':error.message});
  }
}
