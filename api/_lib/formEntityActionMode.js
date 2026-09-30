const VALID_ACTIONS = new Set(['none', 'create', 'update', 'upsert']);

export function resolveFormEntityActions({
  entityPipelines,
  memberEntityAction,
  organizationEntityAction,
  createEntityType,
  applicationLevel,
  entityAction,
}) {
  const memberPipelines = entityPipelines?.members || [];
  const organizationPipelines = entityPipelines?.organisations || [];
  const hasModernConfig = entityPipelines !== undefined && entityPipelines !== null;
  if (hasModernConfig) {
    return {
      memberAction: memberPipelines.length > 0 ? 'upsert' : 'none',
      organizationAction: organizationPipelines.length > 0 ? 'upsert' : 'none',
    };
  }
  const legacyEntityType = createEntityType || applicationLevel || 'member';
  const legacyActionMode = entityAction || 'create';
  return {
    memberAction: memberEntityAction && VALID_ACTIONS.has(memberEntityAction)
      ? memberEntityAction
      : ((legacyEntityType === 'member' || legacyEntityType === 'both')
        ? (legacyActionMode === 'update' ? 'update' : 'create')
        : 'none'),
    organizationAction: organizationEntityAction && VALID_ACTIONS.has(organizationEntityAction)
      ? organizationEntityAction
      : ((legacyEntityType === 'organization' || legacyEntityType === 'both')
        ? (legacyActionMode === 'update' ? 'update' : 'create')
        : 'none'),
  };
}

export function hasPersistedFormEntityActions(form) {
  const hasStructuredActions = (Array.isArray(form?.structured_actions?.actions)
    && form.structured_actions.actions.length > 0)
    || (Array.isArray(form?.structured_actions) && form.structured_actions.length > 0);
  return hasStructuredActions || hasPersistedLegacyFormEntityActions(form);
}

export function hasPersistedLegacyFormEntityActions(form) {
  const pipelines = form?.entity_pipelines;
  if (pipelines !== null && pipelines !== undefined) {
    return (Array.isArray(pipelines?.members) && pipelines.members.length > 0)
      || (Array.isArray(pipelines?.organisations) && pipelines.organisations.length > 0);
  }
  const actionable = value => ['create', 'update', 'upsert'].includes(value);
  if (actionable(form?.member_entity_action) || actionable(form?.organization_entity_action)) return true;
  if (Array.isArray(form?.additional_member_creations) && form.additional_member_creations.length > 0) return true;
  return ['member', 'organization', 'organisation'].includes(form?.create_entity_type)
    && actionable(form?.entity_action);
}