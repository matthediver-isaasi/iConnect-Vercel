import {supabase} from '../_lib/database.js';
import {resolveJudgingAuthority,ownedAssignment} from '../_lib/assessment/access.js';
import {reviewProjection} from '../_lib/assessment/projection.js';
import {attachmentOffset,sendAttachmentChunk} from '../_lib/assessment/attachmentResponse.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Attachment unavailable'});
  try{
    const {assignmentId,attachmentId}=req.query||{};
    if(![assignmentId,attachmentId].every(v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v)))return res.status(400).json({error:'Assignment and attachment required'});
    const authority=await resolveJudgingAuthority(db,req,dependencies);
    const assignment=await ownedAssignment(db,authority,assignmentId);
    const {data:snapshot,error:snapshotError}=await db.from('awards_application_version')
      .select('form_snapshot,answer_snapshot,attachment_manifest').eq('tenant_id',authority.tenantId)
      .eq('application_id',assignment.application_id).eq('id',assignment.application_version_id).maybeSingle();
    if(snapshotError)throw snapshotError;
    if(!reviewProjection(snapshot).attachments.some(file=>file.id===attachmentId))return res.status(404).json({error:'Attachment unavailable for this assignment'});
    const {data,error}=await db.rpc('assessment_read_attachment',{p_tenant:authority.tenantId,p_assignment:assignmentId,
      p_attachment:attachmentId,p_member:authority.memberId||null,p_session_hash:authority.sessionHash||null,p_offset:attachmentOffset(req.query?.offset)});
    if(error)throw error;
    return sendAttachmentChunk(res,data);
  }catch(error){
    const status=error.status||(['42501','P0002'].includes(error.code)?404:503);
    return res.status(status).json({error:status===503?'Attachment temporarily unavailable':'Attachment unavailable for this assignment'});
  }
}
