// A roleless member creation flow is still a member flow, not an anonymous visit.
export function filterFormCommunicationCategories(categories, { memberContext, roleId, allowedIds = [] }) {
  const allowed = new Set(allowedIds);
  return (categories || []).filter(category => {
    if (allowed.size > 0 && !allowed.has(category.id)) return false;
    if (!memberContext) return category.is_public === true;
    if (category.member_enabled === false) return false;
    const roles = Array.isArray(category.role_ids) ? category.role_ids : [];
    return roles.length === 0 || (Boolean(roleId) && roles.includes(roleId));
  });
}

export function formCommunicationCreationRole(pipeline, answers = {}) {
  if (!pipeline) return null;
  const assignment = pipeline.role_assignment;
  if (assignment?.mode !== 'from_field') return pipeline.role_id || null;
  const answer = answers[assignment.source_field_id];
  if (typeof answer === 'string' && answer && Object.hasOwn(assignment.value_to_role_id || {}, answer)) {
    const role = assignment.value_to_role_id[answer];
    return role === '__clear__' ? null : role || null;
  }
  return assignment.fallback === 'fixed' ? assignment.fallback_role_id || null : null;
}