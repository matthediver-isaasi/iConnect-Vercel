import { getTenantContext, hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { loadMemberCommunicationCategoryEligibility } from './communicationCategoryEligibility.js';

export async function authorizeCommunicationPreferencesAdmin(req, dependencies = {}) {
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;
  const context = await getContext(req);

  if (!context?.isAuthenticated) {
    return { status: 401, error: 'Not authenticated' };
  }
  if (!context.tenantId) {
    return { status: 403, error: 'Invalid tenant context' };
  }

  const allowed = await checkAdmin(context)
    || await checkFeature(context.roleId, 'admin_can_manage_communications');
  if (!allowed) {
    return { status: 403, error: 'Permission denied' };
  }

  return { context };
}

export async function loadAdminMemberCommunicationPreferences(
  database,
  { tenantId, memberId },
) {
  const eligibility = await loadMemberCommunicationCategoryEligibility(database, {
    tenantId,
    memberId,
  });
  if (!eligibility) return null;

  const { data: preferences, error } = await database
    .from('member_communication_preference')
    .select('category_id, is_subscribed')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);
  if (error) throw error;

  const preferenceByCategory = new Map(
    (preferences || []).map((preference) => [preference.category_id, preference.is_subscribed === true]),
  );

  return {
    memberId: eligibility.member.id,
    optedOutAll: eligibility.member.communications_opted_out_all === true,
    categories: eligibility.eligibleCategories.map((category) => ({
      ...category,
      isSubscribed: preferenceByCategory.get(category.id) === true,
    })),
  };
}

export async function setAdminMemberCommunicationGlobalState(
  database,
  { tenantId, memberId, optOutAll },
) {
  const eligibility = await loadMemberCommunicationCategoryEligibility(database, {
    tenantId,
    memberId,
  });
  if (!eligibility) return null;

  const { error } = await database.rpc('set_email_preference_global_state', {
    p_tenant_id: tenantId,
    p_email: eligibility.member.email,
    p_member_id: memberId,
    p_opt_out_all: optOutAll,
    p_campaign_id: null,
    p_category_ids: eligibility.eligibleCategories.map((category) => category.id),
  });
  if (error) throw error;

  return loadAdminMemberCommunicationPreferences(database, { tenantId, memberId });
}