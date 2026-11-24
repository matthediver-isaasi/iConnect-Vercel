import { SalesHttpError } from './salesAccess.js';
import { freezeMembershipBenefit } from '../../shared/proposalMembershipEntitlements.js';
import { proposalMembershipEnabled } from './proposalMembershipRollout.js';

export async function resolveProposalMembershipSchedule(db, tenantId, scheduleId) {
  if (!scheduleId) return null;
  if (!proposalMembershipEnabled()) throw new SalesHttpError(503, 'Proposal membership products are not enabled. Complete the database and billing rollout first.');
  const { data, error } = await db.from('membership_tier_config').select('*')
    .eq('tenant_id', tenantId).eq('id', scheduleId).maybeSingle();
  if (error) throw error;
  try { return freezeMembershipBenefit(data, tenantId); }
  catch (error) { throw new SalesHttpError(400, error.message); }
}

export async function listProposalMembershipSchedules(db, tenantId) {
  if (!proposalMembershipEnabled()) return { items: [], enabled: false };
  const items = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await db.from('membership_tier_config')
      .select('id,name,structure_scope_type,is_active,effective_from,effective_to')
      .eq('tenant_id', tenantId).order('id').range(offset, offset + 199);
    if (error) throw error;
    items.push(...(data || []).filter(row => (row.structure_scope_type || 'organization') === 'organization' && row.is_active !== false));
    if ((data || []).length < 200) break;
  }
  return { items, enabled: true };
}
