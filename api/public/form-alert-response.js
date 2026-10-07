import { createHash } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveFormAlertCapability } from '../_lib/formAlertCapabilities.js';
import { FORM_ALERTS_RELEASE_READY } from '../_lib/formAlertReleaseGate.js';

export default async function handler(req,res,deps={}) {
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  const unavailable=()=>res.status(404).json({error:'This response is unavailable or the link has expired.'});
  if(!FORM_ALERTS_RELEASE_READY) return unavailable();
  try {
    const db=deps.db||supabase;
    const ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
    const {data:allowed,error:limitError}=await db.rpc('limit_form_alert_reads',{
      p_key:createHash('sha256').update(ip).digest('hex'),
    });
    if(limitError) throw limitError;
    if(allowed!==true) return res.status(429).json({error:'Please try again later.'});
    // Capability links always use their trusted tenant host, never embed-style
    // query/body tenant overrides. Do not pass arbitrary query data to logging.
    const tenant=await (deps.resolveTenantFromRequest||resolveTenantFromRequest)({...req,query:{},body:{}});
    if(!tenant?.id) return unavailable();
    const result=await (deps.resolveCapability||resolveFormAlertCapability)(db,tenant.id,req.headers['x-form-alert-token']);
    if(!result) return unavailable();
    if(req.query?.attachment !== undefined) {
      const index=String(req.query.attachment);
      const file=/^(0|[1-9][0-9]{0,3})$/.test(index) ? result.attachments[Number(index)] : null;
      if(!file || result.anonymous) return unavailable();
      const {data,error}=await db.storage.from(file.bucket).download(file.path);
      if(error || !data || data.size>20*1024*1024) return unavailable();
      res.setHeader('Content-Type','application/octet-stream');
      res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
      return res.status(200).send(Buffer.from(await data.arrayBuffer()));
    }
    // The transport allowlist excludes internal file paths and storage buckets.
    const {form_name,submitted_at,anonymous,answers}=result;
    return res.status(200).json({form_name,submitted_at,anonymous,answers});
  } catch {
    // Do not log headers, request URLs, bearer material or response contents.
    return unavailable();
  }
}
