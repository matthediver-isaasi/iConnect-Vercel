import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {newCredential,credentialHash} from '../_lib/assessment/credentials.js';
import {sealInvitation} from '../_lib/assessment/deliveryCredentials.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Invitations unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use the awards administration page'});
    const {appointmentId,version,revoke,reason}=req.body||{};
    if(typeof appointmentId!=='string'||!/^[0-9a-f-]{36}$/i.test(appointmentId)||!Number.isSafeInteger(version)||version<1
      ||typeof revoke!=='boolean'||typeof reason!=='string'||!reason.trim()||reason.length>10000)return res.status(400).json({error:'Appointment, version, action and reason required'});
    const ctx=auth.context,token=newCredential();
    const common={p_tenant:ctx.tenantId,p_appointment:appointmentId,p_expected_version:version,
      p_actor_kind:ctx.memberId?'member':'tenant_user',p_actor:ctx.memberId||ctx.tenantUserId,p_reason:reason};
    const {data,error}=revoke?await db.rpc('assessment_rotate_invitation',{...common,p_revoke:true,p_token_hash:null}):
      await db.rpc('awards_queue_invitation',{...common,p_token_hash:credentialHash(token),
        p_envelope:sealInvitation(token,`${ctx.tenantId}:${appointmentId}`,dependencies.encryptionSecret)});
    if(error)throw error;return res.json({...data,delivery:revoke?null:'queued'});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:error.code==='P0001'?400:503;
    return res.status(status).json({error:status===503?'Invitation action could not be completed':error.message});
  }
}
