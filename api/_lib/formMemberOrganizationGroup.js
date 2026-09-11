import {
  FORM_NOT_LISTED_TEXT_KEY,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';
import {
  coalesceExplicitFallbackMappings,
  extractMappingSourceComponent,
  partitionIgnoredHiddenMappings,
} from './formMappingFallbacks.js';
import { resolvePrimaryOrganizationPipeline } from './formPrimaryOrganizationPipeline.js';

export const ORGANISATION_GROUP_DROPDOWN_TYPES = new Set([
  'organisation_group_dropdown',
  'organization_group_dropdown',
]);

export const MEMBER_ORGANIZATION_GROUP_ERROR_CODE = 'INVALID_MEMBER_ORGANIZATION_GROUP';

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export class MemberOrganizationGroupValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'MemberOrganizationGroupValidationError';
    this.code = MEMBER_ORGANIZATION_GROUP_ERROR_CODE;
    this.status = 400;
    this.details = details;
  }
}

export function isOrganisationGroupDropdownField(field) {
  return ORGANISATION_GROUP_DROPDOWN_TYPES.has(field?.type);
}

function fieldValue(values, fieldId) {
  if (!values || typeof values !== 'object' || !fieldId) return undefined;
  return values[fieldId];
}

/**
 * Resolve one direct member-group mapping.  This deliberately accepts only a
 * value supplied by a persisted Organisation Group Dropdown.  In particular,
 * a group name, a Not listed sentinel, and a static mapping are not accepted
 * as references.
 *
 * Empty values are represented by null.  Callers must treat null as a no-op,
 * rather than as a request to clear an existing direct assignment.
 */
export function resolveMemberOrganizationGroupSelection({
  field,
  value,
  sourceType = 'field',
  sourceFieldId = null,
  hidden = false,
} = {}) {
  if (hidden || value === undefined || value === null || value === '') return null;
  if (sourceType !== 'field' || !sourceFieldId || !isOrganisationGroupDropdownField(field)) {
    throw new MemberOrganizationGroupValidationError(
      'Member Organisation Group assignments must use a persisted Organisation Group Dropdown',
    );
  }
  if (isFormNotListedValue(value)) {
    throw new MemberOrganizationGroupValidationError(
      'Member Organisation Group assignments must select an existing Organisation Group',
    );
  }
  const values = Array.isArray(value) ? value : [value];
  const selected = values.filter(item => item !== undefined && item !== null && item !== '');
  if (selected.length === 0) return null;
  if (selected.length !== 1 || selected.some(item => isFormNotListedValue(item))) {
    throw new MemberOrganizationGroupValidationError(
      'A member Organisation Group assignment must select exactly one existing group',
    );
  }
  const groupId = String(selected[0]).trim();
  if (!groupId) return null;
  return {
    groupId,
    organizationGroupId: groupId,
    sourceFieldId: String(sourceFieldId),
  };
}

function mappingTarget(mapping) {
  return mapping?.target_field || mapping?.target_field_id || null;
}

function mappingSourceType(mapping) {
  if (mapping?.source_type === 'clear') return 'clear';
  if (mapping?.source_type === 'static') return 'static';
  if (mapping?.source_type === 'current_date' || mapping?.transformation === 'current_date') {
    return 'current_date';
  }
  return 'field';
}

const ORGANIZATION_NAME_TARGETS = new Set([
  'name',
  'organization_name',
  'organisation_name',
]);

function mappingValue(mapping, values) {
  const sourceType = mappingSourceType(mapping);
  if (sourceType === 'clear') return '__clear__';
  if (sourceType === 'current_date') return '__current_date__';
  if (sourceType === 'static') return mapping.static_value;
  return extractMappingSourceComponent(mapping, fieldValue(values, mapping.source_field_id));
}

function hasPresentValue(value) {
  if (value === undefined || value === null || value === '' || value === '__clear__') return false;
  return !(Array.isArray(value) && value.length === 0);
}

function organizationDropdownText(values, fieldId) {
  const text = values?.[FORM_NOT_LISTED_TEXT_KEY];
  return text && typeof text === 'object' && typeof text[fieldId] === 'string'
    ? text[fieldId].trim()
    : '';
}

function organizationMappingValue({
  mapping,
  field,
  values,
}) {
  const value = mappingValue(mapping, values);
  if (mappingSourceType(mapping) !== 'field' || !field || field.type !== 'organisation_dropdown') {
    return {
      organizationId: null,
      hasIdentity: ORGANIZATION_NAME_TARGETS.has(mappingTarget(mapping))
        && hasPresentValue(value)
        && value !== '__current_date__',
    };
  }
  if (isFormNotListedValue(value)) {
    return {
      organizationId: null,
      hasIdentity: ORGANIZATION_NAME_TARGETS.has(mappingTarget(mapping))
        && organizationDropdownText(values, field.id) !== '',
    };
  }
  const selected = Array.isArray(value) ? value.find(item => hasPresentValue(item)) : value;
  return {
    organizationId: hasPresentValue(selected) ? String(selected).trim() : null,
    hasIdentity: hasPresentValue(selected),
  };
}

function legacyOrganizationMappings(config) {
  if (!config?.field_mappings || !isObject(config.field_mappings)) return [];
  return Object.entries(config.field_mappings)
    .filter(([, fieldId]) => fieldId)
    .map(([targetField, fieldId]) => ({
      source_type: fieldId === '__clear__' ? 'clear' : 'field',
      source_field_id: fieldId === '__clear__' ? null : fieldId,
      target_type: 'core',
      target_entity: 'organization',
      target_field: targetField,
    }));
}

/**
 * Resolve the Organisation context that the legacy processor will use for a
 * member group assignment.  Top-level mappings are filtered to their owning
 * entity before identity extraction; otherwise a member email/group mapping
 * can accidentally be mistaken for an Organisation target.  The returned
 * prospective flag is deliberately about an actual identity value, not merely
 * an enabled Organisation action: hidden/absent identity pipelines skip (or
 * report their own missing-name result) and must not block an independent
 * direct member-group assignment.
 */
function resolveOrganizationContext({
  fieldsById,
  fieldMappings,
  entityPipelines,
  values,
  hiddenFieldIds,
}) {
  const orgPipelines = Array.isArray(entityPipelines?.organisations)
    ? entityPipelines.organisations
    : [];
  const primaryOrg = resolvePrimaryOrganizationPipeline(orgPipelines);
  const topLevel = Array.isArray(fieldMappings)
    ? effectiveMappings(fieldMappings, values, hiddenFieldIds)
      .filter(mapping =>
        mapping?.target_entity === 'organization' && mapping.target_type !== 'custom')
    : [];
  const pipeline = primaryOrg
    ? (Array.isArray(primaryOrg.mappings)
      ? effectiveMappings(primaryOrg.mappings, values, hiddenFieldIds)
      : legacyOrganizationMappings(primaryOrg))
    : [];
  const primaryPipelineOwnsName = Array.isArray(primaryOrg?.mappings)
    && primaryOrg.mappings.some(mapping =>
      mapping?.target_type === 'core'
      && ORGANIZATION_NAME_TARGETS.has(String(mappingTarget(mapping))));
  // process-application skips top-level Organisation core mappings when the
  // primary modern pipeline owns that destination.  Keep this context
  // calculation in the same precedence order.
  const activeTopLevel = primaryPipelineOwnsName
    ? topLevel.filter(mapping =>
      !(mapping?.target_type === 'core'
        && ORGANIZATION_NAME_TARGETS.has(String(mappingTarget(mapping)))))
    : topLevel;
  const sources = [...activeTopLevel, ...pipeline];
  let organizationId = null;
  let hasIdentity = false;
  for (const mapping of sources) {
    if (mapping?.target_type !== 'core') continue;
    const target = String(mappingTarget(mapping) || '');
    if (!ORGANIZATION_NAME_TARGETS.has(target)
      && target !== 'organization_id') continue;
    const result = organizationMappingValue({
      mapping,
      field: fieldsById.get(String(mapping.source_field_id)),
      values,
    });
    if (!organizationId && result.organizationId) organizationId = result.organizationId;
    hasIdentity ||= result.hasIdentity;
  }
  return { organizationId, hasIdentity };
}

function pushMappingAssignment({
  assignments,
  mapping,
  fieldsById,
  values,
  hiddenFieldIds,
  role,
  pipelineId = null,
  label = null,
  targetEntity = null,
  email = null,
  organizationId = null,
}) {
  if (!mapping || mapping.target_type !== 'core') return;
  const configuredTargetEntity = mapping.target_entity || null;
  const owner = targetEntity || configuredTargetEntity;
  // Top-level mappings carry their owner in target_entity. Pipeline mappings
  // historically omitted that metadata because the pipeline itself supplies
  // the target entity; callers pass targetEntity for that format.
  if (targetEntity && configuredTargetEntity && configuredTargetEntity !== targetEntity) return;
  if (owner && !['member'].includes(owner)) return;
  if (!owner) return;
  if (mappingTarget(mapping) !== 'organization_group_id') return;
  const sourceType = mappingSourceType(mapping);
  const sourceFieldId = mapping.source_field_id || null;
  const hidden = sourceFieldId != null && hiddenFieldIds?.has(String(sourceFieldId));
  const value = sourceType === 'field'
    ? fieldValue(values, sourceFieldId)
    : sourceType === 'static'
      ? mapping.static_value
      : sourceType === 'clear'
        ? '__clear__'
          : sourceType === 'field'
            ? undefined
            : '__invalid_member_group_source__';
  const selection = resolveMemberOrganizationGroupSelection({
    field: fieldsById.get(String(sourceFieldId)),
    value,
    sourceType,
    sourceFieldId,
    hidden,
  });
  if (!selection) return;
  assignments.push({
    ...selection,
    role,
    pipelineId,
    label,
    organizationId,
    email,
  });
}

function pushLegacyFieldAssignment({
  assignments,
  field,
  values,
  hiddenFieldIds,
  role,
  pipelineId = null,
  label = null,
  email = null,
  organizationId = null,
}) {
  if (!field?.core_field_mapping) return;
  const [entity, target] = String(field.core_field_mapping).split('.');
  if (entity !== 'member' || target !== 'organization_group_id') return;
  const selection = resolveMemberOrganizationGroupSelection({
    field,
    value: fieldValue(values, field.id),
    sourceType: 'field',
    sourceFieldId: field.id,
    hidden: hiddenFieldIds?.has(String(field.id)),
  });
  if (!selection) return;
  assignments.push({
    ...selection,
    role,
    pipelineId,
    label,
    organizationId,
    email,
  });
}

function emailForPipeline({ pipeline, fieldsById, values, hiddenFieldIds }) {
  const mappings = Array.isArray(pipeline?.mappings) ? pipeline.mappings : [];
  const mapping = mappings.find(candidate =>
    mappingTarget(candidate) === 'email'
    && candidate.target_type !== 'custom');
  if (!mapping) return null;
  if (mappingSourceType(mapping) === 'static') {
    return mapping.static_value == null || mapping.static_value === ''
      ? null
      : String(mapping.static_value).trim().toLowerCase();
  }
  if (mappingSourceType(mapping) !== 'field' || !mapping.source_field_id) return null;
  if (hiddenFieldIds?.has(String(mapping.source_field_id))) return null;
  const source = fieldsById.get(String(mapping.source_field_id));
  if (!source || !Object.hasOwn(values || {}, mapping.source_field_id)) return null;
  const value = values[mapping.source_field_id];
  return value == null || value === '' ? null : String(value).trim().toLowerCase();
}

function organizationForPipeline({ pipeline, fieldsById, values, hiddenFieldIds }) {
  const mappings = Array.isArray(pipeline?.mappings) ? pipeline.mappings : [];
  const mapping = mappings.find(candidate =>
    mappingTarget(candidate) === 'organization_id'
    && candidate.target_type !== 'custom');
  if (!mapping || mappingSourceType(mapping) !== 'field' || !mapping.source_field_id) return null;
  if (hiddenFieldIds?.has(String(mapping.source_field_id))) return null;
  const source = fieldsById.get(String(mapping.source_field_id));
  if (!source || !Object.hasOwn(values || {}, mapping.source_field_id)) return null;
  const value = values[mapping.source_field_id];
  if (value == null || value === '' || isFormNotListedValue(value)) return null;
  return Array.isArray(value) ? value[0] || null : value;
}

function identityForConfig({ config, fieldsById, values, hiddenFieldIds }) {
  if (!config) return { email: null, organizationId: null };
  if (Array.isArray(config.mappings)) {
    return {
      email: emailForPipeline({ pipeline: config, fieldsById, values, hiddenFieldIds }),
      organizationId: organizationForPipeline({
        pipeline: config,
        fieldsById,
        values,
        hiddenFieldIds,
      }),
    };
  }
  const mappings = config.field_mappings;
  if (!isObject(mappings)) return { email: null, organizationId: null };
  const read = key => {
    const fieldId = mappings[key];
    if (!fieldId || fieldId === '__clear__' || hiddenFieldIds?.has(String(fieldId))) return null;
    const field = fieldsById.get(String(fieldId));
    if (!field || !Object.hasOwn(values || {}, fieldId)) return null;
    const value = values[fieldId];
    return value == null || value === '' ? null : Array.isArray(value) ? value[0] || null : value;
  };
  const email = read('email');
  return {
    email: email == null ? null : String(email).trim().toLowerCase(),
    organizationId: read('organization_id'),
  };
}

function effectiveMappings(mappings, values, hiddenFieldIds) {
  if (!Array.isArray(mappings)) return [];
  const { includedMappings } = partitionIgnoredHiddenMappings(mappings, hiddenFieldIds);
  return coalesceExplicitFallbackMappings(includedMappings, values, hiddenFieldIds);
}

/**
 * Collect all direct group assignments owned by the legacy member processing
 * paths.  The collection is intentionally configuration-driven: a similarly
 * shaped answer elsewhere in the submission is never treated as a group
 * reference.
 */
export function collectMemberOrganizationGroupAssignments({
  fields = [],
  fieldMappings = [],
  entityPipelines = {},
  additionalMemberCreations = [],
  formValues = {},
  hiddenFieldIds = new Set(),
  organizationProcessingEnabled = true,
} = {}) {
  const assignments = [];
  const fieldsById = new Map(
    (Array.isArray(fields) ? fields : [])
      .filter(field => field?.id != null)
      .map(field => [String(field.id), field]),
  );
  const hidden = hiddenFieldIds instanceof Set
    ? hiddenFieldIds
    : new Set(hiddenFieldIds || []);
  const members = Array.isArray(entityPipelines?.members) ? entityPipelines.members : [];
  const primary = members.find(item => item?.isPrimary || item?.is_primary) || null;
  const additional = members.filter(item => item && item !== primary
    && !item.isPrimary && !item.is_primary);
  const hasFieldMappings = Array.isArray(fieldMappings) && fieldMappings.length > 0;
  const effectiveFieldMappings = hasFieldMappings
    ? effectiveMappings(fieldMappings, formValues, hidden)
    : [];
  const organizationContext = organizationProcessingEnabled
    ? resolveOrganizationContext({
      fieldsById,
      fieldMappings,
      entityPipelines,
      values: formValues,
      hiddenFieldIds: hidden,
    })
    : { organizationId: null, hasIdentity: false };
  const topLevelMemberMappings = effectiveFieldMappings.filter(mapping =>
    mapping?.target_entity === 'member' && mapping.target_type === 'core');
  const topLevelMemberEmail = emailForPipeline({
    pipeline: { mappings: topLevelMemberMappings },
    fieldsById,
    values: formValues,
    hiddenFieldIds: hidden,
  });
  const primaryOwnsGroup = Array.isArray(primary?.mappings)
    ? primary.mappings.some(mapping =>
      mapping?.target_type === 'core' && mappingTarget(mapping) === 'organization_group_id')
    : false;
  const legacyPrimaryEmail = emailForPipeline({
    pipeline: { mappings: effectiveFieldMappings },
    fieldsById,
    values: formValues,
    hiddenFieldIds: hidden,
  });

  if (!primaryOwnsGroup && hasFieldMappings) {
    for (const mapping of effectiveFieldMappings) {
      pushMappingAssignment({
        assignments,
        mapping,
        fieldsById,
        values: formValues,
        hiddenFieldIds: hidden,
        role: 'legacy_primary',
        targetEntity: mapping.target_entity || null,
        email: topLevelMemberEmail || legacyPrimaryEmail,
        organizationId: organizationContext.organizationId,
      });
    }
  }

  if (!primaryOwnsGroup && !hasFieldMappings) {
    for (const field of Array.isArray(fields) ? fields : []) {
      pushLegacyFieldAssignment({
        assignments,
        field,
        values: formValues,
        hiddenFieldIds: hidden,
        role: 'legacy_primary',
        email: legacyPrimaryEmail,
        organizationId: organizationContext.organizationId,
      });
    }
  }

  if (primary?.mappings && Array.isArray(primary.mappings)) {
    const primaryMappings = effectiveMappings(primary.mappings, formValues, hidden);
    const primaryEmail = emailForPipeline({
      pipeline: { ...primary, mappings: primaryMappings },
      fieldsById,
      values: formValues,
      hiddenFieldIds: hidden,
    });
    for (const mapping of primaryMappings) {
      pushMappingAssignment({
        assignments,
        mapping,
        fieldsById,
        values: formValues,
        hiddenFieldIds: hidden,
        role: 'primary',
        pipelineId: primary.id || null,
        label: primary.label || null,
        targetEntity: 'member',
        email: primaryEmail,
        organizationId: organizationContext.organizationId,
      });
    }
  } else if (primary?.field_mappings && isObject(primary.field_mappings)) {
    const sourceFieldId = primary.field_mappings.organization_group_id;
    if (sourceFieldId) {
      pushMappingAssignment({
        assignments,
        mapping: {
          source_type: sourceFieldId === '__clear__' ? 'clear' : 'field',
          source_field_id: sourceFieldId,
          target_type: 'core',
          target_field: 'organization_group_id',
        },
        fieldsById,
        values: formValues,
        hiddenFieldIds: hidden,
        role: 'primary',
        pipelineId: primary.id || null,
        label: primary.label || null,
        targetEntity: 'member',
        email: identityForConfig({
          config: primary,
          fieldsById,
          values: formValues,
          hiddenFieldIds: hidden,
          }).email,
          organizationId: organizationContext.organizationId,
      });
    }
  }

  for (const pipeline of additional) {
    const pipelineMappings = Array.isArray(pipeline.mappings)
      ? effectiveMappings(pipeline.mappings, formValues, hidden)
      : null;
    const pipelineEmail = identityForConfig({
      config: pipelineMappings ? { ...pipeline, mappings: pipelineMappings } : pipeline,
      fieldsById,
      values: formValues,
      hiddenFieldIds: hidden,
    }).email;
    if (pipelineMappings) {
      for (const mapping of pipelineMappings) {
        pushMappingAssignment({
          assignments,
          mapping,
          fieldsById,
          values: formValues,
          hiddenFieldIds: hidden,
          role: 'additional',
          pipelineId: pipeline.id || null,
          label: pipeline.label || null,
          targetEntity: 'member',
          email: pipelineEmail,
          organizationId: organizationContext.organizationId,
        });
      }
    } else if (pipeline.field_mappings && isObject(pipeline.field_mappings)) {
      const sourceFieldId = pipeline.field_mappings.organization_group_id;
      if (sourceFieldId) {
        pushMappingAssignment({
          assignments,
          mapping: {
            source_type: sourceFieldId === '__clear__' ? 'clear' : 'field',
            source_field_id: sourceFieldId,
            target_type: 'core',
            target_field: 'organization_group_id',
          },
          fieldsById,
          values: formValues,
          hiddenFieldIds: hidden,
          role: 'additional',
          pipelineId: pipeline.id || null,
          label: pipeline.label || null,
          targetEntity: 'member',
          email: pipelineEmail,
          organizationId: organizationContext.organizationId,
        });
      }
    }
  }

  const activeLegacyAdditionalMembers = members.length > 0
    ? []
    : (Array.isArray(additionalMemberCreations) ? additionalMemberCreations : []);
  for (const config of activeLegacyAdditionalMembers) {
    const configMappings = Array.isArray(config?.mappings)
      ? effectiveMappings(config.mappings, formValues, hidden)
      : null;
    const configEmail = identityForConfig({
      config: configMappings ? { ...config, mappings: configMappings } : config,
      fieldsById,
      values: formValues,
      hiddenFieldIds: hidden,
    }).email;
    if (configMappings) {
      for (const mapping of configMappings) {
        pushMappingAssignment({
          assignments,
          mapping,
          fieldsById,
          values: formValues,
          hiddenFieldIds: hidden,
          role: 'legacy_additional',
          pipelineId: config.id || null,
          label: config.label || null,
          targetEntity: 'member',
          email: configEmail,
          organizationId: organizationContext.organizationId,
        });
      }
    } else if (config?.field_mappings && isObject(config.field_mappings)) {
      const sourceFieldId = config.field_mappings.organization_group_id;
      if (sourceFieldId) {
        pushMappingAssignment({
          assignments,
          mapping: {
            source_type: sourceFieldId === '__clear__' ? 'clear' : 'field',
            source_field_id: sourceFieldId,
            target_type: 'core',
            target_field: 'organization_group_id',
          },
          fieldsById,
          values: formValues,
          hiddenFieldIds: hidden,
          role: 'legacy_additional',
          pipelineId: config.id || null,
          label: config.label || null,
          targetEntity: 'member',
          email: configEmail,
          organizationId: organizationContext.organizationId,
        });
      }
    }
  }

  const pipelineById = new Map(
    [...members, ...activeLegacyAdditionalMembers]
      .filter(config => config?.id != null)
      .map(config => [
        String(config.id),
        Array.isArray(config.mappings)
          ? { ...config, mappings: effectiveMappings(config.mappings, formValues, hidden) }
          : config,
      ]),
  );
  for (const config of [...members, ...activeLegacyAdditionalMembers]) {
    if (config?.label) {
      pipelineById.set(
        `label:${String(config.label)}`,
        Array.isArray(config.mappings)
          ? { ...config, mappings: effectiveMappings(config.mappings, formValues, hidden) }
          : config,
      );
    }
  }
  for (const assignment of assignments) {
    const identity = identityForConfig({
      config: pipelineById.get(String(assignment.pipelineId || ''))
        || pipelineById.get(`label:${String(assignment.label || '')}`),
      fieldsById,
      values: formValues,
      hiddenFieldIds: hidden,
    });
    if (identity.email || identity.organizationId) {
      assignment.email = identity.email || assignment.email;
      assignment.organizationId = identity.organizationId || assignment.organizationId;
    } else if (assignment.role === 'legacy_primary' && !hasFieldMappings) {
      const emailField = (Array.isArray(fieldMappings) ? fieldMappings : []).find(mapping =>
        mapping?.target_entity === 'member'
        && mapping?.target_type !== 'custom'
        && mappingTarget(mapping) === 'email');
      if (emailField?.source_type === 'field' && emailField.source_field_id
        && !hidden.has(String(emailField.source_field_id))) {
        const value = fieldValue(formValues, emailField.source_field_id);
        if (value != null && value !== '') assignment.email = String(value).trim().toLowerCase();
      }
      if (!assignment.email) {
        const emailField = (Array.isArray(fields) ? fields : []).find(field =>
          String(field?.core_field_mapping || '') === 'member.email');
        if (emailField && !hidden.has(String(emailField.id))) {
          const value = fieldValue(formValues, emailField.id);
          if (value != null && value !== '') assignment.email = String(value).trim().toLowerCase();
        }
      }
    }
    if (!assignment.organizationId && organizationContext.organizationId) {
      assignment.organizationId = organizationContext.organizationId;
    }
    if (!assignment.organizationId && organizationContext.hasIdentity) {
      assignment.hasProspectiveOrganization = true;
    }
  }

  // A mapping can be present in a top-level contract and in a migrated primary
  // pipeline. The destination is still one assignment; retaining duplicates
  // would make conflict diagnostics depend on configuration migration order.
  const seen = new Set();
  return assignments.filter(assignment => {
    const key = [
      assignment.role,
      assignment.pipelineId || '',
      assignment.sourceFieldId,
      assignment.groupId,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadTenantGroup(db, tenantId, groupId) {
  if (!tenantId || !groupId) {
    throw new MemberOrganizationGroupValidationError(
      'Tenant context is required to assign a member Organisation Group',
    );
  }
  const { data, error } = await db
    .from('organization_group')
    .select('id, tenant_id')
    .eq('tenant_id', tenantId)
    .eq('id', String(groupId))
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new MemberOrganizationGroupValidationError(
      'Organisation Group selection is not available in this tenant',
    );
  }
  return data;
}

async function loadTenantOrganization(db, tenantId, organizationId) {
  if (!organizationId) return null;
  const { data, error } = await db
    .from('organization')
    .select('id, tenant_id, organization_group_id')
    .eq('tenant_id', tenantId)
    .eq('id', String(organizationId))
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new MemberOrganizationGroupValidationError(
      'The member effective Organisation is unavailable or cross-tenant',
    );
  }
  return data;
}

/**
 * Validate a resolved member direct-group write.  A direct group can only be
 * written when the member has no effective Organisation.  Existing
 * organisation-backed members therefore retain their current direct value;
 * a submitted group must nevertheless agree with the effective Organisation
 * so a stale or forged answer cannot be silently accepted.
 */
export async function validateMemberOrganizationGroupWrite({
  db,
  tenantId,
  groupId,
  organizationId = null,
  existingMember = null,
} = {}) {
  if (groupId === undefined || groupId === null || groupId === '') {
    return {
      groupId: null,
      organizationGroupId: null,
      organizationId: organizationId || existingMember?.organization_id || null,
      shouldWrite: false,
      organization: null,
    };
  }
  const group = await loadTenantGroup(db, tenantId, groupId);
  const effectiveOrganizationId = organizationId || existingMember?.organization_id || null;
  const organization = await loadTenantOrganization(db, tenantId, effectiveOrganizationId);
  if (organization) {
    if (String(organization.organization_group_id || '') !== String(group.id)) {
      throw new MemberOrganizationGroupValidationError(
        'Member Organisation Group conflicts with the effective Organisation',
      );
    }
    return {
      groupId: String(group.id),
      organizationGroupId: String(group.id),
      organizationId: organization.id,
      shouldWrite: false,
      organization,
    };
  }
  return {
    groupId: String(group.id),
    organizationGroupId: String(group.id),
    organizationId: null,
    shouldWrite: true,
    organization: null,
  };
}

/**
 * Validate every legacy/pipeline assignment before entity processing starts.
 * This is intentionally a read-only preflight. It validates the tenant
 * references and any already-known effective Organisations; callers can use
 * the returned assignments to perform the same no-op/write decision at the
 * eventual member boundary.
 */
export async function validateMemberOrganizationGroupAssignments({
  db,
  tenantId,
  assignments = [],
  organizationId = null,
  existingMembers = {},
  rejectUnknownOrganization = false,
} = {}) {
  const validated = [];
  for (const assignment of assignments || []) {
    let existingMember = assignment.memberId
      ? existingMembers[assignment.memberId] || null
      : assignment.email
        ? existingMembers[String(assignment.email).toLowerCase()] || null
        : null;
    if (!existingMember && assignment.memberId) {
      const { data, error } = await db.from('member')
        .select('id, tenant_id, organization_id')
        .eq('tenant_id', tenantId)
        .eq('id', String(assignment.memberId))
        .maybeSingle();
      if (error) throw error;
      existingMember = data || null;
    }
    if (!existingMember && assignment.email) {
      const { data, error } = await db.from('member')
        .select('id, tenant_id, organization_id')
        .eq('tenant_id', tenantId)
        .ilike('email', String(assignment.email).trim())
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      existingMember = data || null;
    }
    const effectiveOrganizationId = assignment.organizationId
      || organizationId
      || existingMember?.organization_id
      || null;
    if (!effectiveOrganizationId && rejectUnknownOrganization) {
      // A configured organization pipeline will produce an effective
      // Organisation before this member is persisted. Refusing the direct
      // assignment here keeps all validation before any entity side effect.
      throw new MemberOrganizationGroupValidationError(
        'Member Organisation Group cannot be assigned when an Organisation is being processed',
      );
    }
    const result = await validateMemberOrganizationGroupWrite({
      db,
      tenantId,
      groupId: assignment.groupId,
      organizationId: effectiveOrganizationId,
      existingMember,
    });
    validated.push({ ...assignment, ...result });
  }
  return validated;
}

