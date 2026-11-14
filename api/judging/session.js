import { createHmac } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { newCredential, credentialHash, judgingCookie, readJudgingCookie, JUDGING_COOKIE } from '../_lib/assessment/credentials.js';

export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(!['GET','POST','DELETE'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Judging unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    if(!tenant?.id)return res.status(404).json({error:'Judging unavailable'});
    if(req.method==='GET'){
      const hash=credentialHash(readJudgingCookie(req));
      if(!hash)return res.status(401).json({error:'Judging invitation required'});
      const {data,error}=await database.rpc('assessment_session_authority',{p_tenant:tenant.id,p_session_hash:hash});
      if(error)return res.status(error.code==='42501'?401:503).json({error:'Judging session unavailable'});
      return res.json({authenticated:true,roundId:data.round_id,appointmentId:data.appointment_id,expiresAt:data.expires_at});
    }
    if(req.headers?.['x-judging-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json')){
      return res.status(403).json({error:'Open your judging invitation to continue'});
    }
    if(req.method==='DELETE'){
      const hash=credentialHash(readJudgingCookie(req));
      const csrfHash=credentialHash(req.headers?.['x-judging-csrf']);
      if(!hash||!csrfHash)return res.status(403).json({error:'Session verification required'});
      const {error}=await database.rpc('assessment_session_logout',{p_tenant:tenant.id,p_session_hash:hash,p_csrf_hash:csrfHash});
      if(error)return res.status(error.code==='42501'?403:503).json({error:'Sign-out could not be confirmed'});
      res.setHeader('Set-Cookie',`${JUDGING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return res.json({signedOut:true});
    }
    const secret=dependencies.rateLimitSecret||process.env.SESSION_SECRET;
    if(!secret)return res.status(503).json({error:'Judging access configuration unavailable'});
    const ip=String(req.headers?.['x-vercel-forwarded-for']||req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
    const clientHash=createHmac('sha256',secret).update(`judging:${tenant.id}:${ip}`).digest('hex');
    const limit=await database.rpc('assessment_consume_access_limit',{p_tenant:tenant.id,p_client_hash:clientHash});
    if(limit.error)return res.status(503).json({error:'Judging verification temporarily unavailable'});
    if(limit.data!==true)return res.status(429).json({error:'Too many invitation attempts. Try again in 15 minutes.'});
    const tokenHash=credentialHash(req.body?.token);
    if(!tokenHash||typeof req.body?.accept!=='boolean')return res.status(400).json({error:'Invalid invitation request'});
    const session=newCredential(), csrf=newCredential();
    const {data,error}=await database.rpc('assessment_redeem_invitation',{
      p_tenant:tenant.id,p_token_hash:tokenHash,p_session_hash:credentialHash(session),
      p_csrf_hash:credentialHash(csrf),p_accept:req.body.accept,
    });
    if(error)return res.status(error.code==='42501'?403:503).json({error:'Invitation unavailable or expired. Request a new invitation.'});
    if(data.accepted)res.setHeader('Set-Cookie',judgingCookie(session,data.expires_at));
    return res.json({accepted:data.accepted,csrfToken:data.accepted?csrf:null,expiresAt:data.expires_at});
  }catch{return res.status(503).json({error:'Judging access temporarily unavailable'});}
}
