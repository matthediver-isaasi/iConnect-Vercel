import { getSessionMember } from '../session.js';
import { resolveTenantFromRequest } from '../tenantResolver.js';
import { credentialHash, readJudgingCookie, checkJudgingCsrf } from './credentials.js';

export async function resolveJudgingAuthority(database, req, { mutate=false, resolveTenant=resolveTenantFromRequest, getMember=getSessionMember }={}) {
  const tenant=await resolveTenant(req);
  if(!tenant?.id)throw Object.assign(new Error('Judging unavailable'),{status:404});
  // Normal member identity takes precedence. An external cookie must never
  // turn a signed-in member into another judge on a shared browser.
  const member=await getMember(req);
  if(member){
    if((member.tenant_id||member.organization?.tenant_id)!==tenant.id)throw Object.assign(new Error('Judging unavailable'),{status:403});
    if(mutate&&(req.headers?.['x-judging-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json')))throw Object.assign(new Error('Invalid judging request'),{status:403});
    return{tenantId:tenant.id,memberId:member.id};
  }
  const sessionHash=credentialHash(readJudgingCookie(req));
  if(!sessionHash)throw Object.assign(new Error('Sign in or use a judging invitation'),{status:401});
  const {data,error}=await database.rpc('assessment_session_authority',{p_tenant:tenant.id,p_session_hash:sessionHash});
  if(error||!data)throw Object.assign(new Error('Judging session unavailable'),{status:error?.code==='42501'?401:503});
  if(mutate&&!checkJudgingCsrf(req,data.csrf_hash))throw Object.assign(new Error('Judging session verification failed'),{status:403});
  return{tenantId:tenant.id,sessionHash,csrfHash:data.csrf_hash,appointmentId:data.appointment_id,roundId:data.round_id};
}

export async function ownedAssignment(database,authority,assignmentId,{declaringConflict=false}={}){
  const {data:assignment,error}=await database.from('assessment_assignment').select('*')
    .eq('tenant_id',authority.tenantId).eq('id',assignmentId).maybeSingle();
  if(error)throw error;
  if(!assignment)throw Object.assign(new Error('Assignment unavailable'),{status:404});
  let query=database.from('assessment_appointment').select('id,state,expires_at,role,round_id')
    .eq('tenant_id',authority.tenantId).eq('round_id',assignment.round_id).eq('id',assignment.appointment_id);
  if(authority.memberId)query=query.eq('member_id',authority.memberId);
  else if(assignment.appointment_id!==authority.appointmentId)throw Object.assign(new Error('Assignment unavailable'),{status:404});
  const {data:appointment,error:appointmentError}=await query.maybeSingle();
  if(appointmentError)throw appointmentError;
  if(!appointment||appointment.state!=='accepted'||appointment.expires_at&&Date.parse(appointment.expires_at)<=Date.now()
    ||assignment.state!=='assigned'||!declaringConflict&&!['none','cleared'].includes(assignment.conflict))throw Object.assign(new Error('Assignment unavailable'),{status:403});
  return assignment;
}
