import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {getSessionMember} from '../_lib/session.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Awards unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    if(!tenant?.id)return res.status(404).json({error:'Awards unavailable'});
    const awardId=req.query?.awardId,eventLinkId=req.query?.eventLinkId||null,audience=req.query?.audience||'public';
    if(typeof awardId!=='string'||!/^[0-9a-f-]{36}$/i.test(awardId)||eventLinkId&&!/^[0-9a-f-]{36}$/i.test(eventLinkId)
      ||!['public','member'].includes(audience))return res.status(400).json({error:'Invalid awards request'});
    if(audience==='member'){
      const member=await (dependencies.getMember||getSessionMember)(req);
      if(!member||(member.tenant_id||member.organization?.tenant_id)!==tenant.id)return res.status(401).json({error:'Member sign-in required'});
    }
    const {data,error}=await db.rpc('awards_public_outcomes',{
      p_tenant:tenant.id,p_award:awardId,p_audience:audience,p_event_link:eventLinkId,
    });
    if(error)throw error;
    const shortlists=await db.rpc('awards_public_shortlists',{p_tenant:tenant.id,p_award:awardId,p_audience:audience,p_event:eventLinkId});
    if(shortlists.error)throw shortlists.error;
    return res.json({outcomes:data,shortlists:shortlists.data});
  }catch{return res.status(503).json({error:'Published awards temporarily unavailable'});}
}
