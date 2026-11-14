import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {getSessionMember} from '../_lib/session.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Event awards unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    if(!tenant?.id)return res.status(404).json({error:'Event unavailable'});
    const {eventId,type}=req.query||{},audience=req.query?.audience||'public';
    if(typeof eventId!=='string'||!/^[0-9a-f-]{36}$/i.test(eventId)||!['event','complex'].includes(type)
      ||!['public','member'].includes(audience))return res.status(400).json({error:'Invalid event awards request'});
    if(audience==='member'){
      const member=await (dependencies.getMember||getSessionMember)(req);
      if(!member||(member.tenant_id||member.organization?.tenant_id)!==tenant.id)return res.status(401).json({error:'Member sign-in required'});
    }
    const event=await db.from(type==='complex'?'complex_event':'event').select('id,status')
      .eq('tenant_id',tenant.id).eq('id',eventId).maybeSingle();
    if(event.error)throw event.error;
    if(!event.data||event.data.status==='draft')return res.status(404).json({error:'Event unavailable'});
    const {data,error}=await db.rpc('awards_event_projection',{
      p_tenant:tenant.id,p_event:eventId,p_complex:type==='complex',p_audience:audience,
    });
    if(error)throw error;return res.json({awards:data});
  }catch{return res.status(503).json({error:'Event awards temporarily unavailable'});}
}
