import { computeHiddenFieldIds } from './formFieldVisibility.js';
import { rulesUseLmicOperators } from './formLmicConditions.js';
import { loadTenantLmicCodes } from './tenantLmicCodes.js';
import { createFormRelationshipService } from './formRelationshipOptions.js';
import { coercePreferenceValueForStorage } from './preferenceValueStorage.js';
import { repeatableRowChildren, isRepeatableRowEmpty } from '../../shared/formRepeatableRows.js';
import { createHash } from 'node:crypto';
import { validateCustomObjectRecordData } from './customObjectDomain.js';
import {
  addressLookupVisibleComponents,
  isAddressLookupComponent,
} from '../../shared/formAddressLookup.js';
import {
  coalesceExplicitFallbackMappings,
  isExplicitFallbackMapping,
  validateExplicitFallbackGroups,
} from './formMappingFallbacks.js';

export const STRUCTURED_ACTIONS_VERSION = 1;

const ENTITY_ALIASES = {
  organisation: 'organization',
  organisation_group: 'organization_group',
};
const ENTITIES = new Set(['member', 'organization', 'organization_group', 'custom_object']);
const OPERATIONS = new Set(['create', 'update_selected', 'upsert']);
const CORE_COLUMNS = {
  member: new Set(['email', 'first_name', 'last_name', 'job_title', 'mobile', 'landline', 'organization_id', 'role_id', 'login_enabled', 'show_in_directory']),
  organization: new Set(['name', 'description', 'logo_url', 'invoicing_email', 'invoicing_address', 'phone', 'website_url', 'email', 'address', 'tags', 'organization_group_id']),
  organization_group: new Set(['name', 'description', 'logo_url']),
};
const CORE_FIELD_TYPES = {
  member: {
    first_name: 'text', last_name: 'text', email: 'email', mobile: 'text',
    landline: 'text', job_title: 'text', organization_id: 'reference:organization',
    show_in_directory: 'boolean',
  },
  organization: {
    name: 'text', description: 'text', logo_url: 'text', invoicing_email: 'email',
    invoicing_address: 'text', phone: 'text', website_url: 'text', tags: 'list',
    organization_group_id: 'reference:organization_group',
  },
  organization_group: { name: 'text', description: 'text' },
};
const TABLES = {
  member: 'member',
  organization: 'organization',
  organization_group: 'organization_group',
  custom_object: 'custom_object_record',
};
const PREF_TABLES = {
  member: ['member_preference_value', 'member_id'],
  organization: ['organization_preference_value', 'organization_id'],
  organization_group: ['organization_group_preference_value', 'organization_group_id'],
};

export class StructuredActionContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'StructuredActionContractError';
    this.code = 'INVALID_STRUCTURED_ACTIONS';
    this.status = 400;
    this.details = details;
  }
}

export class StructuredActionAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StructuredActionAuthorizationError';
    this.code = 'STRUCTURED_ACTION_FORBIDDEN';
    this.status = 403;
  }
}

const entityName = (action) => {
  const value = action?.target?.kind || action?.entity_type || action?.target_entity;
  return ENTITY_ALIASES[value] || value;
};
const operationName = (action) => {
  const value = action?.operation || action?.entity_action || action?.action;
  return value === 'update_selected' ? 'update' : value;
};
const actionMappings = (action) => Array.isArray(action?.mappings) ? action.mappings : [];
const repeatableId = (action) => action?.source?.repeatable_field_id || action?.repeatable_field_id || action?.source_repeatable_field_id || action?.container_field_id || null;
const actionObjectId = (action) => action?.target?.custom_object_id || action?.custom_object_id || action?.target_custom_object_id || null;
const targetField = (mapping) => mapping?.target_field_id || mapping?.target_field;
const sourceFieldsFor = (action, fields) => action?.source?.scope === 'repeatable_row'
  ? repeatableRowChildren((fields || []).find(field => String(field?.id) === String(repeatableId(action))))
  : (fields || []);

export function assertStructuredMutationAuthorized({ action, recordId, authorization = {} }) {
  const entity = entityName(action);
  if (authorization.isAdmin === true) return true;
  if (['custom_object', 'organization_group'].includes(entity)) {
    throw new StructuredActionAuthorizationError(
      `Creating or updating ${entity.replaceAll('_', ' ')} records requires administrator access`,
    );
  }
  if (!recordId) return true;
  const allowedId = entity === 'member'
    ? authorization.verifiedMemberId
    : entity === 'organization'
      ? authorization.verifiedOrganizationId
      : null;
  if (!allowedId || String(allowedId) !== String(recordId)) {
    throw new StructuredActionAuthorizationError(
      `Updating the selected ${entity.replaceAll('_', ' ')} record requires administrator access or verified ownership`,
    );
  }
  return true;
}

export function assertStructuredRelationshipParentAuthorized({
  parentDescriptor,
  parentId,
  authorization = {},
}) {
  return assertStructuredMutationAuthorized({
    action: { target: { kind: parentDescriptor?.kind } },
    recordId: parentId,
    authorization,
  });
}

export function validateStructuredActionsContract(input, fields = []) {
  if (input == null) return null;
  const contract = Array.isArray(input) ? { version: 1, actions: input } : input;
  const errors = [];
  if (!contract || typeof contract !== 'object') errors.push('structured_actions must be an object');
  const version = Number(contract?.version ?? contract?.contract_version);
  if (version !== STRUCTURED_ACTIONS_VERSION) errors.push(`unsupported structured_actions version ${contract?.version ?? contract?.contract_version}`);
  if (!Array.isArray(contract?.actions)) errors.push('actions must be an array');
  const fieldMap = new Map((fields || []).filter(f => f?.id).map(f => [String(f.id), f]));
  const ids = new Set();
  for (const [index, action] of (contract?.actions || []).entries()) {
    const prefix = `actions[${index}]`;
    const id = String(action?.id || '');
    const entity = entityName(action);
    const operation = action?.operation;
    const sourceScope = action?.source?.scope;
    if (!id) errors.push(`${prefix}.id is required`);
    else if (ids.has(id)) errors.push(`${prefix}.id is duplicated`);
    else ids.add(id);
    if (!ENTITIES.has(entity)) errors.push(`${prefix}.entity_type is invalid`);
    if (!OPERATIONS.has(operation)) errors.push(`${prefix}.operation is invalid`);
    if (action?.record_id || action?.target_record_id) {
      errors.push(`${prefix} cannot contain a direct target record ID`);
    }
    if (!['top_level', 'repeatable_row'].includes(sourceScope)) {
      errors.push(`${prefix}.source.scope must be top_level or repeatable_row`);
    }
    if (entity === 'custom_object' && !actionObjectId(action)) errors.push(`${prefix}.custom_object_id is required`);
    if (action?.operation === 'update_selected' && (!action.relationship_definition_id || !action.selector_field_id)) {
      errors.push(`${prefix}.relationship_definition_id and selector_field_id are required for update_selected`);
    }
    const containerId = repeatableId(action);
    if (sourceScope === 'repeatable_row' && !containerId) {
      errors.push(`${prefix}.source.repeatable_field_id is required for repeatable_row scope`);
    }
    if (containerId) {
      const container = fieldMap.get(String(containerId));
      if (!container || !['repeatable_row', 'repeatable_rows'].includes(container.type)) {
        errors.push(`${prefix}.repeatable_field_id does not identify a repeatable field`);
      }
    }
    if (actionMappings(action).length === 0) errors.push(`${prefix}.mappings must not be empty`);
    const mappedTargets = new Set();
    const mappingIds = new Set();
    const sourceFields = sourceFieldsFor(action, fields);
    const selector = sourceFields.find(field => String(field?.id) === String(action?.selector_field_id));
    const selectorDescriptor = fieldRecordDescriptor(selector);
    if (action?.selector_field_id && (!selector || !isRelationshipField(selector)
      || String(selector.relationship_definition_id || '') !== String(action.relationship_definition_id || '')
      || selectorDescriptor?.kind !== entity
      || (entity === 'custom_object'
        && String(selectorDescriptor?.customObjectId) !== String(actionObjectId(action))))) {
      errors.push(`${prefix}.selector_field_id must be a compatible relationship dropdown in the action source scope`);
    }
    if (action?.relationship_definition_id && action?.operation !== 'update_selected') {
      const parentField = sourceFields.find(field =>
        String(field?.id) === String(action.relationship_parent_field_id));
      if (!parentField || !fieldRecordDescriptor(parentField)) {
        errors.push(`${prefix}.relationship_parent_field_id must identify a record field in the action source scope`);
      }
    }
    const mappings = actionMappings(action);
    for (const detail of validateExplicitFallbackGroups(mappings)) errors.push(`${prefix}.${detail}`);
    for (const [mappingIndex, mapping] of mappings.entries()) {
      const mp = `${prefix}.mappings[${mappingIndex}]`;
      if (!mapping?.id || mappingIds.has(String(mapping.id))) {
        errors.push(`${mp}.id is required and must be unique within the action`);
      } else {
        mappingIds.add(String(mapping.id));
      }
      const targetType = mapping?.target_type || 'core';
      const mappedTargetKey = `${targetType}:${targetField(mapping) || ''}`;
      if (mappedTargets.has(mappedTargetKey) && !isExplicitFallbackMapping(mapping)) errors.push(`${mp} duplicates another target mapping`);
      else mappedTargets.add(mappedTargetKey);
      if (!targetField(mapping)) errors.push(`${mp}.target_field_id is required`);
      if (!mapping?.source_field_id && !['static', 'clear'].includes(mapping?.source_type) && mapping?.static_value === undefined) {
        errors.push(`${mp}.source_field_id is required`);
      }
      const sourceField = sourceFields.find(field => String(field?.id) === String(mapping?.source_field_id));
      if (mapping?.source_field_id && !sourceField) {
        errors.push(`${mp}.source_field_id is not in the persisted action source scope`);
      }
      if (mapping?.source_component !== undefined) {
        if (!sourceField || sourceField.type !== 'address_lookup' || !isAddressLookupComponent(mapping.source_component)) {
          errors.push(`${mp}.source_component must be a valid address_lookup component`);
        } else if (!addressLookupVisibleComponents(sourceField).includes(mapping.source_component)) {
          errors.push(`${mp}.source_component must identify a visible address_lookup component`);
        }
      }
      if (sourceField?.type === 'address_lookup' && mapping?.source_component === undefined) {
        errors.push(`${mp}.source_component is required for an address_lookup source`);
      }
      if (sourceField && isRelationshipField(sourceField)) {
        const permitted = ['organisation_dropdown', 'organization_dropdown'].includes(sourceField.type)
          ? entity === 'member' && targetType === 'core' && targetField(mapping) === 'organization_id'
          : ['organisation_group_dropdown', 'organization_group_dropdown'].includes(sourceField.type)
            ? entity === 'organization' && targetType === 'core' && targetField(mapping) === 'organization_group_id'
            : false;
        if (!permitted) errors.push(`${mp} relationship/record selector can only map to a compatible reference core target`);
      }
      if (targetType === 'core' && entity !== 'custom_object' && !CORE_COLUMNS[entity]?.has(targetField(mapping))) {
        errors.push(`${mp}.target_field is not writable for ${entity}`);
      }
      if (!['core', 'custom'].includes(targetType)) errors.push(`${mp}.target_type is invalid`);
    }
    if (action?.operation === 'upsert') {
      if (!action.uniqueness_field) errors.push(`${prefix}.uniqueness_field is required for upsert`);
      const uniqueMappings = actionMappings(action).filter(mapping =>
        String(targetField(mapping)) === String(action.uniqueness_field));
      const uniqueGroups = new Set(uniqueMappings.map(mapping => isExplicitFallbackMapping(mapping)
        ? `group:${mapping.fallback_group.id}`
        : `mapping:${mapping.id}`));
      if (uniqueGroups.size !== 1) {
        errors.push(`${prefix}.uniqueness_field must identify exactly one mapped target field`);
      }
      if (entity === 'member' && action.uniqueness_field !== 'email') {
        errors.push(`${prefix}.uniqueness_field must be email for member upsert`);
      }
      if (['organization', 'organization_group'].includes(entity) && action.uniqueness_field !== 'name') {
        errors.push(`${prefix}.uniqueness_field must be name for ${entity} upsert`);
      }
      if (entity === 'custom_object' && uniqueMappings[0]?.target_type !== 'custom') {
        errors.push(`${prefix}.custom object uniqueness_field must be a custom field`);
      }
    }
    if (action?.operation !== 'update_selected') {
      const requiredCore = entity === 'member' ? 'email'
        : ['organization', 'organization_group'].includes(entity) ? 'name' : null;
      if (requiredCore && !actionMappings(action).some(mapping =>
        (mapping.target_type || 'core') === 'core' && targetField(mapping) === requiredCore)) {
        errors.push(`${prefix} must map required core field ${requiredCore}`);
      }
    }
  }
  if (errors.length) throw new StructuredActionContractError('Invalid persisted structured_actions contract', errors);
  return { version, actions: contract.actions };
}

function sourceValue(mapping, values) {
  let value = mapping.source_type === 'clear'
    ? '__clear__'
    : mapping.source_type === 'static' || mapping.static_value !== undefined
    ? mapping.static_value
    : values?.[mapping.source_field_id];
  if (mapping.source_component !== undefined) {
    value = value && typeof value === 'object' && !Array.isArray(value)
      ? value[mapping.source_component]
      : undefined;
  }
  if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
    value = value[mapping.source_category_id];
  }
  if (value == null) return value;
  const transformation = mapping.transformation;
  if (!transformation || transformation === 'none') return value;
  const text = String(value);
  if (transformation === 'trim') return text.trim();
  if (transformation === 'lowercase') return text.toLowerCase();
  if (transformation === 'uppercase') return text.toUpperCase();
  if (transformation === 'titlecase') return text.replace(/\w\S*/g, s => s[0].toUpperCase() + s.slice(1).toLowerCase());
  if (transformation === 'current_date') return new Date().toISOString().slice(0, 10);
  if (transformation === 'extract_domain') return text.split('@').pop().replace(/^www\./i, '').toLowerCase();
  if (transformation === 'numbers_only') return text.replace(/\D/g, '');
  return value;
}

function visibilityForm(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  return {
    ...form,
    fields: fields.flatMap(field => [field, ...repeatableRowChildren(field)]),
  };
}

function structuredHiddenFieldIds(form, submissionData, visibilityOptions = {}) {
  return computeHiddenFieldIds(visibilityForm(form), submissionData || {}, visibilityOptions);
}

function visibleValues(values, hidden) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([key]) => !hidden.has(String(key))));
}

export function expandStructuredActionInvocations(contract, form, submissionData, visibilityOptions = {}) {
  const hidden = structuredHiddenFieldIds(form, submissionData, visibilityOptions);
  const fields = new Map((form?.fields || []).filter(f => f?.id).map(f => [String(f.id), f]));
  const invocations = [];
  for (const action of contract.actions) {
    const containerId = repeatableId(action);
    if (!containerId) {
      const values = visibleValues(submissionData, hidden);
      const selectedRecordId = selectedRelationshipRecordId(action, form?.fields || [], values);
      invocations.push({ action, rowIndex: null, values, selectedRecordId, invocationKey: `${action.id}:top` });
      continue;
    }
    if (hidden.has(containerId)) continue;
    const container = fields.get(String(containerId));
    const rows = submissionData?.[containerId];
    if (!container || !Array.isArray(rows)) continue;
    const visibleChildren = repeatableRowChildren(container).filter(child => !hidden.has(String(child?.id)));
    rows.forEach((row) => {
      if (!row || typeof row !== 'object' || row._deleted === true || row.deleted === true || row.active === false) return;
      const values = visibleValues(row, hidden);
      if (isRepeatableRowEmpty(values, visibleChildren)) return;
      if (!row._row_id) throw new StructuredActionContractError(`Repeatable action ${action.id} requires persisted row._row_id`);
      const selectedRecordId = selectedRelationshipRecordId(action, visibleChildren, values);
      invocations.push({ action, rowIndex: null, rowId: String(row._row_id), values, selectedRecordId, invocationKey: `${action.id}:row:${row._row_id}` });
    });
  }
  return invocations;
}

function selectedRelationshipRecordId(action, fields, values) {
  if (action?.operation !== 'update_selected' || !action?.selector_field_id) return null;
  const value = values?.[action.selector_field_id];
  return Array.isArray(value) ? value[0] || null : value || null;
}

function noteArray(notes) {
  if (Array.isArray(notes)) return notes;
  return notes ? [{ at: new Date().toISOString(), kind: 'legacy_processing_note', message: String(notes) }] : [];
}

function isRelationshipField(field) {
  return ['member_dropdown', 'organisation_dropdown', 'organization_dropdown', 'organisation_group_dropdown', 'organization_group_dropdown', 'relationship_dropdown', 'custom_object_relationship'].includes(field?.type);
}

function fieldRecordDescriptor(field) {
  if (['organisation_dropdown', 'organization_dropdown'].includes(field?.type)) {
    return { kind: 'organization', customObjectId: null };
  }
  if (['organisation_group_dropdown', 'organization_group_dropdown'].includes(field?.type)) {
    return { kind: 'organization_group', customObjectId: null };
  }
  if (field?.type === 'member_dropdown') return { kind: 'member', customObjectId: null };
  if (field?.type === 'relationship_dropdown') {
    return {
      kind: field.related_kind || 'custom_object',
      customObjectId: field.related_custom_object_id || field.custom_object_id || null,
    };
  }
  return null;
}

function primaryPipelineFor(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) return null;
  return pipelines.find(pipeline => pipeline?.isPrimary || pipeline?.is_primary) || pipelines[0];
}

function pipelineRelatedRecords(pipeline) {
  return Array.isArray(pipeline?.related_records) ? pipeline.related_records : [];
}

export function validatePrimaryPipelineRelatedRecordsContract(form) {
  const errors = [];
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const definitions = [
    ['member', primaryPipelineFor(form?.entity_pipelines?.members)],
    ['organization', primaryPipelineFor(form?.entity_pipelines?.organisations)],
  ];
  for (const [kind, pipeline] of definitions) {
    const ids = new Set();
    for (const [index, link] of pipelineRelatedRecords(pipeline).entries()) {
      const prefix = `${kind}.related_records[${index}]`;
      if (!link?.id || ids.has(String(link.id))) errors.push(`${prefix}.id is required and must be unique`);
      else ids.add(String(link.id));
      if (!link?.relationship_definition_id) errors.push(`${prefix}.relationship_definition_id is required`);
      const field = fields.find(candidate => String(candidate?.id) === String(link?.source_field_id));
      if (!field || field.type !== 'relationship_dropdown' || !fieldRecordDescriptor(field)) {
        errors.push(`${prefix}.source_field_id must identify a submitted Relationship Dropdown field`);
      }
    }
  }
  if (errors.length) {
    throw new StructuredActionContractError('Invalid primary pipeline Related Records configuration', errors);
  }
  return definitions.filter(([, pipeline]) => pipelineRelatedRecords(pipeline).length > 0);
}

export async function processPrimaryPipelineRelatedRecords({
  db,
  tenantId,
  form,
  submission,
  memberId = null,
  organizationId = null,
}) {
  let configured;
  try {
    configured = validatePrimaryPipelineRelatedRecordsContract(form);
  } catch (error) {
    return {
      success: false,
      partial: false,
      outcomes: [{ status: 'failed', error: error.message || String(error), details: error.details || [], reason: 'invalid_configuration' }],
      linked_count: 0,
      skipped_count: 0,
      failed_count: 1,
    };
  }
  if (configured.length === 0) return null;
  const answers = submission?.submission_data || {};
  const outcomes = [];
  let visibilityOptions;
  let hidden;
  try {
    visibilityOptions = rulesUseLmicOperators(form?.visibility_rules)
      ? { lmicCodes: await loadTenantLmicCodes(db, tenantId) }
      : {};
    hidden = structuredHiddenFieldIds(form, answers, visibilityOptions);
  } catch (error) {
    return {
      success: false,
      partial: false,
      outcomes: [{ status: 'failed', error: error.message || String(error), reason: 'visibility_resolution_failed' }],
      linked_count: 0,
      skipped_count: 0,
      failed_count: 1,
    };
  }
  try {
    await createFormRelationshipService({ db, tenantId }).validateSubmission({
      form,
      submissionData: answers,
      hiddenFieldIds: hidden,
      visibilityOptions,
    });
  } catch (error) {
    return {
      success: false,
      partial: false,
      outcomes: [{ status: 'failed', error: error.message || String(error), reason: 'submitted_relationship_invalid' }],
      linked_count: 0,
      skipped_count: 0,
      failed_count: 1,
    };
  }
  for (const [kind, pipeline] of configured) {
    const primaryId = kind === 'member' ? memberId : organizationId;
    for (const link of pipelineRelatedRecords(pipeline)) {
      const base = {
        id: link.id,
        entity_type: kind,
        source_field_id: link.source_field_id,
        relationship_definition_id: link.relationship_definition_id,
      };
      if (!primaryId) {
        outcomes.push({ ...base, status: 'skipped', reason: 'primary_record_unavailable' });
        continue;
      }
      const field = (form.fields || []).find(candidate => String(candidate?.id) === String(link.source_field_id));
      const relatedDescriptor = fieldRecordDescriptor(field);
      if (hidden.has(String(link.source_field_id))) {
        outcomes.push({ ...base, status: 'skipped', reason: 'source_field_hidden' });
        continue;
      }
      const selected = answers?.[link.source_field_id];
      const selectedIds = [...new Set((Array.isArray(selected) ? selected : [selected]).filter(Boolean))];
      if (selectedIds.length === 0) {
        outcomes.push({ ...base, status: 'skipped', reason: 'relationship_selection_missing' });
        continue;
      }
      try {
        const { data: definition, error: definitionError } = await db
          .from('custom_object_relationship_definition').select('*')
          .eq('tenant_id', tenantId).eq('id', link.relationship_definition_id)
          .eq('status', 'active').maybeSingle();
        if (definitionError) throw definitionError;
        const primarySide = ['source', 'target'].find(side =>
          definition?.[`${side}_kind`] === kind && definition?.[`${side}_custom_object_id`] == null);
        const relatedSide = primarySide === 'source' ? 'target' : primarySide === 'target' ? 'source' : null;
        const compatible = definition && relatedSide
          && definition[`${relatedSide}_kind`] === relatedDescriptor?.kind
          && String(definition[`${relatedSide}_custom_object_id`] || '')
            === String(relatedDescriptor?.customObjectId || '');
        if (!compatible) throw new StructuredActionContractError('Related Records relationship is inactive, cross-tenant, or incompatible');
        for (const selectedId of selectedIds) {
          let endpointQuery = db.from(TABLES[relatedDescriptor.kind]).select('id')
            .eq('tenant_id', tenantId).eq('id', selectedId);
          if (relatedDescriptor.kind === 'custom_object') {
            endpointQuery = endpointQuery.eq('custom_object_id', relatedDescriptor.customObjectId).is('archived_at', null);
          }
          const { data: endpoint, error: endpointError } = await endpointQuery.maybeSingle();
          if (endpointError || !endpoint) throw new StructuredActionContractError('Submitted related record is unavailable');
          const sourceId = primarySide === 'source' ? primaryId : selectedId;
          const targetId = primarySide === 'target' ? primaryId : selectedId;
          const { data: existing, error: existingError } = await db.from('custom_object_relationship')
            .select('id').eq('tenant_id', tenantId).eq('relationship_definition_id', definition.id)
            .eq('source_record_id', sourceId).eq('target_record_id', targetId)
            .is('archived_at', null).maybeSingle();
          if (existingError) throw existingError;
          if (!existing) {
            const { error } = await db.from('custom_object_relationship').insert({
              tenant_id: tenantId,
              relationship_definition_id: definition.id,
              source_record_id: sourceId,
              target_record_id: targetId,
            });
            if (error && error.code !== '23505') throw error;
          }
          outcomes.push({ ...base, status: existing ? 'already_linked' : 'linked', record_id: selectedId, primary_record_id: primaryId });
        }
      } catch (error) {
        outcomes.push({
          ...base,
          status: 'failed',
          reason: 'relationship_link_failed',
          error: error.message || String(error),
        });
      }
    }
  }
  const failed = outcomes.filter(outcome => outcome.status === 'failed');
  return {
    success: failed.length === 0,
    partial: failed.length > 0 && outcomes.some(outcome => ['linked', 'already_linked'].includes(outcome.status)),
    outcomes,
    linked_count: outcomes.filter(outcome => outcome.status === 'linked').length,
    skipped_count: outcomes.filter(outcome => ['skipped', 'already_linked'].includes(outcome.status)).length,
    failed_count: failed.length,
  };
}

function mappingFamily(field) {
  const descriptor = fieldRecordDescriptor(field);
  if (descriptor) return `reference:${descriptor.kind}`;
  const type = String(field?.type || field?.field_type || '').toLowerCase();
  if (type === 'address_lookup') return 'text';
  if (['text', 'textarea', 'url', 'tel', 'phone', 'contact'].includes(type)) return 'text';
  if (type === 'email') return 'email';
  if (['number', 'percentage', 'currency', 'decimal'].includes(type)) return 'number';
  if (['date', 'time'].includes(type)) return type;
  if (type === 'boolean') return 'boolean';
  if (['checkbox', 'checkboxes', 'list', 'multiselect', 'countries', 'category_multiselect'].includes(type)) return 'list';
  return 'choice';
}

function compatibleFamilies(sourceFamily, targetFamily) {
  if (sourceFamily.startsWith('reference:') || targetFamily.startsWith('reference:')) {
    return sourceFamily === targetFamily;
  }
  if (targetFamily === 'text' || targetFamily === 'choice') {
    return ['text', 'email', 'choice'].includes(sourceFamily);
  }
  return sourceFamily === targetFamily;
}

function validateRuntimeMappingCompatibility(contract, formFields, preferenceFields) {
  for (const action of contract.actions) {
    const sourceFields = sourceFieldsFor(action, formFields);
    for (const mapping of actionMappings(action)) {
      if (!mapping.source_field_id) continue;
      const source = sourceFields.find(field => String(field.id) === String(mapping.source_field_id));
      let targetFamily;
      if ((mapping.target_type || 'core') === 'core') {
        targetFamily = CORE_FIELD_TYPES[entityName(action)]?.[targetField(mapping)];
      } else {
        const preference = preferenceFields.get(String(targetField(mapping)));
        targetFamily = preference ? mappingFamily(preference) : null;
      }
      if (!source || !targetFamily || !compatibleFamilies(mappingFamily(source), targetFamily)) {
        throw new StructuredActionContractError(
          `Action ${action.id} contains an incompatible mapping for ${targetField(mapping)}`,
        );
      }
    }
    if (action.operation === 'upsert' && entityName(action) === 'custom_object') {
      const uniqueField = preferenceFields.get(String(action.uniqueness_field));
      const eligible = new Set(['text', 'email', 'url', 'number', 'decimal', 'date', 'dropdown', 'country']);
      if (!uniqueField || !eligible.has(String(uniqueField.field_type || uniqueField.type || '').toLowerCase())) {
        throw new StructuredActionContractError(`Action ${action.id} uses an ineligible Custom Object uniqueness field`);
      }
    }
  }
}

async function validateDirectSelectors(db, tenantId, form, submissionData, visibilityOptions = {}) {
  const hidden = structuredHiddenFieldIds(form, submissionData, visibilityOptions);
  const checks = [];
  const inspect = (field, value, context) => {
    if (!field || hidden.has(field.id) || value == null || value === '') return;
    if (isRelationshipField(field)) checks.push({ field, value, context });
  };
  for (const field of form.fields || []) {
    if (['repeatable_row', 'repeatable_rows'].includes(field?.type)) {
      if (hidden.has(field.id)) continue;
      for (const [rowIndex, row] of (submissionData?.[field.id] || []).entries()) {
        for (const child of repeatableRowChildren(field)) inspect(child, row?.[child.id], `${field.id}[${rowIndex}].${child.id}`);
      }
    } else inspect(field, submissionData?.[field.id], field.id);
  }
  const tableFor = field => {
    if (field.type === 'member_dropdown') return ['member', null];
    if (['organisation_dropdown', 'organization_dropdown'].includes(field.type)) return ['organization', null];
    if (['organisation_group_dropdown', 'organization_group_dropdown'].includes(field.type)) return ['organization_group', null];
    const objectId = field.related_custom_object_id || field.custom_object_id;
    return objectId ? ['custom_object_record', objectId] : [null, null];
  };
  for (const { field, value, context } of checks) {
    const values = Array.isArray(value) ? value : [value];
    const [table, objectId] = tableFor(field);
    if (!table) continue; // The relationship service below validates chained relationship selectors.
    for (const id of values.filter(Boolean)) {
      let query = db.from(table).select('id').eq('tenant_id', tenantId).eq('id', id);
      if (objectId) query = query.eq('custom_object_id', objectId).is('archived_at', null);
      const { data, error } = await query.maybeSingle();
      if (error || !data) throw new StructuredActionContractError(`Invalid relationship selector at ${context}`);
    }
  }
  await createFormRelationshipService({ db, tenantId }).validateSubmission({
    form,
    submissionData: submissionData || {},
    hiddenFieldIds: hidden,
    visibilityOptions,
  });
}

async function loadPreferenceFields(db, tenantId) {
  const { data, error } = await db.from('preference_field').select('*').eq('tenant_id', tenantId).eq('is_active', true);
  if (error) throw error;
  return new Map((data || []).map(field => [String(field.id), field]));
}

export function mappedPayload(invocation, entity, preferenceFields) {
  const core = {};
  const custom = {};
  const clearCustom = new Set();
  const match = [];
  const mappings = coalesceExplicitFallbackMappings(
    actionMappings(invocation.action),
    invocation.values,
  );
  for (const mapping of mappings) {
    const value = sourceValue(mapping, invocation.values);
    if (value === undefined) continue;
    const targetType = mapping.target_type || (entity === 'custom_object' ? 'custom' : 'core');
    if (targetType === 'custom') {
      const mappedTarget = targetField(mapping);
      const field = preferenceFields.get(String(mappedTarget));
      const key = entity === 'custom_object'
        ? (field?.field_key || field?.name || mappedTarget)
        : mappedTarget;
      if (value === '__clear__') {
        clearCustom.add(key);
        delete custom[key];
      } else {
        custom[key] = value;
      }
    } else {
      core[targetField(mapping)] = value === '__clear__' ? null : value;
    }
    if (mapping.is_match === true || mapping.match === true
      || invocation.action.uniqueness_field === targetField(mapping)
      || (invocation.action.match_by || []).includes(targetField(mapping))) {
      const matchField = targetType === 'custom' && entity === 'custom_object'
        ? (preferenceFields.get(String(targetField(mapping)))?.field_key
          || preferenceFields.get(String(targetField(mapping)))?.name
          || targetField(mapping))
        : targetField(mapping);
      match.push({
        targetType,
        field: matchField,
        targetFieldId: targetField(mapping),
        value: value === '__clear__' ? null : value,
      });
    }
  }
  if (match.length === 0) {
    const fallback = entity === 'member' ? 'email' : entity === 'custom_object' ? null : 'name';
    if (fallback && core[fallback] != null && core[fallback] !== '') match.push({ targetType: 'core', field: fallback, value: core[fallback] });
  }
  const uniquenessMappings = actionMappings(invocation.action).filter(mapping =>
    targetField(mapping) === invocation.action.uniqueness_field);
  if (invocation.action.operation === 'upsert'
    && uniquenessMappings.some(isExplicitFallbackMapping)
    && !match.some(item => item.targetFieldId === invocation.action.uniqueness_field
      && item.value !== undefined
      && item.value !== null
      && item.value !== ''
      && !(Array.isArray(item.value) && item.value.length === 0))) {
    throw new StructuredActionContractError('Upsert fallback uniqueness field has no visible, non-empty value');
  }
  return { core, custom, clearCustom, match };
}

async function findExisting(db, tenantId, entity, action, payload) {
  const explicitId = action.record_id || action.target_record_id || payload.core.id;
  let query = db.from(TABLES[entity]).select('*').eq('tenant_id', tenantId);
  if (entity === 'custom_object') query = query.eq('custom_object_id', actionObjectId(action)).is('archived_at', null);
  if (explicitId) return (await query.eq('id', explicitId).maybeSingle()).data || null;
  if (!payload.match.length) return null;
  for (const criterion of payload.match) {
    if (criterion.value == null || criterion.value === '') return null;
    if (entity === 'custom_object' || criterion.targetType === 'custom') {
      if (entity !== 'custom_object') return null;
      const field = criterion.field;
      query = query.contains('data', { [field]: criterion.value });
    } else if (criterion.field === 'email' || criterion.field === 'name') {
      query = query.ilike(criterion.field, String(criterion.value).replace(/[%_]/g, '\\$&'));
    } else {
      query = query.eq(criterion.field, criterion.value);
    }
  }
  const { data, error } = await query.limit(2);
  if (error) throw error;
  if ((data || []).length > 1) throw new StructuredActionContractError(`Upsert identity is ambiguous for action ${action.id}`);
  return data?.[0] || null;
}

async function writePreferences(db, tenantId, entity, recordId, values, preferenceFields, clearFields = new Set()) {
  const target = PREF_TABLES[entity];
  if (!target) return;
  const [table, parentColumn] = target;
  for (const fieldId of clearFields) {
    const field = preferenceFields.get(String(fieldId));
    if (!field || field.entity_scope !== entity || String(field.tenant_id) !== String(tenantId)) {
      throw new StructuredActionContractError(`Custom field ${fieldId} is not active for ${entity}`);
    }
    const { error } = await db.from(table).delete().eq(parentColumn, recordId).eq('field_id', fieldId);
    if (error) throw error;
  }
  for (const [fieldId, value] of Object.entries(values)) {
    const field = preferenceFields.get(String(fieldId));
    if (!field || field.entity_scope !== entity || String(field.tenant_id) !== String(tenantId)) {
      throw new StructuredActionContractError(`Custom field ${fieldId} is not active for ${entity}`);
    }
    const stored = coercePreferenceValueForStorage(value, field);
    if (stored === undefined) continue;
    const { data: existing, error: lookupError } = await db.from(table).select('id').eq(parentColumn, recordId).eq('field_id', fieldId).limit(1);
    if (lookupError) throw lookupError;
    if (existing?.[0]) {
      const { error } = await db.from(table).update({ value: stored }).eq('id', existing[0].id);
      if (error) throw error;
    } else {
      const { error } = await db.from(table).insert({ [parentColumn]: recordId, field_id: fieldId, value: stored });
      if (error) throw error;
    }
  }
}

function relationshipLinkContext(invocation, definition) {
  if (!definition || invocation.action.operation === 'update_selected') return;
  const parentId = invocation.values?.[invocation.action.relationship_parent_field_id];
  if (!parentId) throw new StructuredActionContractError('A relationship parent selection is required');
  const entity = entityName(invocation.action);
  const objectId = actionObjectId(invocation.action);
  const endpoint = side => ({
    kind: definition[`${side}_kind`],
    customObjectId: definition[`${side}_custom_object_id`] || null,
  });
  const targetSide = ['source', 'target'].find(side => {
    const candidate = endpoint(side);
    return candidate.kind === entity
      && (entity !== 'custom_object' || String(candidate.customObjectId) === String(objectId));
  });
  if (!targetSide) throw new StructuredActionContractError('Configured relationship does not contain the action target');
  const parentSide = targetSide === 'source' ? 'target' : 'source';
  const parentField = sourceFieldsFor(invocation.action, invocation.formFields || [])
    .find(field => String(field?.id) === String(invocation.action.relationship_parent_field_id));
  const parentDescriptor = fieldRecordDescriptor(parentField);
  const expectedParent = endpoint(parentSide);
  if (!parentDescriptor || parentDescriptor.kind !== expectedParent.kind
    || (expectedParent.kind === 'custom_object'
      && String(parentDescriptor.customObjectId) !== String(expectedParent.customObjectId))) {
    throw new StructuredActionContractError('Relationship parent field is incompatible with the configured relationship');
  }
  return { parentId, parentDescriptor, targetSide };
}

async function ensureRelationshipLink(db, tenantId, invocation, recordId, definition, authorization = {}) {
  const context = relationshipLinkContext(invocation, definition);
  if (!context) return;
  const { parentId, parentDescriptor, targetSide } = context;
  assertStructuredRelationshipParentAuthorized({ parentDescriptor, parentId, authorization });
  const sourceId = targetSide === 'source' ? recordId : parentId;
  const targetId = targetSide === 'target' ? recordId : parentId;
  const { data: existing, error: lookupError } = await db.from('custom_object_relationship')
    .select('id').eq('tenant_id', tenantId).eq('relationship_definition_id', definition.id)
    .eq('source_record_id', sourceId).eq('target_record_id', targetId)
    .is('archived_at', null).maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return;
  const { error } = await db.from('custom_object_relationship').insert({
    tenant_id: tenantId,
    relationship_definition_id: definition.id,
    source_record_id: sourceId,
    target_record_id: targetId,
  });
  if (error && error.code !== '23505') throw error;
}

async function executeInvocation(
  db,
  tenantId,
  invocation,
  preferenceFields,
  claimedRecordId = null,
  relationshipDefinition = null,
  authorization = {},
) {
  const action = invocation.action;
  const entity = entityName(action);
  const operation = operationName(action);
  const payload = mappedPayload(invocation, entity, preferenceFields);
  delete payload.core.id;
  for (const mapping of actionMappings(action).filter(m => (m.target_type || (entity === 'custom_object' ? 'custom' : 'core')) === 'custom')) {
    const field = preferenceFields.get(String(targetField(mapping)));
    const ownsField = field
      && String(field.tenant_id) === String(tenantId)
      && field.entity_scope === entity
      && (entity !== 'custom_object' || String(field.custom_object_id) === String(actionObjectId(action)));
    if (!ownsField) throw new StructuredActionContractError(`Custom field ${targetField(mapping)} is not active for this action target`);
  }
  const references = [
    ['organization_id', 'organization'],
    ['organization_group_id', 'organization_group'],
    ['role_id', 'role'],
  ];
  for (const [column, table] of references) {
    const id = payload.core[column];
    if (!id) continue;
    const { data, error } = await db.from(table).select('id').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (error || !data) throw new StructuredActionContractError(`Mapped ${column} does not belong to this tenant`);
  }
  const actionWithSelectedRecord = invocation.selectedRecordId
    ? { ...action, target_record_id: invocation.selectedRecordId }
    : action;
  if (action.operation === 'update_selected' && !invocation.selectedRecordId) {
    return { status: 'failed', reason: 'relationship_selection_missing', error: 'A selected target record is required', entity_type: entity };
  }
  // A create reserves its target UUID in the ledger before writing. If a
  // previous attempt inserted it but crashed before finalizing the ledger,
  // recover that exact row and complete the same invocation.
  if (operation === 'create' && claimedRecordId) {
    let recoveredQuery = db.from(TABLES[entity]).select('*')
      .eq('tenant_id', tenantId).eq('id', claimedRecordId);
    if (entity === 'custom_object') {
      recoveredQuery = recoveredQuery.eq('custom_object_id', actionObjectId(action)).is('archived_at', null);
    }
    const { data: recovered, error: recoveredError } = await recoveredQuery.maybeSingle();
    if (recoveredError) throw recoveredError;
    if (recovered) {
      if (entity !== 'custom_object') {
        await writePreferences(db, tenantId, entity, recovered.id, payload.custom, preferenceFields, payload.clearCustom);
      }
      await ensureRelationshipLink(db, tenantId, invocation, recovered.id, relationshipDefinition, authorization);
      return { status: 'completed', record_id: recovered.id, operation: 'created', recovered: true, entity_type: entity };
    }
  }
  const existing = operation === 'create'
    ? null
    : await findExisting(db, tenantId, entity, actionWithSelectedRecord, payload);
  if (operation === 'update' && !existing) {
    return { status: 'failed', reason: 'record_not_found', error: 'The selected target record is unavailable', entity_type: entity };
  }
  if (operation === 'create' && existing) return { status: 'skipped', reason: 'record_already_exists', record_id: existing.id };
  if (existing) {
    assertStructuredMutationAuthorized({ action, recordId: existing.id, authorization });
  }
  let record;
  if (existing) {
    let update;
    if (entity === 'custom_object') {
      const objectFields = [...preferenceFields.values()].filter(field =>
        field.entity_scope === 'custom_object'
        && String(field.custom_object_id) === String(actionObjectId(action)));
      const existingDataForValidation = { ...(existing.data || {}) };
      for (const key of payload.clearCustom) delete existingDataForValidation[key];
      const validation = validateCustomObjectRecordData({
        data: payload.custom,
        fields: objectFields,
        existingData: existingDataForValidation,
        mode: 'update',
      });
      if (!validation.ok) {
        throw new StructuredActionContractError('Invalid Custom Object record data', validation.errors);
      }
      update = { data: validation.data, updated_at: new Date().toISOString() };
    } else {
      update = payload.core;
    }
    const { data, error } = await db.from(TABLES[entity]).update(update)
      .eq('tenant_id', tenantId).eq('id', existing.id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Tenant-scoped update matched no record');
    record = data;
  } else {
    if (entity === 'member' && !payload.core.email) throw new StructuredActionContractError('Member email is required');
    if ((entity === 'organization' || entity === 'organization_group') && !payload.core.name) throw new StructuredActionContractError(`${entity} name is required`);
    const reservedId = operation === 'create' && claimedRecordId ? { id: claimedRecordId } : {};
    if (entity === 'custom_object') {
      const objectFields = [...preferenceFields.values()].filter(field =>
        field.entity_scope === 'custom_object'
        && String(field.custom_object_id) === String(actionObjectId(action)));
      const validation = validateCustomObjectRecordData({
        data: payload.custom,
        fields: objectFields,
        mode: 'create',
      });
      if (!validation.ok) {
        throw new StructuredActionContractError('Invalid Custom Object record data', validation.errors);
      }
      payload.custom = validation.data;
    }
    const insert = entity === 'custom_object'
      ? { ...reservedId, tenant_id: tenantId, custom_object_id: actionObjectId(action), data: payload.custom }
      : { ...reservedId, tenant_id: tenantId, ...payload.core };
    const { data, error } = await db.from(TABLES[entity]).insert(insert).select('*').single();
    if (error) throw error;
    record = data;
  }
  if (entity !== 'custom_object') await writePreferences(db, tenantId, entity, record.id, payload.custom, preferenceFields, payload.clearCustom);
  await ensureRelationshipLink(db, tenantId, invocation, record.id, relationshipDefinition, authorization);
  return { status: 'completed', record_id: record.id, operation: existing ? 'updated' : 'created', entity_type: entity };
}

/**
 * Loads the persisted form and submission, validates them, and executes v1
 * structured actions. No action configuration or answers from the request are
 * trusted. A durable per-invocation ledger provides retry idempotency; notes
 * remain the administrator-facing outcome history.
 */
export async function processPersistedStructuredActions({
  db,
  formId,
  submissionId,
  tenantId,
  authorization = {},
}) {
  if (!formId || !submissionId) throw new StructuredActionContractError('form_id and submission_id are required');
  const [{ data: form, error: formError }, { data: submission, error: submissionError }] = await Promise.all([
    db.from('form').select('*').eq('id', formId).eq('tenant_id', tenantId).maybeSingle(),
    db.from('form_submission').select('*').eq('id', submissionId).eq('form_id', formId).eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (formError || !form) throw new StructuredActionContractError('Persisted form was not found in the tenant');
  if (submissionError || !submission) throw new StructuredActionContractError('Persisted submission was not found in the tenant');
  const contract = validateStructuredActionsContract(form.structured_actions, form.fields || []);
  if (!contract || contract.actions.length === 0) return null;
  const objectIds = [...new Set(contract.actions.map(actionObjectId).filter(Boolean))];
  if (objectIds.length) {
    const { data: objects, error } = await db.from('custom_object_definition').select('id')
      .eq('tenant_id', tenantId).eq('status', 'active').in('id', objectIds);
    if (error) throw error;
    const active = new Set((objects || []).map(row => String(row.id)));
    const missing = objectIds.filter(id => !active.has(String(id)));
    if (missing.length) throw new StructuredActionContractError('A structured action references an inactive or cross-tenant custom object', missing);
  }
  const relationshipIds = [...new Set(contract.actions.map(action => action.relationship_definition_id).filter(Boolean))];
  const relationshipDefinitionsById = new Map();
  if (relationshipIds.length) {
    const { data: definitions, error } = await db.from('custom_object_relationship_definition').select('*')
      .eq('tenant_id', tenantId).eq('status', 'active').in('id', relationshipIds);
    if (error) throw error;
    const byId = new Map((definitions || []).map(definition => [String(definition.id), definition]));
    for (const [id, definition] of byId) relationshipDefinitionsById.set(id, definition);
    for (const action of contract.actions.filter(item => item.relationship_definition_id)) {
      const definition = byId.get(String(action.relationship_definition_id));
      const kind = entityName(action);
      const objectId = actionObjectId(action);
      const compatible = definition && [
        [definition.source_kind, definition.source_custom_object_id],
        [definition.target_kind, definition.target_custom_object_id],
      ].some(([endpointKind, endpointObjectId]) =>
        endpointKind === kind && (kind !== 'custom_object' || String(endpointObjectId) === String(objectId)));
      if (!compatible) {
        throw new StructuredActionContractError(`Relationship ${action.relationship_definition_id} is inactive, cross-tenant, or incompatible with action ${action.id}`);
      }
    }
  }
  const visibilityOptions = rulesUseLmicOperators(form.visibility_rules)
    ? { lmicCodes: await loadTenantLmicCodes(db, tenantId) }
    : {};
  await validateDirectSelectors(db, tenantId, form, submission.submission_data || {}, visibilityOptions);
  const preferenceFields = await loadPreferenceFields(db, tenantId);
  validateRuntimeMappingCompatibility(contract, form.fields || [], preferenceFields);
  const invocations = expandStructuredActionInvocations(
    contract,
    form,
    submission.submission_data || {},
    visibilityOptions,
  );
  for (const invocation of invocations) invocation.formFields = form.fields || [];
  // Reject the whole run before any ledger claim or side effect when the
  // target class requires admin access or a selected update is outside the
  // caller's verified ownership.
  for (const invocation of invocations) {
    assertStructuredMutationAuthorized({
      action: invocation.action,
      recordId: invocation.action.operation === 'update_selected'
        ? invocation.selectedRecordId
        : null,
      authorization,
    });
    const relationshipDefinition = relationshipDefinitionsById.get(
      String(invocation.action.relationship_definition_id),
    );
    const relationshipContext = relationshipLinkContext(invocation, relationshipDefinition);
    if (relationshipContext) {
      assertStructuredRelationshipParentAuthorized({
        parentDescriptor: relationshipContext.parentDescriptor,
        parentId: relationshipContext.parentId,
        authorization,
      });
    }
  }
  const notes = noteArray(submission.processing_notes);
  const completed = new Map(notes
    .filter(n => n?.kind === 'structured_action' && n?.status === 'completed' && n?.invocation_key)
    .map(n => [n.invocation_key, n]));
  const outcomes = [];
  for (const invocation of invocations) {
    const prior = completed.get(invocation.invocationKey);
    if (prior) {
      outcomes.push({
        invocation_key: invocation.invocationKey,
        action_id: invocation.action.id,
        row_index: invocation.rowIndex,
        status: 'already_completed',
        record_id: prior.record_id || null,
        entity_type: prior.entity_type || entityName(invocation.action),
      });
      continue;
    }
    const rowIdentity = invocation.rowId || 'top';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      version: contract.version, action: invocation.action, values: invocation.values,
    })).digest('hex');
    let claimedRecordId = null;
    if (typeof db.rpc === 'function') {
      const { data: claim, error: claimError } = await db.rpc('claim_form_structured_action', {
        p_tenant_id: tenantId, p_submission_id: submissionId, p_action_id: invocation.action.id,
        p_row_identity: rowIdentity, p_fingerprint: fingerprint,
      });
      if (claimError) throw claimError;
      const ledger = Array.isArray(claim) ? claim[0] : claim;
      claimedRecordId = ledger?.record_id || null;
      invocation.claimToken = ledger?.claim_token || null;
      if (ledger?.status === 'completed') {
        const alreadyCompleted = { invocation_key: invocation.invocationKey, action_id: invocation.action.id, row_identity: rowIdentity,
          status: 'already_completed', record_id: ledger.record_id || null, entity_type: entityName(invocation.action) };
        outcomes.push(alreadyCompleted);
        notes.push({ at: new Date().toISOString(), kind: 'structured_action', ...alreadyCompleted });
        continue;
      }
      if (ledger && ledger.claimed === false) {
        outcomes.push({ invocation_key: invocation.invocationKey, action_id: invocation.action.id, row_identity: rowIdentity,
          status: 'skipped', reason: 'already_running', entity_type: entityName(invocation.action) });
        continue;
      }
    }
    let outcome;
    try {
      outcome = await executeInvocation(
        db,
        tenantId,
        invocation,
        preferenceFields,
        claimedRecordId,
        relationshipDefinitionsById.get(String(invocation.action.relationship_definition_id)) || null,
        authorization,
      );
    } catch (error) {
      outcome = { status: 'failed', error: error.message || String(error), ...(error?.code ? { code: error.code } : {}) };
    }
    outcome = { invocation_key: invocation.invocationKey, action_id: invocation.action.id, row_index: invocation.rowIndex, ...outcome };
    outcomes.push(outcome);
    if (typeof db.rpc === 'function') {
      const { error } = await db.rpc('finalize_form_structured_action', {
        p_tenant_id: tenantId, p_submission_id: submissionId, p_action_id: invocation.action.id,
        p_row_identity: rowIdentity, p_status: outcome.status === 'completed' ? 'completed' : 'failed',
        p_record_id: outcome.record_id || null, p_outcome: outcome,
        p_claim_token: invocation.claimToken,
      });
      if (error) throw error;
    }
    notes.push({ at: new Date().toISOString(), kind: 'structured_action', ...outcome });
  }
  const { error: noteError } = await db.from('form_submission').update({ processing_notes: notes })
    .eq('id', submissionId).eq('tenant_id', tenantId);
  if (noteError) throw noteError;
  const completedOutcomes = outcomes.filter(o => ['completed', 'already_completed'].includes(o.status));
  const failed = outcomes.filter(o => o.status === 'failed');
  const skipped = outcomes.filter(o => o.status === 'skipped');
  const firstMember = outcomes.find(o => o.entity_type === 'member' && o.record_id);
  const firstOrganization = outcomes.find(o => o.entity_type === 'organization' && o.record_id);
  return {
    success: failed.length === 0,
    partial: failed.length > 0 && completedOutcomes.length > 0,
    structured_actions_version: contract.version,
    outcomes,
    completed_count: completedOutcomes.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    created_member_id: firstMember?.record_id || null,
    created_organization_id: firstOrganization?.record_id || null,
    organization_id: firstOrganization?.record_id || null,
  };
}