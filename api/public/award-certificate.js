import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {getSessionMember} from '../_lib/session.js';
import {credentialHash} from '../_lib/assessment/credentials.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Certificate unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    if(!tenant?.id)return res.status(404).json({error:'Certificate unavailable'});
    const issueId=req.query?.issueId;
    if(typeof issueId!=='string'||!/^[0-9a-f-]{36}$/i.test(issueId))return res.status(400).json({error:'Certificate required'});
    const rawToken=req.headers?.['x-awards-certificate-token'],hash=rawToken?credentialHash(rawToken):null;
    if(rawToken&&!hash)return res.status(401).json({error:'Certificate link invalid'});
    let member=null;
    if(!hash){
      member=await (dependencies.getMember||getSessionMember)(req);
      if(!member||(member.tenant_id||member.organization?.tenant_id)!==tenant.id)return res.status(401).json({error:'Sign in or use your certificate link'});
    }
    const {data,error}=await db.rpc('awards_read_certificate',{p_tenant:tenant.id,p_issue:issueId,p_member:member?.id||null,p_token_hash:hash});
    if(error)throw error;
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="award-certificate.pdf"');
    return res.send(Buffer.from(data.hex,'hex'));
  }catch(error){return res.status(error.code==='42501'?404:503).json({error:'Certificate unavailable'});}
}
