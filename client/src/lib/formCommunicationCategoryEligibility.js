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

// Pass only answers that can affect the server's persisted role resolution.
// Role IDs, rule actions, and pipeline configuration never go to the endpoint.
export function formCommunicationRoleSourceAnswers(form, values = {}) {
  const pipelines = form?.entity_pipelines?.members || [];
  const primary = pipelines.find(pipeline => pipeline?.isPrimary || pipeline?.is_primary)
    || (pipelines.length === 1 ? pipelines[0] : null);
  const ids = new Set();
  if (primary?.role_assignment?.mode === 'from_field' && primary.role_assignment.source_field_id) {
    ids.add(primary.role_assignment.source_field_id);
  }
  for (const rule of form?.visibility_rules || []) {
    if (!rule?.actions?.some(action => action?.action_type === 'set_role' || action?.action_type === 'clear_role')) continue;
    if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      for (const condition of rule.conditions) {
        if (condition?.field_id) ids.add(condition.field_id);
      }
    } else if (rule.trigger_field_id) {
      ids.add(rule.trigger_field_id);
    }
  }
  // The server accepts only persisted top-level form fields. Projecting the
  // same set also keeps unrelated answers out of the request and cache scope.
  const allowed = new Set((form?.fields || []).map(field => field.id));
  const answers = Object.fromEntries([...ids].filter(id => allowed.has(id))
    .map(id => [id, values[id] ?? null]));
  return Object.keys(answers).length ? answers : null;
}