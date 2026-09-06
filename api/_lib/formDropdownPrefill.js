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

function conditionalPrefillActions(form) {
  const configuredSourceId = sourceFieldId(form);
  const targetsById = new Map((form?.fields || []).map(field => [String(field?.id), field]));
  const targetIds = new Set(targetsById.keys());
  const eligibleSourceIds = new Set((form?.fields || [])
    .filter(field => SOURCE_TYPES.has(field?.type)
      && !field.repeatable_field_id
      && !field.parent_repeatable_field_id)
    .map(field => String(field.id)));
  const actions = [];
  let invalid = false;
  for (const rule of (form?.visibility_rules || [])) {
    const executable = (Array.isArray(rule?.conditions) && rule.conditions.length > 0)
      || !!rule?.trigger_field_id;
    if (Array.isArray(rule?.actions)) {
      for (const action of rule.actions) {
        if (action?.set_value_source !== 'prefill') continue;
        const actionKind = action.action_type || action.rule_type || action.action;
        if (actionKind !== 'set_value' || !executable || !action.id
            || !action.target_field_id || !targetIds.has(String(action.target_field_id))
            || !action.set_value_prefill_field) {
          invalid = true;
          continue;
        }
        actions.push({
          key: String(action.id),
          sourceId: action.set_value_prefill_source_field_id || configuredSourceId,
          targetId: String(action.target_field_id),
          targetField: targetsById.get(String(action.target_field_id)),
          value: action.set_value_prefill_field,
        });
      }
    } else if (rule?.set_value_source === 'prefill') {
      const ruleKind = rule.rule_type || rule.action;
      if (ruleKind !== 'set_value' || !executable || !rule.id
          || !rule.target_field_id || !targetIds.has(String(rule.target_field_id))
          || !rule.set_value_prefill_field) {
        invalid = true;
        continue;
      }
      actions.push({
        key: `legacy_${rule.id}`,
        sourceId: rule.set_value_prefill_source_field_id || configuredSourceId,
        targetId: String(rule.target_field_id),
        targetField: targetsById.get(String(rule.target_field_id)),
        value: rule.set_value_prefill_field,
      });
    }
  }
  if (actions.some(action => !action.sourceId
      || !eligibleSourceIds.has(String(action.sourceId))
      || eligibleSourceIds.has(action.targetId))) invalid = true;
  return { actions, invalid };
}

function parseConditionalMapping(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('core.')) {
    const key = value.slice('core.'.length);
    return key ? { kind: 'core', key } : null;
  }
  if (value.startsWith('custom.')) {
    const key = value.slice('custom.'.length);
    return key ? { kind: 'custom', key } : null;
  }
  return null;
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
  const conditionalConfig = conditionalPrefillActions(form);
  if (conditionalConfig.invalid) {
    fail(400, 'The form has a stale conditional prefill action', 'STALE_PREFILL_CONFIG');
  }
  const conditionalActions = conditionalConfig.actions;
  const effectiveSourceId = requestedSourceFieldId || configuredSourceId;
  const sourceIndex = form.fields.findIndex(field => String(field?.id) === String(effectiveSourceId));
  const sourceField = form.fields[sourceIndex];
  const sourceIsConfigured = String(effectiveSourceId) === String(configuredSourceId);
  const sourceIsUsedByAction = conditionalActions.some(action => (
    String(action.sourceId) === String(effectiveSourceId)
  ));
  if (sourceIndex < 0 || !SOURCE_TYPES.has(sourceField?.type)
      || sourceField.repeatable_field_id || sourceField.parent_repeatable_field_id
      || (!sourceIsConfigured && !sourceIsUsedByAction)) {
    fail(400, 'The configured prefill source is stale', 'STALE_PREFILL_CONFIG');
  }

  const mappings = [];
  if (sourceIsConfigured) {
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
      mappings.push({ targetId: String(field.id), targetField: field, mapping, result: 'field' });
    }
  }
  const allowedCore = sourceField.type !== 'organisation_group_dropdown'
    ? ORGANIZATION_CORE_FIELDS : GROUP_CORE_FIELDS;
  for (const action of conditionalActions.filter(candidate => (
    String(candidate.sourceId) === String(effectiveSourceId)
  ))) {
    const mapping = parseConditionalMapping(action.value);
    if (!mapping || (mapping.kind === 'core' && !allowedCore.has(mapping.key))) {
      fail(400, 'The form has a stale conditional prefill action', 'STALE_PREFILL_CONFIG');
    }
    mappings.push({
      targetId: action.key,
      targetField: action.targetField,
      mapping,
      result: 'conditional',
    });
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
  const conditionalFieldTypes = Object.fromEntries(mappings
    .filter(item => item.result === 'conditional')
    .map(item => [
      item.targetId,
      fieldTypes[item.targetId]
        || item.targetField?.custom_field_type
        || item.targetField?.field_type
        || item.targetField?.type,
    ]));
  const values = {};
  const conditionalValues = {};
  for (const { targetId, mapping, result } of mappings) {
    const value = mapping.kind === 'core' ? record[mapping.key] : customValues.get(mapping.key);
    if (value !== undefined && value !== null) {
      if (result === 'conditional') conditionalValues[targetId] = value;
      else values[targetId] = value;
    }
  }
  return {
    values,
    ...(Object.keys(conditionalValues).length ? { conditionalValues } : {}),
    ...(Object.keys(conditionalFieldTypes).length ? { conditionalFieldTypes } : {}),
    ...(Object.keys(fieldTypes).length ? { fieldTypes } : {}),
  };
}