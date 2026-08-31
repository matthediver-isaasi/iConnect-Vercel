import {
  conditionalSelectionAllowed,
  resolveConditionalFilter,
} from './formConditionalFilters.js';
import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';
import {
  FORM_NOT_LISTED_VALUE,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';

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
  containerFieldId,
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
  let fields = form.fields;
  if (containerFieldId !== undefined && containerFieldId !== null && containerFieldId !== '') {
    const container = form.fields.find(
      candidate => String(candidate?.id) === String(containerFieldId),
    );
    if (!container || !isRepeatableRowField(container)) return [];
    fields = repeatableRowChildren(container);
  }
  const field = fields.find(candidate => String(candidate?.id) === String(fieldId));
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
  hiddenFieldIds = new Set(),
}) {
  const rootFields = Array.isArray(fields) ? fields : [];
  const scopes = [{ fields: rootFields, data: submissionData }];
  for (const container of rootFields.filter(field => (
    isRepeatableRowField(field) && !hiddenFieldIds.has(field?.id)
  ))) {
    const rows = submittedValue(submissionData, container);
    if (!Array.isArray(rows)) continue;
    const children = repeatableRowChildren(container);
    for (const row of rows) scopes.push({ fields: children, data: row });
  }
  const values = [];
  for (const scope of scopes) {
    const groupFields = scope.fields
      .filter(field => field?.type === ORGANISATION_GROUP_DROPDOWN_TYPE
        && field.id && !hiddenFieldIds.has(field.id));
    for (const field of groupFields) {
      const selected = submittedValue(scope.data, field);
      const resolution = resolveConditionalFilter(field, scope.data, scope.fields);
      if (!conditionalSelectionAllowed(selected, resolution)) {
        const error = new Error('Invalid conditional organisation group selection');
        error.code = 'INVALID_ORGANISATION_GROUP';
        throw error;
      }
      const selectedValues = Array.isArray(selected) ? selected : [selected];
      values.push(...selectedValues
        .filter(value => value !== null && value !== undefined && value !== ''
          && !isFormNotListedValue(value))
        .map(String));
    }
  }
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

function submittedValue(data, field) {
  if (!data || typeof data !== 'object' || !field) return undefined;
  if (field.id != null && data[field.id] !== undefined) return data[field.id];
  return field.name != null ? data[field.name] : undefined;
}

async function validateDependentSet({
  db, tenantId, fields, submissionData, rootFields = [], rootSubmissionData = {}, containerIndex = -1,
  hiddenFieldIds = new Set(),
}) {
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (hiddenFieldIds.has(field?.id)) continue;
    if (field?.type !== 'organisation_dropdown' || !field.organisation_group_parent_field_id) continue;
    const scope = field.organisation_group_parent_scope
      ?? field.organisation_group_parent_field_scope ?? 'row';
    const parentFields = scope === 'form' ? rootFields : fields;
    const parentData = scope === 'form' ? rootSubmissionData : submissionData;
    const parentIndex = parentFields.findIndex(
      candidate => String(candidate?.id) === String(field.organisation_group_parent_field_id),
    );
    const parent = parentFields[parentIndex];
    const organizationId = submittedValue(submissionData, field);
    const groupId = submittedValue(parentData, parent);
    const validScope = scope === 'row' || scope === 'form';
    const precedesParent = scope === 'form'
      ? containerIndex >= 0 && parentIndex >= 0 && parentIndex < containerIndex
      : parentIndex >= 0 && parentIndex < index;
    if (!validScope || !precedesParent || parent?.type !== ORGANISATION_GROUP_DROPDOWN_TYPE
         || !groupId || isFormNotListedValue(groupId)) {
      if (organizationId && !isFormNotListedValue(organizationId)) {
        const error = new Error('Invalid organisation group dependency');
        error.code = 'INVALID_ORGANISATION_GROUP_ORGANISATION';
        throw error;
      }
      continue;
    }
    if (!organizationId || isFormNotListedValue(organizationId)) continue;
    const { data: organization, error: organizationError } = await db
      .from('organization')
      .select('id')
      .eq('id', String(organizationId))
      .eq('tenant_id', tenantId)
      .eq('organization_group_id', String(groupId))
      .maybeSingle();
    if (organizationError || !organization) {
      const error = new Error('Organisation does not belong to selected group');
      error.code = 'INVALID_ORGANISATION_GROUP_ORGANISATION';
      throw error;
    }
  }
}

export async function validateOrganisationGroupDependentOrganizationAnswers({
  db,
  tenantId,
  fields,
  submissionData,
  hiddenFieldIds = new Set(),
}) {
  const list = Array.isArray(fields) ? fields : [];
  await validateDependentSet({
    db, tenantId, fields: list, submissionData, hiddenFieldIds,
  });
  for (let containerIndex = 0; containerIndex < list.length; containerIndex += 1) {
    const container = list[containerIndex];
    if (!isRepeatableRowField(container) || hiddenFieldIds.has(container?.id)) continue;
    const children = repeatableRowChildren(container);
    const rows = submittedValue(submissionData, container);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      await validateDependentSet({
        db, tenantId, fields: children, submissionData: row,
        rootFields: list, rootSubmissionData: submissionData, containerIndex,
        hiddenFieldIds,
      });
    }
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
    .filter(value => value && value !== FORM_NOT_LISTED_VALUE)
    .map(String);
  if (ids.length === 0) return {};
  const groups = await loadTenantOrganisationGroups(db, tenantId, ids);
  return Object.fromEntries(groups.map(group => [String(group.id), group.name || '']));
}