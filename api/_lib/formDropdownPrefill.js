import { resolveConditionalFilter, conditionalSelectionAllowed } from './formConditionalFilters.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { isFormNotListedValue } from '../../shared/formNotListedChoice.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { resolveFormAccess } from './formAccessPolicy.js';
import { getSession } from './session.js';

const SOURCE_TYPES = new Set([
  'organisation_dropdown', 'organization_dropdown', 'organisation_group_dropdown',
]);
const ORGANIZATION_CORE_FIELDS = new Set([
  'name', 'description', 'logo_url', 'invoicing_email', 'invoicing_address',
  'phone', 'website_url', 'tags',
]);
const GROUP_CORE_FIELDS = new Set(['name', 'description', 'logo_url']);

export class FormDropdownPrefillError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, message, code) {
  throw new FormDropdownPrefillError(status, message, code);
}

function sourceFieldId(form) {
  const nested = form?.prefill_source_config;
  return form?.prefill_source_field_id
    || form?.prefill_form_field_id
    || form?.prefill_source_field
    || form?.prefill_field_id
    || (nested && typeof nested === 'object' ? (nested.field_id || nested.source_field_id) : null);
}

function parseMapping(value, sourceType) {
  if (typeof value !== 'string' || !value) return null;
  const prefixes = sourceType !== 'organisation_group_dropdown'
    ? [
      ['org_custom:', 'custom'], ['organization_custom:', 'custom'],
      ['organisation_custom:', 'custom'],
      ['org:', 'core'], ['organization:', 'core'], ['organisation:', 'core'],
    ]
    : [
      ['org_group_custom:', 'custom'], ['organization_group_custom:', 'custom'],
      ['organisation_group_custom:', 'custom'], ['group_custom:', 'custom'],
      ['org_group:', 'core'], ['organization_group:', 'core'],
      ['organisation_group:', 'core'], ['group:', 'core'],
    ];
  const match = prefixes.find(([prefix]) => value.startsWith(prefix));
  if (!match) return { invalid: true };
  const key = value.slice(match[0].length);
  return key ? { kind: match[1], key } : { invalid: true };
}

function answerFor(field, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  if (field?.id != null && answers[field.id] !== undefined) return answers[field.id];
  return field?.name ? answers[field.name] : undefined;
}

function savedOptionAllows(field, recordId) {
  const options = Array.isArray(field?.options)
    ? field.options : (Array.isArray(field?.choices) ? field.choices : null);
  if (!options || options.length === 0) return true;
  return options.some((option) => String(
    option && typeof option === 'object' ? (option.value ?? option.id ?? '') : option,
  ) === String(recordId));
}

async function loadCustomValues({ db, tenantId, sourceType, recordId, mappings }) {
  const ids = [...new Set(mappings.filter(item => item.mapping.kind === 'custom')
    .map(item => item.mapping.key))];
  if (!ids.length) return new Map();
  const scope = sourceType !== 'organisation_group_dropdown' ? 'organization' : 'organization_group';
  const { data: definitions, error: definitionError } = await db
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', scope)
    .eq('is_active', true)
    .in('id', ids);
  if (definitionError) fail(500, 'Failed to resolve prefill fields', 'PREFILL_LOOKUP_FAILED');
  if ((definitions || []).length !== ids.length) {
    fail(400, 'The form has a stale prefill mapping', 'STALE_PREFILL_CONFIG');
  }

  const isGroup = sourceType === 'organisation_group_dropdown';
  const table = isGroup
    ? 'organization_group_preference_value' : 'organization_preference_value';
  const ownerColumn = isGroup ? 'organization_group_id' : 'organization_id';
  let valueQuery = db.from(table)
    .select('field_id, value');
  // Organisation values have no tenant_id column. Their tenant boundary is the
  // already tenant-validated organisation plus the definitions validated above.
  // Group values do carry tenant_id, so retain that direct scope as defence in depth.
  if (isGroup) valueQuery = valueQuery.eq('tenant_id', tenantId);
  const { data, error } = await valueQuery
    .eq(ownerColumn, recordId)
    .in('field_id', ids);
  if (error) fail(500, 'Failed to resolve prefill values', 'PREFILL_LOOKUP_FAILED');
  return new Map((data || []).map(row => [String(row.field_id), row.value]));
}

async function loadCustomTargetTypes({ db, tenantId, mappings }) {
  const targetIds = [...new Set(mappings
    .filter(item => item.targetField?.type === 'custom_field' && item.targetField.custom_field_id)
    .map(item => String(item.targetField.custom_field_id)))];
  if (!targetIds.length) return {};
  const { data, error } = await db.from('preference_field')
    .select('id, field_type')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('id', targetIds);
  if (error) fail(500, 'Failed to resolve target field types', 'PREFILL_LOOKUP_FAILED');
  if ((data || []).length !== targetIds.length) {
    fail(400, 'The form has a stale prefill target', 'STALE_PREFILL_CONFIG');
  }
  const byDefinition = new Map((data || []).map(row => [String(row.id), row.field_type]));
  return Object.fromEntries(mappings
    .filter(item => item.targetField?.type === 'custom_field')
    .map(item => [item.targetId, byDefinition.get(String(item.targetField.custom_field_id))]));
}

async function validateOrganization({ db, tenantId, recordId, sourceField, fields, sourceAnswers }) {
  const { data: record, error } = await db.from('organization')
    .select('*')
    .eq('id', recordId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) fail(500, 'Failed to resolve organisation', 'PREFILL_LOOKUP_FAILED');
  if (!record) fail(404, 'Organisation not found', 'PREFILL_RECORD_NOT_FOUND');

  const conditional = resolveConditionalFilter(sourceField, sourceAnswers, fields);
  if (!conditional.valid || !savedOptionAllows(sourceField, recordId)
      || !conditionalSelectionAllowed(recordId, conditional)) {
    fail(404, 'Organisation is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
  }
  if (sourceField.organisation_group_parent_field_id) {
    const sourceIndex = fields.indexOf(sourceField);
    const parentIndex = fields.findIndex(field => (
      String(field?.id) === String(sourceField.organisation_group_parent_field_id)
    ));
    const parent = fields[parentIndex];
    const groupId = answerFor(parent, sourceAnswers);
    if (parent?.type !== 'organisation_group_dropdown' || parentIndex < 0
        || parentIndex >= sourceIndex || !groupId || isFormNotListedValue(groupId)
        || String(record.organization_group_id || '') !== String(groupId)) {
      fail(404, 'Organisation is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
    }
  }
  const filters = [sourceField];
  if (conditional.orgFilter) filters.push({ org_filter: conditional.orgFilter });
  for (const field of filters) {
    if (!await isOrganizationEligibleForField({ db, tenantId, organization: record, field })) {
      fail(404, 'Organisation is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
    }
  }
  return record;
}

async function validateGroup({ db, tenantId, recordId, sourceField, fields, sourceAnswers }) {
  const { data: record, error } = await db.from('organization_group')
    .select('*')
    .eq('id', recordId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) fail(500, 'Failed to resolve organisation group', 'PREFILL_LOOKUP_FAILED');
  if (!record) fail(404, 'Organisation group not found', 'PREFILL_RECORD_NOT_FOUND');
  const conditional = resolveConditionalFilter(sourceField, sourceAnswers, fields);
  if (!conditional.valid || !savedOptionAllows(sourceField, recordId)
      || !conditionalSelectionAllowed(recordId, conditional)) {
    fail(404, 'Organisation group is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
  }
  const allowedStatuses = sourceField.allowed_group_statuses
    || sourceField.allowed_organisation_group_statuses;
  if (Array.isArray(allowedStatuses) && allowedStatuses.length
      && !allowedStatuses.map(String).includes(String(record.status))) {
    fail(404, 'Organisation group is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
  }
  if (record.is_active === false) {
    fail(404, 'Organisation group is not eligible for this form', 'PREFILL_RECORD_INELIGIBLE');
  }
  return record;
}

/**
 * Resolves dropdown-driven prefill exclusively from an active persisted form.
 * The browser supplies only the selected record and current answers; source,
 * mappings and eligibility rules always come from the saved form.
 */
export async function resolveFormDropdownPrefill({
  db,
  req,
  tenantId,
  formId,
  formSlug,
  requestedSourceFieldId,
  recordId,
  sourceAnswers = {},
  now = Date.now(),
  resolveAccess = resolveFormAccess,
  resolveSession = getSession,
}) {
  if (!db || !tenantId || (!formId && !formSlug) || !recordId) {
    fail(400, 'Form and selected record are required', 'INVALID_PREFILL_REQUEST');
  }
  if (isFormNotListedValue(recordId)) {
    fail(400, 'A not-listed choice cannot be used for prefill', 'INVALID_PREFILL_RECORD');
  }
  if (!sourceAnswers || typeof sourceAnswers !== 'object' || Array.isArray(sourceAnswers)) {
    fail(400, 'Source answers must be an object', 'INVALID_PREFILL_REQUEST');
  }

  let query = db.from('form').select('*').eq('tenant_id', tenantId).eq('is_active', true);
  query = formId ? query.eq('id', formId) : query.eq('slug', formSlug);
  const { data: form, error } = await query.maybeSingle();
  if (error) fail(500, 'Failed to resolve form', 'PREFILL_LOOKUP_FAILED');
  if (!form || !isFormScheduleAvailable(form, now)) {
    fail(404, 'Form not found or inactive', 'FORM_NOT_AVAILABLE');
  }
  const access = await resolveAccess({
    supabase: db, req, tenantId, policy: form.access_policy,
  });
  if (!access?.allowed) {
    fail(403, 'You do not have access to this form', access?.code || 'FORM_ACCESS_DENIED');
  }
  if (form.require_authentication) {
    const session = await resolveSession(req);
    const sessionTenantId = session?.data?.tenantId || session?.data?.preservedTenantId;
    if (!session || (sessionTenantId && String(sessionTenantId) !== String(tenantId))) {
      fail(403, 'Authentication is required to access this form', 'AUTHENTICATION_REQUIRED');
    }
  }
  if (form.prefill_source !== 'form_field' || !Array.isArray(form.fields)) {
    fail(400, 'Form is not configured for dropdown prefill', 'INVALID_PREFILL_CONFIG');
  }

  const configuredSourceId = sourceFieldId(form);
  const fieldIds = form.fields.filter(field => field?.id != null).map(field => String(field.id));
  if (!configuredSourceId || new Set(fieldIds).size !== fieldIds.length) {
    fail(400, 'The configured prefill source is stale', 'STALE_PREFILL_CONFIG');
  }
  const sourceIndex = form.fields.findIndex(field => String(field?.id) === String(configuredSourceId));
  const sourceField = form.fields[sourceIndex];
  if (sourceIndex < 0 || !SOURCE_TYPES.has(sourceField?.type)) {
    fail(400, 'The configured prefill source is stale', 'STALE_PREFILL_CONFIG');
  }
  if (requestedSourceFieldId
      && String(requestedSourceFieldId) !== String(sourceField.id)) {
    fail(400, 'The requested prefill source does not match the form', 'STALE_PREFILL_CONFIG');
  }

  const mappings = [];
  for (let index = 0; index < form.fields.length; index += 1) {
    const field = form.fields[index];
    if (!field?.prefill_field) continue;
    const mapping = parseMapping(field.prefill_field, sourceField.type);
    if (index <= sourceIndex || !field.id || !mapping || mapping.invalid) {
      fail(400, 'The form has a stale prefill mapping', 'STALE_PREFILL_CONFIG');
    }
    const allowedCore = sourceField.type !== 'organisation_group_dropdown'
      ? ORGANIZATION_CORE_FIELDS : GROUP_CORE_FIELDS;
    if (mapping.kind === 'core' && !allowedCore.has(mapping.key)) {
      fail(400, 'The form has a stale prefill mapping', 'STALE_PREFILL_CONFIG');
    }
    mappings.push({ targetId: String(field.id), targetField: field, mapping });
  }

  const selectedId = String(recordId);
  const record = sourceField.type !== 'organisation_group_dropdown'
    ? await validateOrganization({
      db, tenantId, recordId: selectedId, sourceField, fields: form.fields, sourceAnswers,
    })
    : await validateGroup({
      db, tenantId, recordId: selectedId, sourceField, fields: form.fields, sourceAnswers,
    });
  const customValues = await loadCustomValues({
    db, tenantId, sourceType: sourceField.type, recordId: selectedId, mappings,
  });
  const fieldTypes = await loadCustomTargetTypes({ db, tenantId, mappings });
  const values = {};
  for (const { targetId, mapping } of mappings) {
    const value = mapping.kind === 'core' ? record[mapping.key] : customValues.get(mapping.key);
    if (value !== undefined && value !== null) values[targetId] = value;
  }
  return {
    values,
    ...(Object.keys(fieldTypes).length ? { fieldTypes } : {}),
  };
}