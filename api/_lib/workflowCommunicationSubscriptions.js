import {
  normalizeWorkflowCommunicationConfig,
} from '../../shared/workflowCommunicationSubscriptions.js';
import { loadMemberCommunicationCategoryEligibility } from './communicationCategoryEligibility.js';

// One category per transaction intentionally permits partial completion. Every
// outcome is retained so a failed category never disguises committed writes.
export async function executeWorkflowCommunicationSubscriptions({
  database, tenantId, entityType, memberId, config,
}) {
  const base = { action_type: 'update_field', field_type: 'communication_categories' };
  const outcomes = [];
  try {
    const { communication_subscription: selection } = normalizeWorkflowCommunicationConfig(config, entityType);
    if (!database || !tenantId || !memberId) throw new Error('Workflow tenant and target member are required');
    const eligibility = await loadMemberCommunicationCategoryEligibility(database, { tenantId, memberId });
    if (!eligibility) throw new Error('Target member was not found in the workflow tenant');
    const { member, allCategories, eligibleCategoryIds } = eligibility;
    if (!member.email?.trim()) throw new Error('Target member has no communication email');
    const { data: globalSuppressions, error: suppressionError } = await database
      .from('email_unsubscribe').select('id').eq('tenant_id', tenantId)
      .eq('email', member.email.trim().toLowerCase()).eq('unsubscribe_type', 'all');
    if (suppressionError) throw suppressionError;
    for (const categoryId of selection.category_ids) {
      const outcome = { category_id: categoryId, is_subscribed: selection.is_subscribed };
      const category = allCategories.find(row => row.id === categoryId);
      if (!category) {
        outcomes.push({ ...outcome, status: 'failed', reason: 'category_unavailable', error: 'Category is deleted, inactive, or outside the workflow tenant' });
        continue;
      }
      if (category.system_key) {
        outcomes.push({ ...outcome, status: 'skipped', reason: 'unsupported_system_category', error: 'System-managed categories are not supported by this action' });
        continue;
      }
      if (member.communications_opted_out_all === true || globalSuppressions?.length) {
        outcomes.push({ ...outcome, status: 'skipped', reason: 'global_opt_out', error: 'Global email opt-out remains effective' });
        continue;
      }
      if (selection.is_subscribed && !eligibleCategoryIds.has(categoryId)) {
        outcomes.push({ ...outcome, status: 'skipped', reason: 'member_ineligible', error: 'Category audience or role does not permit this member to subscribe' });
        continue;
      }
      try {
        const { error } = await database.rpc('set_email_preference_category_state', {
          p_tenant_id: tenantId, p_email: member.email.trim().toLowerCase(),
          p_member_id: memberId, p_category_id: categoryId,
          p_is_subscribed: selection.is_subscribed, p_campaign_id: null,
        });
        if (error) throw error;
        outcomes.push({ ...outcome, status: 'success', reason: 'applied' });
      } catch (error) {
        const globalOptOut = /global email opt-out is active/i.test(error.message || '');
        outcomes.push({ ...outcome, status: globalOptOut ? 'skipped' : 'failed',
          reason: globalOptOut ? 'global_opt_out' : 'database_failure', error: error.message });
      }
    }
    const statuses = new Set(outcomes.map(row => row.status));
    const status = statuses.size > 1 ? 'partial' : outcomes[0].status;
    return { ...base, status, result: { categories: outcomes },
      ...(status !== 'success' ? { error: outcomes.filter(row => row.error).map(row => `${row.category_id}: ${row.error}`).join('; ') } : {}) };
  } catch (error) {
    return { ...base, status: 'failed', error: error.message, result: { categories: outcomes } };
  }
}
