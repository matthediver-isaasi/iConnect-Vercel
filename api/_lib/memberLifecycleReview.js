import { evaluateMemberLifecycle } from '../../shared/memberLifecyclePolicy.mjs';
import { lifecycleRows, loadMemberLifecycleEvidence } from './memberLifecycleEvidence.js';

export const LIFECYCLE_REVIEW_ACTIONS = new Set(['retain', 'release_hold', 'extend', 'exempt', 'clear_exemption']);
export const lifecycleUuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export async function loadLifecycleMember(db, tenantId, memberId) {
  if (!lifecycleUuid(memberId)) fail('A valid member ID is required');
  const { data: member, error } = await db.from('member').select('*').eq('id', memberId).maybeSingle();
  if (error) throw error;
  if (!member) fail('Member not found', 404);
  let owner = member.tenant_id;
  if (!owner && member.organization_id) {
    const result = await db.from('organization').select('tenant_id').eq('id', member.organization_id).maybeSingle();
    if (result.error) throw result.error;
    owner = result.data?.tenant_id;
  }
  if (owner !== tenantId) fail('Member not found', 404);
  const result = await db.from('member_lifecycle_record').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).maybeSingle();
  if (result.error) throw result.error;
  const record = result.data || { state: 'active', revision: 0, hold: false, exempt: false, review_after: null };
  return {
    member: { ...member, tenant_id: tenantId, lifecycle_state: record.state, lifecycle_hold: record.hold,
      lifecycle_exempt: record.exempt, lifecycle_review_after: record.review_after, lifecycle_archived_at: record.archived_at,
      lifecycle_history_review: record.history_review, lifecycle_login_review: record.login_review,
      lifecycle_financial_refs: record.financial_refs },
    record,
  };
}

export async function lifecycleReviewDetail(db, tenantId, memberId, policy, deps = {}) {
  const { member, record } = await loadLifecycleMember(db, tenantId, memberId);
  const readRows = deps.readRows || lifecycleRows;
  const evidence = await (deps.loadEvidence || loadMemberLifecycleEvidence)(db, tenantId, member, policy, new Date(), {
    expiryCoordinated: deps.expiryCoordinated === true,
  });
  const roles = await readRows(db, 'role', tenantId);
  const proposal = evaluateMemberLifecycle({ tenantId, member, evidence, roles, policy });
  const result = await db.from('member_lifecycle_record_audit')
    .select('id,revision,action,reason,actor,created_at').eq('tenant_id', tenantId).eq('member_id', memberId)
    .order('revision', { ascending: false }).limit(100);
  if (result.error || !Array.isArray(result.data)) throw result.error || new Error('Audit unavailable');
  const blockers = [...(evidence.blockers || []), ...(evidence.unavailableSources || []).map(s => `unavailable:${s}`)];
  if (proposal.action === 'evidence_review') blockers.push(proposal.reason);
  if (record.hold) blockers.push('administrator_hold');
  if (record.exempt) blockers.push('individual_exemption');
  return {
    memberId, state: record.state, revision: record.revision, hold: record.hold, exempt: record.exempt,
    reviewAfter: record.review_after, archivedAt: record.archived_at || null, proposal,
    evidence, blockers: [...new Set(blockers)], audit: result.data, auditLimited: result.data.length === 100,
  };
}

export async function recordLifecycleDecision(db, tenantId, actor, body) {
  if (!LIFECYCLE_REVIEW_ACTIONS.has(body?.action)) fail('Invalid review action');
  if (!lifecycleUuid(body.memberId) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    fail('A member ID and current record revision are required');
  }
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 2000) {
    fail('A documented reason of up to 2,000 characters is required');
  }
  if (body.action === 'extend' && (typeof body.reviewAfter !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.reviewAfter))) {
    fail('A valid future review date is required');
  }
  const { data, error } = await db.rpc('member_lifecycle_record_decision', {
    p_tenant_id: tenantId, p_member_id: body.memberId, p_revision: body.expectedRevision,
    p_action: body.action, p_reason: body.reason.trim(), p_actor: actor,
    p_review_after: body.action === 'extend' ? body.reviewAfter : null,
  });
  if (error) throw error;
  if (!data || data.member_id !== body.memberId || data.tenant_id !== tenantId) throw new Error('Invalid decision result');
  return { memberId: data.member_id, revision: data.revision, state: data.state,
    hold: data.hold, exempt: data.exempt, reviewAfter: data.review_after };
}
