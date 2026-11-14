import {supabase} from '../_lib/database.js';
import {resolveTenantFromRequest} from '../_lib/tenantResolver.js';
import {credentialHash} from '../_lib/assessment/credentials.js';
import applicationHandler from './my-applications.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Application unavailable'});
  try{
    const tenant=await (dependencies.resolveTenant||resolveTenantFromRequest)(req);
    const hash=credentialHash(req.headers?.['x-awards-applicant']);
    const input=req.method==='GET'?req.query||{}:req.body||{};
    if(!tenant?.id||!hash||!uuid(input.applicationId))return res.status(403).json({error:'Use the secure link in your application email'});
    if(req.method==='GET'&&(input.edit==='1'||input.review==='1'||input.attachmentId)||req.method==='POST'&&input.command==='amend'){
      return applicationHandler(req,res,{...dependencies,supabase:db,resolveTenant:async()=>tenant,externalAccessHash:hash});
    }
    if(req.method==='GET'){
      if(input.issueId){
        if(!uuid(input.issueId))return res.status(400).json({error:'Invalid certificate'});
        const {data,error}=await db.rpc('awards_applicant_certificate',{p_tenant:tenant.id,p_application:input.applicationId,p_hash:hash,p_issue:input.issueId});
        if(error)throw error;
        res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="award-certificate.pdf"');
        return res.send(Buffer.from(data.hex,'hex'));
      }
      const {data,error}=await db.rpc('awards_applicant_status',{p_tenant:tenant.id,p_member:null,p_application:input.applicationId,p_page:1,p_access_hash:hash});
      if(error)throw error;
      if(data?.applications?.length!==1)return res.status(403).json({error:'Applicant access expired, revoked or unavailable'});
      return res.json(data);
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use your secure application page'});
    if(input.command!=='withdraw'||!Number.isSafeInteger(input.version)||input.version<1
      ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)return res.status(400).json({error:'Application version and withdrawal reason required'});
    const {data,error}=await db.rpc('awards_external_withdraw',{p_tenant:tenant.id,p_application:input.applicationId,
      p_hash:hash,p_version:input.version,p_reason:input.reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=error.code==='42501'?403:['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Application unavailable':error.message});
  }
}
