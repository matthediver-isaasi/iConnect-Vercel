import { createHash, randomUUID } from 'node:crypto';
import { lifecycleRows } from './memberLifecycleEvidence.js';
import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';
import { hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { sendEmail } from './emailService.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';
import { lifecycleStableDetail } from './memberLifecycleSnapshot.js';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function lifecycleNoticeKind(proposal, policy, now=new Date()) {
  if (['evidence_review','deletion_review'].includes(proposal.action)) return 'review';
  if (proposal.action==='archive') return 'archived';
  if (proposal.action!=='none' || !proposal.eligibleOn) return null;
  const difference=(new Date(`${proposal.eligibleOn}T00:00:00Z`)-new Date(`${lifecycleDay(now,policy.timezone)}T00:00:00Z`))/86400000;
  return difference>=0 && difference<=policy.notificationLeadDays ? 'approaching' : null;
}
export async function lifecycleReviewers(db,tenantId,deps={}) {
  const read=deps.read || lifecycleRows, admin=deps.admin || hasAdminAccess, feature=deps.feature || hasFeatureAccess;
  const recipients=[];
  const team=await read(db,'tenant_user',tenantId);
  for(const row of team){
    if(!row.email || row.is_active===false || (row.status && row.status!=='active'))continue;
    recipients.push({key:`tenant_user:${row.id}`,email:row.email});
  }
  const members=await read(db,'member',tenantId);
  for(const row of members){
    if(!row.email || row.login_enabled===false || ['archived','minimised','deleted'].includes(row.lifecycle_state))continue;
    const context={isAuthenticated:true,tenantId,memberId:row.id,roleId:row.role_id};
    if(!await admin(context))continue;
    const exclusions=row.member_excluded_features || [];
    if(await feature(row.role_id,'crm.member-lifecycle.view',exclusions)
      && await feature(row.role_id,'crm.member-lifecycle.review',exclusions)){
      recipients.push({key:`member:${row.id}`,email:row.email});
    }
  }
  const seen=new Set();
  return recipients.filter(row=>{const address=row.email.trim().toLowerCase();if(seen.has(address))return false;seen.add(address);return true;});
}
export async function queueLifecycleNotice(db,{tenantId,memberId,proposal,saved},deps={}){
  if(!saved.policy.notificationsEnabled)return;
  const kind=lifecycleNoticeKind(proposal,saved.policy);
  if(!kind)return;
  const recipients=await (deps.reviewers || lifecycleReviewers)(db,tenantId);
  if(!recipients.length)throw new Error('No authorised lifecycle reviewers are available');
  const key=createHash('sha256').update(JSON.stringify([memberId,saved.revision,kind,proposal.eligibleOn || proposal.reason])).digest('hex');
  for(const recipient of recipients){
    const {error}=await db.rpc('member_lifecycle_enqueue_notice',{p_tenant_id:tenantId,p_member_id:memberId,p_key:key,
      p_recipient:recipient.key,p_kind:kind,p_reason:proposal.reason,p_revision:saved.revision});
    if(error)throw error;
  }
}
export async function deliverLifecycleNotice(db,deps={}){
  const token=randomUUID();
  const claim=await db.rpc('member_lifecycle_claim_notice',{p_token:token});
  if(claim.error)throw claim.error;
  const notice=claim.data;if(!notice)return{processed:0};
  let status='needs_review', outcome='delivery_not_confirmed';
  let sendAttempted=false;
  try{
    const policy=await db.from('member_lifecycle_policy').select('policy,enabled,revision').eq('tenant_id',notice.tenant_id).single();
    if(policy.error)throw policy.error;
    const recipient=(await (deps.reviewers || lifecycleReviewers)(db,notice.tenant_id)).find(row=>row.key===notice.recipient);
    const current=await (deps.detail || lifecycleStableDetail)(db,notice.tenant_id,notice.member_id,policy.data.policy);
    const relevant=notice.kind==='archived'?current.state==='archived'
      :lifecycleNoticeKind(current.proposal,policy.data.policy)===notice.kind;
    if(!policy.data.enabled || policy.data.revision!==notice.policy_revision || !relevant || !policy.data.policy.notificationsEnabled || !recipient){
      status='cancelled';outcome='reviewer_or_notification_policy_no_longer_authorised';
    }else{
      const tenant=await db.from('tenant').select('*').eq('id',notice.tenant_id).single();
      if(tenant.error || !tenant.data)throw tenant.error || new Error('Tenant unavailable');
      const url=`${getTenantTrustedBaseUrl(null,tenant.data)}/MemberLifecycle`;
      sendAttempted=true;
      const result=await (deps.send || sendEmail)({to:recipient.email,tenantId:notice.tenant_id,
        subject:'Member lifecycle review requires attention',
        html:`<p>A member lifecycle record requires authorised review.</p><p>Reason: ${escape(notice.reason)}</p><p><a href="${escape(url)}">Open Member Lifecycle</a></p>`,
        enableTracking:false,disableTracking:true,resolveTransactionalPreferences:false,
        confidentialDiagnostics:true,inboxDelivery:{enabled:false}});
      if(result?.success===true){status='sent';outcome='provider_accepted';}
      else if(result?.ambiguousEffect){status='needs_review';outcome='provider_outcome_unknown';}
      else {status='pending';outcome='provider_rejected_retryable';}
    }
  }catch{
    // No blind resend after an uncertain provider exception. A pre-send lookup
    // failure is also visible for review rather than being recorded as delivery.
    status=sendAttempted?'needs_review':'pending';
    outcome=sendAttempted?'delivery_requires_reconciliation':'pre_delivery_lookup_retry';
  }
  const finished=await db.rpc('member_lifecycle_finish_notice',{p_id:notice.id,p_token:token,p_status:status,p_outcome:outcome});
  if(finished.error)throw finished.error;
  return{processed:1,status};
}
