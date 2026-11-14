import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {reviewProjection} from '../_lib/assessment/projection.js';
import {attachmentOffset,sendAttachmentChunk} from '../_lib/assessment/attachmentResponse.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Assessment history unavailable'});
  try{
    const evidence=['review','attachment'].includes(req.query?.scope);
    if(req.query?.scope&&!['history','review','attachment'].includes(req.query.scope))return res.status(400).json({error:'Invalid history scope'});
    let auth=await authorizeAwards(req,db,dependencies.getTenantContext,evidence?'awards.management.moderate':'awards.management.report');
    if(!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.moderate');
    if(!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.approve');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const {roundId,applicationId}=req.query||{},page=Number(req.query?.page||1);
    if(!uuid(roundId)||!uuid(applicationId)||!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Round, application and history page required'});
    if(evidence){
      const versionId=req.query?.versionId||null,attachmentId=req.query?.attachmentId;
      if(versionId&&!uuid(versionId)||req.query.scope==='attachment'&&!uuid(attachmentId))return res.status(400).json({error:'Invalid evidence reference'});
      const context=auth.context,args={p_tenant:context.tenantId,p_round:roundId,p_application:applicationId,
        p_actor_kind:context.memberId?'member':'tenant_user',p_actor:context.memberId||context.tenantUserId,p_version:versionId};
      const {data:snapshot,error}=await db.rpc('awards_staff_review',args);
      if(error)throw error;
      const review=reviewProjection(snapshot);
      if(req.query.scope==='review')return res.json({applicationVersionId:snapshot.id,review});
      if(!review.attachments.some(file=>file.id===attachmentId))return res.status(404).json({error:'Attachment unavailable'});
      const chunk=await db.rpc('awards_staff_attachment',{...args,p_attachment:attachmentId,p_offset:attachmentOffset(req.query.offset)});
      if(chunk.error)throw chunk.error;return sendAttachmentChunk(res,chunk.data);
    }
    const {data,error}=await db.rpc('assessment_submitted_history',{p_tenant:auth.context.tenantId,p_round:roundId,p_application:applicationId,p_page:page});
    if(error)throw error;return res.json(data);
  }catch(error){return res.status(error.code==='42501'?403:503).json({error:'Assessment history unavailable'});}
}
