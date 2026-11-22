import { lifecycleStableDetail } from './memberLifecycleSnapshot.js';
import { lifecycleUuid } from './memberLifecycleReview.js';
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

export async function executeLifecycleTransition(db, { tenantId, actor, saved, body, automatic = false, leaseToken = null }, deps = {}) {
  if (!lifecycleUuid(body.memberId) || !Number.isSafeInteger(body.expectedRevision)
    || body.expectedRevision < 0 || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) {
    fail('A member, current revision and documented reason are required', 400);
  }
  if (!['archive', 'restore', 'former', 'guest', 'deletion_review', 'evidence_review'].includes(body.action)) fail('Unsupported transition', 400);
  const detail = await (deps.detail || lifecycleStableDetail)(db, tenantId, body.memberId, saved.policy, deps);
  if (detail.revision !== body.expectedRevision) fail('Member decision changed; reload');
  if (!['evidence_review','restore'].includes(body.action) && detail.blockers.length) fail('Unresolved evidence or retention obligations prevent this action');
  if (body.action === 'restore') {
    if (automatic || detail.state !== 'archived') fail('Only an intact archived record can be restored manually');
    if (detail.evidence?.membershipComplete !== true) fail('Verify current membership before restoring access');
  } else if (detail.proposal.action !== body.action) {
    fail('Current evidence no longer supports this action');
  }
  const { data, error } = await db.rpc('member_lifecycle_transition', {
    p_tenant_id: tenantId, p_member_id: body.memberId, p_revision: detail.revision,
    p_policy_revision: saved.revision, p_stamp: detail.sourceStamp,
    p_action: body.action, p_reason: body.reason.trim(), p_actor: actor,
    p_role_id: detail.proposal.targetRoleId || null, p_automatic: automatic,
    p_lease_token: leaseToken,
  });
  if (error) throw error;
  if (!data || data.memberId !== body.memberId) throw new Error('Transition result unavailable');
  return data;
}
