import { evaluateSubmitControlRule } from './formSubmitControl.js';

export function derivePersistedFormRole({
  defaultRoleId = null,
  visibilityRules = [],
  answers = {},
  conditionOptions = {},
}) {
  let roleId = defaultRoleId || null;
  for (const rule of visibilityRules || []) {
    if (!evaluateSubmitControlRule(rule, answers, conditionOptions)) continue;
    for (const action of rule?.actions || []) {
      if (action?.action_type === 'set_role' && action.role_id) roleId = action.role_id;
      if (action?.action_type === 'clear_role') roleId = null;
    }
  }
  return roleId;
}

export function resolveFormProcessingPrefillTargets({
  isAdmin,
  submitterMember,
  persistedSubmission,
  requestedOrganizationId = null,
}) {
  if (!isAdmin) {
    return {
      memberId: submitterMember?.id || null,
      organizationId: submitterMember?.organization_id || null,
    };
  }
  return {
    memberId: null,
    organizationId: persistedSubmission?.organization_id
      || persistedSubmission?.payment_meta?.prefill_organization_id
      || requestedOrganizationId
      || null,
  };
}