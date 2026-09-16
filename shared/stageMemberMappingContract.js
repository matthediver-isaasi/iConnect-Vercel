// The member field-mapping contract is intentionally narrower than the
// general member API. A due-diligence reviewer may update profile/contact
// fields only; identity, access, tenant, and organization-link columns are
// never valid mapping targets.

export const MEMBER_MAPPING_CORE_FIELDS = Object.freeze([
  'first_name',
  'last_name',
  'job_title',
  'mobile',
  'landline',
]);

export const TARGET_ENTITY_ORGANIZATION = 'organization';
export const TARGET_ENTITY_MEMBER = 'member';
export const STAGE_MAPPING_TARGET_ENTITIES = Object.freeze([
  TARGET_ENTITY_ORGANIZATION,
  TARGET_ENTITY_MEMBER,
]);
export const TARGET_ENTITIES = STAGE_MAPPING_TARGET_ENTITIES;
export const TARGET_ENTITY = Object.freeze({
  ORGANIZATION: TARGET_ENTITY_ORGANIZATION,
  MEMBER: TARGET_ENTITY_MEMBER,
});

// Organization targets retain the fields supported by the original mapping
// endpoint. Member targets deliberately have a smaller, safe allowlist.
export const ORGANIZATION_CORE_FIELDS = Object.freeze({
  name: { type: 'text' },
  email: { type: 'text' },
  invoicing_email: { type: 'text' },
  phone: { type: 'text' },
  website: { type: 'text' },
  description: { type: 'text' },
  logo_url: { type: 'text' },
  invoicing_address: { type: 'object' },
  address: {
    type: 'composite',
    fields: Object.freeze(['line1', 'line2', 'city', 'region', 'postcode', 'country']),
  },
});

export const MEMBER_CORE_FIELDS = Object.freeze({
  first_name: { type: 'text' },
  last_name: { type: 'text' },
  job_title: { type: 'text' },
  mobile: { type: 'text' },
  landline: { type: 'text' },
});

export const MEMBER_WRITABLE_CORE_FIELDS = MEMBER_MAPPING_CORE_FIELDS;
export const MEMBER_SAFE_CORE_FIELDS = MEMBER_MAPPING_CORE_FIELDS;
export const ORGANIZATION_CORE_FIELD_METADATA = ORGANIZATION_CORE_FIELDS;

export const MEMBER_CUSTOM_SCALAR_FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'long_text', 'email', 'url', 'date', 'boolean',
  'number', 'decimal', 'picklist', 'dropdown', 'select', 'country',
]);
export const SUPPORTED_MEMBER_CUSTOM_FIELD_TYPES = MEMBER_CUSTOM_SCALAR_FIELD_TYPES;
export const SUPPORTED_MEMBER_CUSTOM_TYPES = MEMBER_CUSTOM_SCALAR_FIELD_TYPES;

const MEMBER_MAPPING_CORE_FIELD_SET = new Set(MEMBER_MAPPING_CORE_FIELDS);

export function isMemberMappingCoreField(field) {
  return typeof field === 'string' && MEMBER_MAPPING_CORE_FIELD_SET.has(field);
}

export function validateMemberMappingTarget(targetType, targetField) {
  if (targetType === 'core' && !isMemberMappingCoreField(targetField)) {
    return {
      ok: false,
      code: 'invalid_member_core_field',
      message: `Member core field "${targetField || ''}" is not writable by field mapping`,
    };
  }
  if (targetType === 'custom' && (!targetField || typeof targetField !== 'string')) {
    return {
      ok: false,
      code: 'missing_member_custom_field',
      message: 'Member custom field mapping requires a preference field id',
    };
  }
  if (!['core', 'custom'].includes(targetType)) {
    return {
      ok: false,
      code: 'invalid_member_mapping_target_type',
      message: 'Member mapping target_type must be core or custom',
    };
  }
  return { ok: true };
}

function sourceFieldMatches(field, sourceFieldId) {
  if (!field || sourceFieldId === undefined || sourceFieldId === null) return false;
  const source = String(sourceFieldId);
  return [field.id, field.name, field.key]
    .filter(value => value !== undefined && value !== null)
    .map(String)
    .some(value => value === source);
}

export function sourceFieldExists(sourceFormFields, sourceFieldId) {
  return Array.isArray(sourceFormFields)
    && sourceFormFields.some(field => sourceFieldMatches(field, sourceFieldId));
}

export function validateMemberMappingSource(mapping, sourceFormFields) {
  const sourceType = mapping?.source_type;
  if (['static', 'clear', 'current_date'].includes(sourceType)
      || mapping?.transformation === 'current_date') {
    return { ok: true };
  }
  if (!['form_field', 'field'].includes(sourceType)) {
    return {
      ok: false,
      code: 'invalid_member_mapping_source_type',
      message: 'Member mapping source_type must be form_field, static, clear, or current_date',
    };
  }
  if (!mapping?.source_field_id) {
    return {
      ok: false,
      code: 'missing_member_mapping_source_field',
      message: 'Member form-field mapping requires source_field_id',
    };
  }
  if (!sourceFieldExists(sourceFormFields, mapping.source_field_id)) {
    return {
      ok: false,
      code: 'member_mapping_source_not_in_form',
      message: `Member mapping source field "${mapping.source_field_id}" is not persisted on the source form`,
    };
  }
  return { ok: true };
}

/**
 * Validate a persisted member action at the write boundary. Callers may
 * provide the persisted action metadata and source form fields; omitted
 * context is treated as unavailable rather than trusted.
 */
export function validateMemberMappingAction(action, {
  tenantId,
  formId,
  stageId,
  stageConfig,
  sourceFormFields,
  sourceFormAvailable = true,
} = {}) {
  const errors = [];
  if (!action || action.target_entity !== 'member') {
    errors.push({
      code: 'invalid_member_action_target',
      message: 'Only persisted member-target actions may enter member execution',
    });
  }
  if (tenantId && action?.tenant_id !== tenantId) {
    errors.push({ code: 'member_action_tenant_mismatch', message: 'Member action tenant does not match submission tenant' });
  }
  if (formId && action?.form_id !== formId) {
    errors.push({ code: 'member_action_form_mismatch', message: 'Member action form does not match submission form' });
  }
  if (stageId && action?.due_diligence_stage_id !== stageId) {
    errors.push({ code: 'member_action_stage_mismatch', message: 'Member action stage does not match the executing stage' });
  }
  if (stageConfig) {
    const stages = Array.isArray(stageConfig.workflow_stages) ? stageConfig.workflow_stages : [];
    if (!stages.some(stage => stage?.id === stageId)) {
      errors.push({ code: 'member_action_stage_not_configured', message: 'Executing stage is not in the persisted due-diligence configuration' });
    }
  }
  if (!sourceFormAvailable) {
    errors.push({
      code: 'member_mapping_source_form_unavailable',
      message: 'The persisted source form could not be loaded for member mappings',
    });
  }
  const mappings = Array.isArray(action?.field_mappings) ? action.field_mappings : [];
  if (mappings.length === 0) {
    errors.push({ code: 'member_action_has_no_mappings', message: 'Member action has no field mappings' });
  }
  mappings.forEach((mapping, index) => {
    const target = validateMemberMappingTarget(mapping?.target_type, mapping?.target_field);
    if (!target.ok) errors.push({ ...target, index });
    const source = validateMemberMappingSource(mapping, sourceFormFields);
    if (!source.ok) errors.push({ ...source, index });
  });
  return {
    ok: errors.length === 0,
    errors,
  };
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Legacy rows omitted target_entity and therefore target organizations.
 * Invalid explicit values return null so callers can reject them.
 */
export function normalizeTargetEntity(value) {
  if (value === undefined || value === null || value === '') {
    return TARGET_ENTITY_ORGANIZATION;
  }
  const normalized = cleanString(value).toLowerCase();
  return STAGE_MAPPING_TARGET_ENTITIES.includes(normalized) ? normalized : null;
}

export const normalizeStageMappingTargetEntity = normalizeTargetEntity;

export function isMemberCoreField(field) {
  return Object.prototype.hasOwnProperty.call(MEMBER_CORE_FIELDS, field);
}

export function isOrganizationCoreField(field) {
  if (Object.prototype.hasOwnProperty.call(ORGANIZATION_CORE_FIELDS, field)) return true;
  const parts = cleanString(field).split('.');
  return parts.length === 2
    && parts[0] === 'address'
    && ORGANIZATION_CORE_FIELDS.address.fields.includes(parts[1]);
}

export function isSupportedMemberCustomFieldType(fieldType) {
  return MEMBER_CUSTOM_SCALAR_FIELD_TYPES.includes(cleanString(fieldType).toLowerCase());
}

export function findPreferenceField(fieldId, preferenceFields = []) {
  const id = String(fieldId ?? '');
  if (!id) return null;
  if (preferenceFields instanceof Map) {
    return preferenceFields.get(id) || preferenceFields.get(fieldId) || null;
  }
  return (preferenceFields || []).find((field) => String(field?.id ?? '') === id) || null;
}

function isNonFieldSource(mapping) {
  return mapping?.source_type === 'static'
    || mapping?.source_type === 'current_date'
    || mapping?.source_type === 'clear'
    || mapping?.transformation === 'current_date';
}

function isEnabledFlag(value) {
  return value === true
    || value === 1
    || (typeof value === 'string' && ['true', '1', 'yes'].includes(value.trim().toLowerCase()));
}

/**
 * Pure action-row validation. Database callers must load preference fields
 * and form fields with tenant filters before passing them here.
 */
export function validateStageFieldMapping(mapping, {
  targetEntity = TARGET_ENTITY_ORGANIZATION,
  preferenceFields = [],
  sourceFields = null,
  tenantId = null,
  requireCustomFieldDefinition = false,
} = {}) {
  const entity = normalizeTargetEntity(targetEntity);
  if (!entity) return { ok: false, error: 'target_entity must be "organization" or "member"' };
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { ok: false, error: 'Each field mapping must be an object' };
  }
  if (mapping.target_entity !== undefined
    && normalizeTargetEntity(mapping.target_entity) !== entity) {
    return { ok: false, error: 'target_entity is configured at action level' };
  }
  const targetType = cleanString(mapping.target_type);
  if (!['core', 'custom'].includes(targetType)) {
    return { ok: false, error: 'Each mapping requires target_type of "core" or "custom"' };
  }
  const targetField = cleanString(mapping.target_field);
  if (!targetField) return { ok: false, error: 'Each mapping requires a target_field' };

  if (mapping.source_type === 'static'
    && (mapping.static_value === undefined || mapping.static_value === null || mapping.static_value === '')) {
    return { ok: false, error: 'Static mappings require a static_value' };
  }
  if (!isNonFieldSource(mapping)) {
    const sourceId = mapping.source_field_id;
    if (sourceId === undefined || sourceId === null || sourceId === '') {
      return { ok: false, error: 'Field mappings require a source_field_id' };
    }
    if (sourceFields && !sourceFieldExists(sourceFields, sourceId)) {
      return { ok: false, error: `Source field does not belong to this form: ${sourceId}` };
    }
  }

  if (targetType === 'core') {
    const valid = entity === TARGET_ENTITY_MEMBER
      ? isMemberCoreField(targetField)
      : isOrganizationCoreField(targetField);
    if (!valid) {
      return {
        ok: false,
        error: entity === TARGET_ENTITY_MEMBER
          ? `Invalid member core field: ${targetField}`
          : `Invalid organization core field: ${targetField}`,
      };
    }
    return { ok: true, targetEntity: entity };
  }

  const preferenceField = findPreferenceField(targetField, preferenceFields);
  if (!preferenceField) {
    // A caller that does not request definition checking can use this helper
    // for legacy organization rows whose definitions are loaded elsewhere.
    if (!requireCustomFieldDefinition && preferenceFields == null) {
      return { ok: true, targetEntity: entity };
    }
    return { ok: false, error: `Custom preference field is not available: ${targetField}` };
  }
  if (tenantId && preferenceField.tenant_id
    && String(preferenceField.tenant_id) !== String(tenantId)) {
    return { ok: false, error: `Custom preference field is not owned by this tenant: ${targetField}` };
  }
  if (preferenceField.entity_scope !== entity) {
    return { ok: false, error: `Custom preference field does not belong to ${entity}: ${targetField}` };
  }
  if (preferenceField.is_active === false) {
    return { ok: false, error: `Custom preference field is inactive: ${targetField}` };
  }
  if (isEnabledFlag(preferenceField.read_only)
    || isEnabledFlag(preferenceField.readonly)
    || isEnabledFlag(preferenceField.is_readonly)
    || isEnabledFlag(preferenceField.is_calculated)
    || isEnabledFlag(preferenceField.calculated)
    || isEnabledFlag(preferenceField.is_computed)
    || preferenceField.formula
    || preferenceField.calculation) {
    return { ok: false, error: `Custom preference field is not writable: ${targetField}` };
  }
  if (entity === TARGET_ENTITY_MEMBER
    && !isSupportedMemberCustomFieldType(preferenceField.field_type)) {
    return {
      ok: false,
      error: `Member preference field type is not supported for stage mappings: ${preferenceField.field_type || 'unknown'}`,
    };
  }
  return { ok: true, targetEntity: entity, preferenceField };
}

export function validateStageFieldMappings(mappings, options = {}) {
  const targetEntity = normalizeTargetEntity(options.targetEntity);
  if (!targetEntity) {
    return { ok: false, errors: ['target_entity must be "organization" or "member"'] };
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return { ok: false, errors: ['At least one field mapping is required'] };
  }
  const errors = [];
  for (const mapping of mappings) {
    const result = validateStageFieldMapping(mapping, { ...options, targetEntity });
    if (!result.ok) errors.push(result.error);
  }
  return errors.length
    ? { ok: false, errors, targetEntity }
    : { ok: true, targetEntity };
}

export const validateStageFieldMappingAction = validateStageFieldMappings;
