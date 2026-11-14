import {createHash} from 'node:crypto';
import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {renderCpdCertificatePdf} from '../_lib/cpdCertificatePdf.js';
import {validateAwardTemplate,postgresBytes,awardCertificateContext,certificateKeys} from '../_lib/assessment/certificates.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Certificates unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.certificates');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context;
    if(req.method==='GET'){
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      if(req.query?.scope==='links'){
        if(!uuid(req.query.issueId))return res.status(400).json({error:'Issued certificate required'});
        const {data,error}=await db.rpc('awards_certificate_links',{p_tenant:c.tenantId,p_issue:req.query.issueId,p_page:page});
        if(error)throw error;return res.json(data);
      }
      if(req.query?.templateId){
        if(!uuid(req.query.templateId))return res.status(400).json({error:'Invalid template'});
        const result=await db.from('awards_certificate_template').select('source_pdf').eq('tenant_id',c.tenantId).eq('id',req.query.templateId).single();
        if(result.error)throw result.error;
        res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="award-template.pdf"');
        return res.send(postgresBytes(result.data.source_pdf));
      }
      const templates=await db.from('awards_certificate_template').select('id,series_id,revision,name,placeholders,created_at',{count:'exact'})
        .eq('tenant_id',c.tenantId).order('series_id').order('revision',{ascending:false}).range((page-1)*50,page*50-1);
      if(templates.error)throw templates.error;
      let issues={data:[],count:0};
      if(req.query?.awardId){
        if(!uuid(req.query.awardId))return res.status(400).json({error:'Invalid award'});
        issues=await db.from('awards_certificate_issue').select('id,outcome_revision_id,template_id,created_at',{count:'exact'})
          .eq('tenant_id',c.tenantId).eq('award_id',req.query.awardId).order('created_at',{ascending:false}).order('id').range((page-1)*50,page*50-1);
        if(issues.error)throw issues.error;
      }
      return res.json({templates:templates.data,templateTotal:templates.count,issues:issues.data,issueTotal:issues.count,page,pageSize:50,placeholderKeys:certificateKeys});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body||{},actor={p_tenant:c.tenantId,p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId};
    if(input.command==='revoke_links'){
      if(!uuid(input.issueId)||typeof input.version!=='string'||!/^[a-f0-9]{32}$/.test(input.version)
        ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)return res.status(400).json({error:'Certificate, link version and revocation reason required'});
      const {data,error}=await db.rpc('awards_revoke_certificate_links',{...actor,p_issue:input.issueId,p_version:input.version,p_reason:input.reason});
      if(error)throw error;return res.json(data);
    }
    if(input.command==='template'){
      if(typeof input.name!=='string'||!input.name.trim()||input.name.length>300||!Number.isSafeInteger(input.revision)||input.revision<0
        ||input.seriesId&&!uuid(input.seriesId))return res.status(400).json({error:'Template name and current revision required'});
      let bytes;
      if(input.sourceTemplateId){
        if(!uuid(input.sourceTemplateId))return res.status(400).json({error:'Invalid source template'});
        const source=await db.from('awards_certificate_template').select('source_pdf').eq('tenant_id',c.tenantId).eq('id',input.sourceTemplateId).single();
        if(source.error)throw source.error;bytes=postgresBytes(source.data.source_pdf);
      }else{
        const path=input.sourcePath;
        if(typeof path!=='string'||!path.startsWith(`${c.tenantId}/awards-certificate-template/`)
          ||path.includes('..')||/[%\\\0\r\n?#]/.test(path))return res.status(400).json({error:'Upload a private award certificate template PDF first'});
        const source=await db.storage.from('private-uploads').download(path);
        if(source.error||!source.data)throw new Error('Uploaded template unavailable');
        if(source.data.size>10*1024*1024)return res.status(400).json({error:'Template exceeds the existing 10 MB PDF limit'});
        bytes=Buffer.from(await source.data.arrayBuffer());
      }
      try{await validateAwardTemplate(bytes,input.placeholders);}catch(error){return res.status(400).json({error:error.message});}
      const {data,error}=await db.rpc('awards_save_certificate_template',{...actor,p_series:input.seriesId||null,p_revision:input.revision,
        p_name:input.name,p_hex:bytes.toString('hex'),p_placeholders:input.placeholders});
      if(error)throw error;return res.json({template:data});
    }
    if(!['preview','issue'].includes(input.command)||!uuid(input.outcomeId)||!uuid(input.templateId)){
      return res.status(400).json({error:'Approved outcome and certificate template required'});
    }
    if(input.command==='issue'&&(input.approved!==true||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000)){
      return res.status(400).json({error:'Explicit generation approval and reason required'});
    }
    const template=await db.from('awards_certificate_template').select('id,source_pdf,placeholders')
      .eq('tenant_id',c.tenantId).eq('id',input.templateId).single();
    if(template.error)throw template.error;
    let context;try{context=await awardCertificateContext(db,c.tenantId,input.outcomeId,input.recipientName);}
    catch(error){return res.status(400).json({error:error.message||'Certificate recipient unavailable'});}
    const pdf=await renderCpdCertificatePdf(postgresBytes(template.data.source_pdf),template.data.placeholders,context.values);
    if(input.command==='preview'){
      res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="award-certificate-preview.pdf"');
      return res.send(pdf);
    }
    const {data,error}=await db.rpc('awards_issue_certificate',{...actor,p_outcome:input.outcomeId,p_template:input.templateId,
      p_recipient:{...context.recipient,values:context.values},p_hex:pdf.toString('hex'),p_digest:createHash('sha256').update(pdf).digest('hex'),p_reason:input.reason});
    if(error)throw error;return res.json({...data,delivery:'unchanged',sent:false});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514','23505'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Certificate operation could not be completed':error.message});
  }
}
