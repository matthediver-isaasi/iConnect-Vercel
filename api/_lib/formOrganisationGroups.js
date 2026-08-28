import {
  conditionalSelectionAllowed,
  resolveConditionalFilter,
} from './formConditionalFilters.js';

export const ORGANISATION_GROUP_DROPDOWN_TYPE = 'organisation_group_dropdown';

export async function loadTenantOrganisationGroups(db, tenantId, ids = null) {
  if (!db || !tenantId) return [];
  let query = db
    .from('organization_group')
    .select('id, name')
    .eq('tenant_id', tenantId);
  if (Array.isArray(ids)) {
    const normalized = [...new Set(ids.filter(Boolean).map(String))];
    if (normalized.length === 0) return [];
    query = query.in('id', normalized);
  }
  const { data, error } = await query.order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function resolveTenantOrganisationGroupId({
  db,
  tenantId,
  groupId,
}) {
  if (!groupId) return null;
  const groups = await loadTenantOrganisationGroups(db, tenantId, [groupId]);
  return groups.some(group => String(group.id) === String(groupId))
    ? String(groupId)
    : null;
}

export async function resolveMemberOrganisationGroupId({
  db,
  tenantId,
  member,
}) {
  if (!db || !tenantId || !member) return null;
  let groupId = member.organization_group_id || null;
  if (!groupId && member.organization_id) {
    const { data: organization, error } = await db
      .from('organization')
      .select('organization_group_id')
      .eq('id', member.organization_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    groupId = organization?.organization_group_id || null;
  }
  return resolveTenantOrganisationGroupId({ db, tenantId, groupId });
}

export async function loadFormOrganisationGroupOptions({
  db,
  tenantId,
  formId,
  formSlug,
  fieldId,
}) {
  if (!db || !tenantId || !fieldId || (!formId && !formSlug)) return [];
  let formQuery = db
    .from('form')
    .select('id, fields')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);
  formQuery = formId ? formQuery.eq('id', formId) : formQuery.eq('slug', formSlug);
  const { data: form, error } = await formQuery.maybeSingle();
  if (error || !form || !Array.isArray(form.fields)) return [];
  const field = form.fields.find(candidate => String(candidate?.id) === String(fieldId));
  if (field?.type !== ORGANISATION_GROUP_DROPDOWN_TYPE) return [];
  try {
    return await loadTenantOrganisationGroups(db, tenantId);
  } catch {
    return [];
  }
}

export async function validateFormOrganisationGroupAnswers({
  db,
  tenantId,
  fields,
  submissionData,
}) {
  const groupFields = (Array.isArray(fields) ? fields : [])
    .filter(field => field?.type === ORGANISATION_GROUP_DROPDOWN_TYPE && field.id);
  if (groupFields.length === 0) return true;

  for (const field of groupFields) {
    const selected = submissionData?.[field.id];
    const resolution = resolveConditionalFilter(field, submissionData, fields);
    if (!conditionalSelectionAllowed(selected, resolution)) {
      const error = new Error('Invalid conditional organisation group selection');
      error.code = 'INVALID_ORGANISATION_GROUP';
      throw error;
    }
  }

  const values = groupFields
    .flatMap(field => {
      const value = submissionData?.[field.id];
      return Array.isArray(value) ? value : [value];
    })
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(String);
  if (values.length === 0) return true;

  const groups = await loadTenantOrganisationGroups(db, tenantId, values);
  const allowed = new Set(groups.map(group => String(group.id)));
  if (values.some(value => !allowed.has(value))) {
    const error = new Error('Invalid organisation group selection');
    error.code = 'INVALID_ORGANISATION_GROUP';
    throw error;
  }
  return true;
}

export async function loadOrganisationGroupNamesForSubmission({
  db,
  tenantId,
  fields,
  submissionData,
}) {
  const ids = (Array.isArray(fields) ? fields : [])
    .filter(field => field?.type === ORGANISATION_GROUP_DROPDOWN_TYPE && field.id)
    .flatMap(field => {
      const value = submissionData?.[field.id];
      return Array.isArray(value) ? value : [value];
    })
    .filter(Boolean)
    .map(String);
  if (ids.length === 0) return {};
  const groups = await loadTenantOrganisationGroups(db, tenantId, ids);
  return Object.fromEntries(groups.map(group => [String(group.id), group.name || '']));
}