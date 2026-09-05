import { coerceBooleanPreferenceValue } from './booleanCoercion.js';
import { COUNTRIES } from '../../shared/countries.js';

export const CUSTOM_OBJECT_LIFECYCLE_STATES = Object.freeze(['draft', 'active', 'archived']);
export const CUSTOM_OBJECT_RELATIONSHIP_CARDINALITIES = Object.freeze([
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
]);
export const CUSTOM_OBJECT_ENDPOINT_KINDS = Object.freeze([
  'member',
  'organization',
  'organization_group',
  'custom_object',
]);
export const CUSTOM_OBJECT_FIELD_TYPES = Object.freeze([
  'text',
  'textarea',
  'email',
  'url',
  'date',
  'boolean',
  'number',
  'decimal',
  'picklist',
  'dropdown',
  'country',
  'countries',
  'list',
  'file',
]);
export const CUSTOM_OBJECT_CAPABILITIES = Object.freeze([
  'view_records',
  'create_records',
  'edit_records',
  'archive_records',
  'export_records',
]);
export const CUSTOM_OBJECT_AUDIT_ENTITY_TYPES = Object.freeze([
  'custom_object_definition',
  'preference_field',
  'custom_object_record',
  'custom_object_relationship_definition',
  'custom_object_relationship',
  'custom_object_role_permission',
  'custom_object_field_role_permission',
]);
export const CUSTOM_OBJECT_FIELD_ACCESS_LEVELS = Object.freeze(['none', 'read', 'edit']);
export const CUSTOM_OBJECT_PRESENTATION_VERSION = 2;
export const CUSTOM_OBJECT_VISIBILITY_OPERATORS = Object.freeze([
  'equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'not_empty',
  'is_not_empty', 'greater_than', 'less_than',
]);

const INTERNAL_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_2_COUNTRY_CODES = new Set(COUNTRIES.map(({ code }) => code));
const FILE_TYPE_EXTENSIONS = Object.freeze({
  pdf: ['.pdf'],
  word: ['.doc', '.docx'],
  excel: ['.xls', '.xlsx', '.csv'],
  powerpoint: ['.ppt', '.pptx'],
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
  text: ['.txt', '.rtf'],
  zip: ['.zip', '.rar', '.7z'],
  video: ['.mp4', '.mov', '.avi', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg'],
});

export class CustomObjectDomainError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CustomObjectDomainError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuredFieldIds(value, label, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    errors.push(`${label} must be an array of field ids`);
    return [];
  }
  if (new Set(value).size !== value.length) errors.push(`${label} cannot contain duplicate fields`);
  return value;
}

function presentationFieldId(element) {
  return element?.field_id ?? element?.fieldId ?? null;
}

function presentationRelationshipId(element) {
  return element?.relationship_definition_id ?? element?.definitionId ?? null;
}

function rawPresentationFieldId(value) {
  return String(value || '').replace(/^(field|custom):/, '');
}

function presentationRules(detail) {
  const value = detail?.visibility_rules ?? detail?.visibilityRules ?? detail?.rules;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value?.rules;
}

function validateVisibilityRules(detail, fieldIds, elementIds, cardIds, errors) {
  const rules = presentationRules(detail);
  if (rules === undefined) {
    errors.push('views.detail.visibility_rules must be an array or an object containing rules');
    return;
  }
  const ruleIds = new Set();
  (rules || []).forEach((rule, ruleIndex) => {
    const label = `views.detail.visibility_rules[${ruleIndex}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (typeof rule.id !== 'string' || !rule.id.trim() || ruleIds.has(rule.id)) {
      errors.push(`${label}.id must be a unique non-empty string`);
    } else ruleIds.add(rule.id);
    if (rule.logic !== undefined && !['and', 'or'].includes(rule.logic)) {
      errors.push(`${label}.logic must be and or or`);
    }
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
      errors.push(`${label}.conditions must be a non-empty array`);
    } else rule.conditions.forEach((condition, conditionIndex) => {
      const conditionLabel = `${label}.conditions[${conditionIndex}]`;
      const fieldId = condition?.field_id ?? condition?.fieldId;
      if (!isPlainObject(condition) || typeof fieldId !== 'string'
        || !fieldIds.has(rawPresentationFieldId(fieldId))) {
        errors.push(`${conditionLabel}.field_id must reference an active field`);
      }
      if (!CUSTOM_OBJECT_VISIBILITY_OPERATORS.includes(condition?.operator)) {
        errors.push(`${conditionLabel}.operator is invalid`);
      }
    });
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      errors.push(`${label}.actions must be a non-empty array`);
    } else rule.actions.forEach((action, actionIndex) => {
      const actionLabel = `${label}.actions[${actionIndex}]`;
      if (!isPlainObject(action) || !['show', 'hide', 'lock', 'unlock'].includes(action?.action_type ?? action?.actionType)) {
        errors.push(`${actionLabel}.action_type is invalid`);
        return;
      }
      const targetType = action.target_type ?? action.targetType;
      const targetId = targetType === 'card'
        ? (action.target_card_id ?? action.targetCardId)
        : (action.target_field_id ?? action.targetFieldId);
      const available = targetType === 'card' ? cardIds : elementIds;
      if (!['card', 'field', 'relationship'].includes(targetType) || !available.has(targetId)) {
        errors.push(`${actionLabel} must reference an available card, field, or relationship`);
      }
      if (targetType === 'relationship' && ['lock', 'unlock'].includes(action.action_type ?? action.actionType)) {
        errors.push(`${actionLabel} cannot lock or unlock a relationship`);
      }
    });
  });
}

// Validates the versioned CRM detail contract. The original sections contract
// remains accepted below so existing object presentation metadata is unchanged.
export function validateCustomObjectPresentationConfiguration(
  configuration = {},
  fields = [],
  relationships = [],
  objectId = null,
) {
  const errors = [];
  if (!isPlainObject(configuration)) return { ok: false, errors: ['Object configuration must be an object'] };
  const detail = configuration.views?.detail;
  if (detail === undefined || detail.version === undefined) return { ok: true, errors };
  if (detail.version !== CUSTOM_OBJECT_PRESENTATION_VERSION) {
    return { ok: false, errors: [`views.detail.version must be ${CUSTOM_OBJECT_PRESENTATION_VERSION}`] };
  }
  if (!Array.isArray(detail.cards)) return { ok: false, errors: ['views.detail.cards must be an array'] };

  const activeFieldIds = new Set((fields || [])
    .filter((item) => getCustomObjectFieldMetadata(item).active)
    .map((item) => String(item.id)));
  const schemaFieldIds = configuredFieldIds(
    detail.schema_field_ids,
    'views.detail.schema_field_ids',
    errors,
  );
  for (const fieldId of schemaFieldIds) {
    if (!activeFieldIds.has(String(fieldId))) {
      errors.push('views.detail.schema_field_ids includes an unknown or archived field');
    }
  }
  const relationshipsById = new Map((relationships || []).map((item) => [String(item.id), item]));
  const cardIds = new Set();
  const elementIds = new Set();
  const referencedFieldIds = new Set();
  for (const [cardIndex, card] of detail.cards.entries()) {
    const label = `views.detail.cards[${cardIndex}]`;
    if (!isPlainObject(card)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof card.id !== 'string' || !card.id.trim() || cardIds.has(card.id)) {
      errors.push(`${label}.id must be a unique non-empty string`);
    } else cardIds.add(card.id);
    if (typeof card.title !== 'string') errors.push(`${label}.title must be a string`);
    if (!Number.isInteger(card.columns) || card.columns < 1 || card.columns > 3) {
      errors.push(`${label}.columns must be an integer from 1 to 3`);
    }
    if (!Array.isArray(card.fields)) {
      errors.push(`${label}.fields must be an array`);
      continue;
    }
    card.fields.forEach((element, elementIndex) => {
      const elementLabel = `${label}.fields[${elementIndex}]`;
      if (!isPlainObject(element) || typeof element.id !== 'string' || !element.id.trim()) {
        errors.push(`${elementLabel}.id must be a non-empty string`);
        return;
      }
      if (elementIds.has(element.id)) errors.push(`${elementLabel}.id must be unique across the layout`);
      else elementIds.add(element.id);
      if (!Number.isInteger(element.columnIndex) || element.columnIndex < 0 || element.columnIndex >= card.columns) {
        errors.push(`${elementLabel}.columnIndex must identify a card column`);
      }
      if (element.type === 'field' || element.type === 'custom') {
      const fieldId = rawPresentationFieldId(presentationFieldId(element));
        if (!activeFieldIds.has(fieldId)) errors.push(`${elementLabel} references an unknown or archived field`);
        if (referencedFieldIds.has(fieldId)) errors.push(`${elementLabel} duplicates a field`);
        referencedFieldIds.add(fieldId);
        if (![ `field:${fieldId}`, `custom:${fieldId}` ].includes(element.id)) {
          errors.push(`${elementLabel}.id must be derived from its stable field id`);
        }
      } else if (element.type === 'relationship') {
        const definitionId = String(presentationRelationshipId(element) || '');
        const relationship = relationshipsById.get(definitionId);
        const side = element.side;
        if (!relationship || !['source', 'target'].includes(side)
          || relationship.status !== 'active'
          || relationship[`${side}_kind`] !== 'custom_object'
          || (objectId && relationship[`${side}_custom_object_id`] !== objectId)
          || relationship[`show_on_${side}`] === false) {
          errors.push(`${elementLabel} references an unavailable relationship side`);
        }
        if (element.id !== `relationship:${definitionId}:${side}`) {
          errors.push(`${elementLabel}.id must be derived from its stable relationship definition and side`);
        }
      } else errors.push(`${elementLabel}.type must be field or relationship`);
    });
  }
  validateVisibilityRules(detail, activeFieldIds, elementIds, cardIds, errors);
  return { ok: errors.length === 0, errors };
}

export function reconcileCustomObjectPresentationConfiguration(
  configuration = {},
  fields = [],
  relationships = [],
  objectId = null,
) {
  const output = isPlainObject(configuration) ? structuredClone(configuration) : {};
  const detail = output.views?.detail;
  if (!isPlainObject(detail) || detail.version !== CUSTOM_OBJECT_PRESENTATION_VERSION
    || !Array.isArray(detail.cards)) return output;
  const activeFields = (fields || []).filter((item) => getCustomObjectFieldMetadata(item).active);
  const fieldIds = new Set(activeFields.map((item) => String(item.id)));
  const knownFieldIds = new Set(
    (Array.isArray(detail.schema_field_ids) ? detail.schema_field_ids : [])
      .map((item) => rawPresentationFieldId(item)),
  );
  detail.schema_field_ids = activeFields.map((item) => String(item.id));
  const relationshipsById = new Map((relationships || []).map((item) => [String(item.id), item]));
  const retainedIds = new Set();
  detail.cards = detail.cards.map((card) => ({
    ...card,
    fields: (Array.isArray(card.fields) ? card.fields : []).filter((element) => {
      let available = false;
      if (element?.type === 'field' || element?.type === 'custom') {
        available = fieldIds.has(rawPresentationFieldId(presentationFieldId(element)));
      } else if (element?.type === 'relationship') {
        const relationship = relationshipsById.get(String(presentationRelationshipId(element) || ''));
        available = Boolean(relationship && ['source', 'target'].includes(element.side)
          && relationship.status === 'active'
          && relationship[`${element.side}_kind`] === 'custom_object'
          && (!objectId || relationship[`${element.side}_custom_object_id`] === objectId)
          && relationship[`show_on_${element.side}`] !== false);
      }
      if (available) retainedIds.add(element.id);
      return available;
    }),
  }));
  const placedFieldIds = new Set(detail.cards.flatMap((card) => card.fields)
    .filter((element) => element.type === 'field' || element.type === 'custom')
    .map((element) => rawPresentationFieldId(presentationFieldId(element))));
  const newlyAddedFields = activeFields.filter((item) => {
    const fieldId = String(item.id);
    return !placedFieldIds.has(fieldId) && !knownFieldIds.has(fieldId);
  });
  if (newlyAddedFields.length > 0) {
    let card = detail.cards.find((item) => item.id === 'card-fields');
    if (!card) {
      card = { id: 'card-fields', title: 'Details', columns: 2, fields: [] };
      detail.cards.push(card);
    }
    for (const item of newlyAddedFields) {
      const fieldId = String(item.id);
      const id = `field:${fieldId}`;
      card.fields.push({ id, type: 'field', field_id: fieldId, columnIndex: card.fields.length % card.columns });
      retainedIds.add(id);
    }
  }
  const cardIds = new Set(detail.cards.map((card) => card.id));
  const rawRules = presentationRules(detail);
  const reconciledRules = (Array.isArray(rawRules) ? rawRules : []).map((rule) => ({
    ...rule,
    conditions: (rule.conditions || []).filter((condition) =>
      fieldIds.has(rawPresentationFieldId(condition.field_id ?? condition.fieldId))),
    actions: (rule.actions || []).filter((action) => {
      const targetType = action.target_type ?? action.targetType;
      const id = targetType === 'card'
        ? (action.target_card_id ?? action.targetCardId)
        : (action.target_field_id ?? action.targetFieldId);
      return targetType === 'card' ? cardIds.has(id) : retainedIds.has(id);
    }),
  })).filter((rule) => rule.conditions.length > 0 && rule.actions.length > 0);
  if (detail.visibility_rules !== undefined) {
    detail.visibility_rules = Array.isArray(detail.visibility_rules)
      ? reconciledRules : { ...detail.visibility_rules, rules: reconciledRules };
  } else if (detail.visibilityRules !== undefined) {
    detail.visibilityRules = Array.isArray(detail.visibilityRules)
      ? reconciledRules : { ...detail.visibilityRules, rules: reconciledRules };
  } else if (detail.rules !== undefined) {
    detail.rules = Array.isArray(detail.rules)
      ? reconciledRules : { ...detail.rules, rules: reconciledRules };
  }
  return output;
}

// Shared presentation is deliberately metadata only: consumers may choose their
// own rendering, but cannot accidentally configure fields outside this object.
export function validateCustomObjectViewConfiguration(configuration = {}, fields = []) {
  const errors = [];
  if (!isPlainObject(configuration)) return { ok: false, errors: ['Object configuration must be an object'] };
  const views = configuration.views;
  if (views === undefined) return { ok: true, errors: [] };
  if (!isPlainObject(views)) return { ok: false, errors: ['views must be an object'] };
  const activeIds = new Set((fields || []).filter((field) => getCustomObjectFieldMetadata(field).active)
    .map((field) => String(field.id)));
  const validateIds = (ids, label) => {
    for (const id of ids) if (!activeIds.has(id)) errors.push(`${label} includes an unknown or archived field`);
  };
  if (views.list !== undefined) {
    if (!isPlainObject(views.list)) errors.push('views.list must be an object');
    else validateIds(configuredFieldIds(views.list.field_ids ?? views.list.default_field_ids, 'views.list.field_ids', errors), 'views.list.field_ids');
  }
  if (views.detail !== undefined) {
    if (isPlainObject(views.detail) && views.detail.version !== undefined) {
      // The relationship-aware portion is validated by the service once it has
      // loaded the complete object-scoped relationship inventory.
      errors.push(...validateCustomObjectPresentationConfiguration(configuration, fields).errors
        .filter((error) => !error.includes('unavailable relationship side')));
    } else if (!isPlainObject(views.detail) || !Array.isArray(views.detail.sections)) errors.push('views.detail.sections must be an array');
    else views.detail.sections.forEach((section, index) => {
      if (!isPlainObject(section)) errors.push(`views.detail.sections[${index}] must be an object`);
      else validateIds(configuredFieldIds(section.field_ids ?? section.fields, `views.detail.sections[${index}].field_ids`, errors), `views.detail.sections[${index}].field_ids`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function validateCustomObjectRelationshipPreviewConfiguration(
  configuration = {},
  fieldsBySide = {},
  relationshipsBySide = {},
  objectIdsBySide = {},
) {
  const errors = [];
  if (!isPlainObject(configuration)) return { ok: false, errors: ['Relationship configuration must be an object'] };
  const currentPreview = configuration.compact_preview;
  const legacyPreview = configuration.compact_preview_fields;
  if (currentPreview === undefined && legacyPreview === undefined) return { ok: true, errors: [] };
  if (currentPreview !== undefined && !isPlainObject(currentPreview)) errors.push('compact_preview must be an object');
  if (legacyPreview !== undefined && !isPlainObject(legacyPreview)) errors.push('compact_preview_fields must be an object');
  if (errors.length) return { ok: false, errors };
  const preview = currentPreview ?? legacyPreview ?? {};
  for (const side of ['source', 'target']) {
    const ids = [
      ...configuredFieldIds(currentPreview?.[`${side}_field_ids`] ?? currentPreview?.[side], `compact_preview.${side}`, errors),
      ...configuredFieldIds(legacyPreview?.[`${side}_field_ids`] ?? legacyPreview?.[side], `compact_preview_fields.${side}`, errors),
    ];
    const activeIds = new Set((fieldsBySide[side] || []).filter((field) => getCustomObjectFieldMetadata(field).active)
      .map((field) => String(field.id)));
    for (const id of ids) if (!activeIds.has(id)) errors.push(`compact_preview.${side} includes an unknown or archived field`);
    const columns = preview[`${side}_columns`];
    if (columns === undefined) continue;
    if (!Array.isArray(columns)) {
      errors.push(`compact_preview.${side}_columns must be an array`);
      continue;
    }
    const eligibleRelationships = new Map((relationshipsBySide[side] || [])
      .filter((item) => item?.status === 'active')
      .map((item) => [String(item.id), item]));
    const seen = new Set();
    columns.forEach((column, index) => {
      const label = `compact_preview.${side}_columns[${index}]`;
      if (!isPlainObject(column)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (!String(column.label || '').trim()) errors.push(`${label}.label is required`);
      if (column.type === 'field') {
        const fieldId = String(column.field_id || '');
        if (!activeIds.has(fieldId)) errors.push(`${label} includes an unknown or archived field`);
        if (seen.has(`field:${fieldId}`)) errors.push(`${label} is duplicated`);
        seen.add(`field:${fieldId}`);
        return;
      }
      if (column.type === 'relationship') {
        const relationshipId = String(column.relationship_definition_id || '');
        const relationship = eligibleRelationships.get(relationshipId);
        const relationshipSide = column.side;
        if (
          !relationship
          || !['source', 'target'].includes(relationshipSide)
          || relationship[`${relationshipSide}_kind`] !== 'custom_object'
          || String(relationship[`${relationshipSide}_custom_object_id`] || '')
            !== String(objectIdsBySide[side] || '')
        ) {
          errors.push(`${label} includes an unavailable relationship`);
        }
        if (seen.has(`relationship:${relationshipId}:${column.side}`)) errors.push(`${label} is duplicated`);
        seen.add(`relationship:${relationshipId}:${column.side}`);
        return;
      }
      errors.push(`${label}.type must be field or relationship`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function resolveCustomObjectFieldAccess({ permission = null, isTenantAdmin = false } = {}) {
  if (isTenantAdmin) return 'edit';
  // No row is the compatibility contract for objects created before field ACLs.
  if (!permission) return 'edit';
  const access = permission.access_level ?? permission.access;
  return CUSTOM_OBJECT_FIELD_ACCESS_LEVELS.includes(access) ? access : 'none';
}

export function projectCustomObjectRecordData({ data, fields, accessByFieldId = new Map() }) {
  // Keep truly unknown historic keys. A known field is always governed by its
  // ACL, including a definition that has since been archived.
  const output = isPlainObject(data) ? structuredClone(data) : {};
  for (const field of fields || []) {
    const metadata = getCustomObjectFieldMetadata(field);
    if (accessByFieldId.get(String(field.id)) === 'none') delete output[metadata.key];
  }
  return output;
}

function isBlank(value) {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('[')) return [value];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normaliseOption(option) {
  if (typeof option === 'string') return { value: option, label: option };
  if (!isPlainObject(option) || option.value === undefined || option.value === null) return null;
  const value = String(option.value);
  return {
    value,
    label: option.label === undefined || option.label === null ? value : String(option.label),
  };
}

export function getCustomObjectFieldMetadata(field) {
  const options = Array.isArray(field?.options)
    ? field.options.map(normaliseOption).filter(Boolean)
    : [];
  const selectedCountries = Array.isArray(field?.selected_countries)
    ? field.selected_countries.map(String)
    : parseJsonArray(field?.selected_countries)?.map(String) || [];
  const allowedFileTypes = Array.isArray(field?.allowed_file_types)
    ? field.allowed_file_types.map(String)
    : parseJsonArray(field?.allowed_file_types)?.map(String) || [];
  const defaultCountries = Array.isArray(field?.default_countries)
    ? field.default_countries.map(String)
    : parseJsonArray(field?.default_countries)?.map(String) || [];

  return {
    id: field?.id || null,
    customObjectId: field?.custom_object_id || null,
    key: field?.name || '',
    label: field?.label || field?.name || '',
    type: field?.field_type || '',
    required: field?.is_required === true,
    active: field?.is_active !== false,
    options,
    minSelections: Number.isInteger(field?.min_selections) ? field.min_selections : null,
    maxSelections: Number.isInteger(field?.max_selections) ? field.max_selections : null,
    minLength: Number.isInteger(field?.min_length) ? field.min_length : null,
    maxLength: Number.isInteger(field?.max_length) ? field.max_length : null,
    allCountries: field?.all_countries !== false,
    selectedCountries,
    defaultCountry: field?.default_country ? String(field.default_country) : null,
    defaultCountries,
    allowedFileTypes,
    publicAccess: field?.public_access === true,
  };
}

export function validateCustomObjectFieldDefinition(field, expected = {}) {
  const metadata = getCustomObjectFieldMetadata(field);
  const errors = [];

  if (field?.entity_scope !== 'custom_object') {
    errors.push('Custom Object fields must use the custom_object entity scope');
  }
  if (!metadata.customObjectId) errors.push('Custom Object fields must belong to an object');
  if (expected.tenantId && field?.tenant_id !== expected.tenantId) {
    errors.push('Field belongs to a different tenant');
  }
  if (expected.customObjectId && metadata.customObjectId !== expected.customObjectId) {
    errors.push('Field belongs to a different Custom Object');
  }
  if (!INTERNAL_KEY_RE.test(metadata.key)) {
    errors.push('Field internal key must use lowercase letters, numbers, and underscores');
  }
  if (!CUSTOM_OBJECT_FIELD_TYPES.includes(metadata.type)) {
    errors.push(`Unsupported field type: ${metadata.type || '(empty)'}`);
  }
  if (['picklist', 'dropdown'].includes(metadata.type) && metadata.options.length === 0) {
    errors.push(`${metadata.label || 'Field'} must define at least one option`);
  }
  if (metadata.minSelections !== null && metadata.minSelections < 0) {
    errors.push('Minimum selections cannot be negative');
  }
  if (
    metadata.minSelections !== null
    && metadata.maxSelections !== null
    && metadata.minSelections > metadata.maxSelections
  ) {
    errors.push('Minimum selections cannot exceed maximum selections');
  }
  if (
    metadata.minLength !== null
    && metadata.maxLength !== null
    && metadata.minLength > metadata.maxLength
  ) {
    errors.push('Minimum length cannot exceed maximum length');
  }
  if (metadata.type === 'file' && metadata.allowedFileTypes.length === 0) {
    errors.push('File fields must allow at least one file type');
  }
  if (
    ['country', 'countries'].includes(metadata.type)
    && !metadata.allCountries
    && metadata.selectedCountries.length === 0
  ) {
    errors.push('Restricted country fields must allow at least one country');
  }
  const availableCountries = metadata.allCountries
    ? null
    : new Set(metadata.selectedCountries);
  if (
    metadata.type === 'country'
    && metadata.defaultCountry
    && availableCountries
    && !availableCountries.has(metadata.defaultCountry)
  ) {
    errors.push('The default country must be one of the available countries');
  }
  if (
    metadata.type === 'countries'
    && availableCountries
    && metadata.defaultCountries.some((country) => !availableCountries.has(country))
  ) {
    errors.push('Default countries must be selected from the available countries');
  }

  return { ok: errors.length === 0, metadata, errors };
}

export function assertImmutableInternalKey(previous, next, label = 'Internal key') {
  if (previous !== next) {
    throw new CustomObjectDomainError(
      'IMMUTABLE_INTERNAL_KEY',
      `${label} cannot be changed after creation`,
    );
  }
  return next;
}

export function assertTenantOwnership(tenantId, ...resources) {
  if (!tenantId) {
    throw new CustomObjectDomainError('TENANT_REQUIRED', 'Tenant context is required');
  }
  for (const resource of resources.flat().filter(Boolean)) {
    if (resource.tenant_id !== tenantId) {
      throw new CustomObjectDomainError(
        'CROSS_TENANT_REFERENCE',
        'Referenced data belongs to a different tenant',
      );
    }
  }
  return true;
}

function validateTextLength(value, metadata) {
  if (metadata.minLength !== null && value.length < metadata.minLength) {
    return `must contain at least ${metadata.minLength} characters`;
  }
  if (metadata.maxLength !== null && value.length > metadata.maxLength) {
    return `must contain no more than ${metadata.maxLength} characters`;
  }
  return null;
}

function validateSelectionCount(values, metadata) {
  if (metadata.minSelections !== null && values.length < metadata.minSelections) {
    return `must contain at least ${metadata.minSelections} selections`;
  }
  if (metadata.maxSelections !== null && values.length > metadata.maxSelections) {
    return `must contain no more than ${metadata.maxSelections} selections`;
  }
  return null;
}

function coerceFileValue(value, metadata) {
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => (
    typeof item !== 'string'
    && !(isPlainObject(item) && ['name', 'url', 'path'].some((key) => typeof item[key] === 'string'))
  ))) {
    return { error: 'must be a file reference or an array of file references' };
  }

  const allowedExtensions = metadata.allowedFileTypes.flatMap(
    (type) => FILE_TYPE_EXTENSIONS[type] || [],
  );
  if (allowedExtensions.length > 0) {
    for (const item of values) {
      const name = typeof item === 'string' ? item : (item.name || item.url || item.path || '');
      const pathname = name.split(/[?#]/, 1)[0].toLowerCase();
      if (!allowedExtensions.some((extension) => pathname.endsWith(extension))) {
        return { error: 'contains a file type that is not allowed' };
      }
    }
  }
  return { value: Array.isArray(value) ? values : values[0] };
}

export function coerceCustomObjectFieldValue(value, field) {
  const metadata = getCustomObjectFieldMetadata(field);
  if (!CUSTOM_OBJECT_FIELD_TYPES.includes(metadata.type)) {
    return { ok: false, error: `uses unsupported field type ${metadata.type || '(empty)'}` };
  }
  if (isBlank(value)) return { ok: true, value: null };

  if (metadata.type === 'boolean') {
    const canonical = coerceBooleanPreferenceValue(value);
    return canonical === null
      ? { ok: false, error: 'must be a Yes/No value' }
      : { ok: true, value: canonical === 'true' };
  }

  if (metadata.type === 'number' || metadata.type === 'decimal') {
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric)) return { ok: false, error: 'must be a finite number' };
    if (metadata.type === 'number' && !Number.isInteger(numeric)) {
      return { ok: false, error: 'must be a whole number' };
    }
    return { ok: true, value: numeric };
  }

  if (['picklist', 'countries', 'list'].includes(metadata.type)) {
    const parsed = parseJsonArray(value);
    if (!parsed) return { ok: false, error: 'must be a list of values' };
    const values = parsed.map((entry) => (
      isPlainObject(entry) && entry.value !== undefined ? String(entry.value) : String(entry)
    ));
    const countError = validateSelectionCount(values, metadata);
    if (countError) return { ok: false, error: countError };
    if (metadata.type === 'picklist' && metadata.options.length > 0) {
      const allowed = new Set(metadata.options.map((option) => option.value));
      if (values.some((entry) => !allowed.has(entry))) {
        return { ok: false, error: 'contains an option that is not allowed' };
      }
    }
    if (
      metadata.type === 'countries'
      && values.some((entry) => !ISO_2_COUNTRY_CODES.has(entry))
    ) {
      return { ok: false, error: 'must contain only valid ISO-2 country codes' };
    }
    if (
      metadata.type === 'countries'
      && !metadata.allCountries
      && values.some((entry) => !metadata.selectedCountries.includes(entry))
    ) {
      return { ok: false, error: 'contains a country that is not allowed' };
    }
    return { ok: true, value: values };
  }

  if (metadata.type === 'file') {
    const fileResult = coerceFileValue(value, metadata);
    return fileResult.error
      ? { ok: false, error: fileResult.error }
      : { ok: true, value: fileResult.value };
  }

  const stringValue = isPlainObject(value) && value.value !== undefined
    ? String(value.value).trim()
    : String(value).trim();
  const lengthError = validateTextLength(stringValue, metadata);
  if (lengthError) return { ok: false, error: lengthError };

  if (metadata.type === 'email' && !EMAIL_RE.test(stringValue)) {
    return { ok: false, error: 'must be a valid email address' };
  }
  if (metadata.type === 'url') {
    try {
      const url = new URL(stringValue);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    } catch {
      return { ok: false, error: 'must be a valid HTTP or HTTPS URL' };
    }
  }
  if (metadata.type === 'date') {
    const parsed = new Date(`${stringValue}T00:00:00.000Z`);
    if (!DATE_RE.test(stringValue) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== stringValue) {
      return { ok: false, error: 'must be a valid date in YYYY-MM-DD format' };
    }
  }
  if (metadata.type === 'dropdown' && metadata.options.length > 0) {
    const allowed = new Set(metadata.options.map((option) => option.value));
    if (!allowed.has(stringValue)) return { ok: false, error: 'must use an allowed option' };
  }
  if (
    metadata.type === 'country'
    && !ISO_2_COUNTRY_CODES.has(stringValue)
  ) {
    return { ok: false, error: 'must use a valid ISO-2 country code' };
  }
  if (
    metadata.type === 'country'
    && !metadata.allCountries
    && !metadata.selectedCountries.includes(stringValue)
  ) {
    return { ok: false, error: 'must use an allowed country' };
  }

  return { ok: true, value: stringValue };
}

export function validateCustomObjectRecordData({
  data,
  fields,
  existingData = null,
  mode = 'create',
}) {
  if (!isPlainObject(data)) {
    return { ok: false, data: null, errors: [{ field: null, message: 'Record data must be an object' }] };
  }
  if (!['create', 'update', 'read'].includes(mode)) {
    throw new CustomObjectDomainError('INVALID_VALIDATION_MODE', `Unknown validation mode: ${mode}`);
  }

  const definitions = (fields || []).map((field) => ({
    field,
    validation: validateCustomObjectFieldDefinition(field),
  }));
  const definitionErrors = definitions.flatMap(({ validation }) => validation.errors);
  if (definitionErrors.length > 0) {
    return {
      ok: false,
      data: null,
      errors: definitionErrors.map((message) => ({ field: null, message })),
    };
  }

  const activeFields = definitions.filter(({ validation }) => validation.metadata.active);
  const byKey = new Map(activeFields.map(({ field, validation }) => [validation.metadata.key, { field, metadata: validation.metadata }]));
  const output = isPlainObject(existingData) ? structuredClone(existingData) : {};
  const errors = [];

  for (const [key, rawValue] of Object.entries(data)) {
    const definition = byKey.get(key);
    if (!definition) {
      if (mode === 'read') {
        output[key] = structuredClone(rawValue);
      } else {
        errors.push({ field: key, message: 'Field is unknown or archived' });
      }
      continue;
    }
    const result = coerceCustomObjectFieldValue(rawValue, definition.field);
    if (!result.ok) {
      errors.push({ field: key, message: `${definition.metadata.label} ${result.error}` });
    } else {
      output[key] = result.value;
    }
  }

  if (mode !== 'read') {
    for (const { metadata } of activeFields.map(({ validation }) => validation)) {
      const requiredApplies = mode === 'create'
        || Object.hasOwn(data, metadata.key)
        || (isPlainObject(existingData) && Object.hasOwn(existingData, metadata.key));
      if (metadata.required && requiredApplies && isBlank(output[metadata.key])) {
        errors.push({ field: metadata.key, message: `${metadata.label} is required` });
      }
    }
  }

  return { ok: errors.length === 0, data: errors.length === 0 ? output : null, errors };
}

export function resolveCustomObjectDisplayValue({ objectDefinition, record, fields }) {
  if (!objectDefinition?.primary_display_field_id) return record?.id || '';
  const field = (fields || []).find(
    (candidate) => candidate.id === objectDefinition.primary_display_field_id,
  );
  if (!field) return record?.id || '';
  const metadata = getCustomObjectFieldMetadata(field);
  const value = record?.data?.[metadata.key];
  if (isBlank(value)) return record?.id || '';

  if (metadata.type === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No';
  if (['picklist', 'list', 'countries'].includes(metadata.type)) {
    const values = parseJsonArray(value) || [];
    const labels = new Map(metadata.options.map((option) => [option.value, option.label]));
    return values.map((entry) => labels.get(String(entry)) || String(entry)).join(', ');
  }
  if (metadata.type === 'dropdown') {
    return metadata.options.find((option) => option.value === String(value))?.label || String(value);
  }
  if (metadata.type === 'file') {
    const files = Array.isArray(value) ? value : [value];
    return files.map((file) => (
      typeof file === 'string' ? file : (file?.name || file?.url || file?.path || '')
    )).filter(Boolean).join(', ');
  }
  return String(value);
}

export function resolveCustomObjectLifecycleUpdate({
  currentStatus = 'draft',
  nextStatus,
  currentArchivedAt = null,
  hasPrimaryDisplayField = false,
  now = new Date().toISOString(),
}) {
  if (!CUSTOM_OBJECT_LIFECYCLE_STATES.includes(currentStatus)
    || !CUSTOM_OBJECT_LIFECYCLE_STATES.includes(nextStatus)) {
    throw new CustomObjectDomainError('INVALID_LIFECYCLE', 'Invalid Custom Object lifecycle state');
  }
  if (currentStatus === 'archived' && nextStatus !== 'archived') {
    throw new CustomObjectDomainError('ARCHIVED_IS_TERMINAL', 'Archived Custom Objects cannot be reactivated');
  }
  if (currentStatus === 'active' && nextStatus === 'draft') {
    throw new CustomObjectDomainError(
      'ACTIVE_CANNOT_RETURN_TO_DRAFT',
      'Active Custom Objects cannot return to draft',
    );
  }
  if (nextStatus === 'active' && !hasPrimaryDisplayField) {
    throw new CustomObjectDomainError(
      'PRIMARY_DISPLAY_FIELD_REQUIRED',
      'A primary display field is required before activation',
    );
  }
  return {
    status: nextStatus,
    archived_at: nextStatus === 'archived' ? (currentArchivedAt || now) : null,
  };
}

export function resolveCustomObjectPermission({
  permission = null,
  capability,
  isTenantAdmin = false,
}) {
  if (!CUSTOM_OBJECT_CAPABILITIES.includes(capability)) {
    throw new CustomObjectDomainError('UNKNOWN_CAPABILITY', `Unknown capability: ${capability}`);
  }
  if (isTenantAdmin) return true;
  if (!permission) return false;
  if (capability !== 'view_records' && permission.can_view_records !== true) return false;
  return permission[`can_${capability}`] === true;
}

export function validateCustomObjectRelationshipEndpoints({
  tenantId,
  definition,
  source,
  target,
}) {
  assertTenantOwnership(tenantId, definition, source, target);
  if (!CUSTOM_OBJECT_RELATIONSHIP_CARDINALITIES.includes(definition.cardinality)) {
    throw new CustomObjectDomainError('INVALID_CARDINALITY', 'Relationship cardinality is invalid');
  }
  if (definition.status !== 'active') {
    throw new CustomObjectDomainError('RELATIONSHIP_UNAVAILABLE', 'Relationship definition is not active');
  }
  for (const [side, endpoint] of [['source', source], ['target', target]]) {
    const kind = definition[`${side}_kind`];
    if (!CUSTOM_OBJECT_ENDPOINT_KINDS.includes(kind) || endpoint.kind !== kind) {
      throw new CustomObjectDomainError('ENDPOINT_KIND_MISMATCH', `${side} record type does not match the relationship`);
    }
    if (endpoint.archived_at) {
      throw new CustomObjectDomainError('ARCHIVED_ENDPOINT', `${side} record is archived`);
    }
    if (kind === 'custom_object') {
      const expectedObjectId = definition[`${side}_custom_object_id`];
      if (!expectedObjectId || endpoint.custom_object_id !== expectedObjectId) {
        throw new CustomObjectDomainError('ENDPOINT_OBJECT_MISMATCH', `${side} record belongs to a different Custom Object`);
      }
    }
  }
  return true;
}

export function validateCustomObjectRelationshipDefinition(definition) {
  const errors = [];
  if (!INTERNAL_KEY_RE.test(definition?.relationship_key || '')) {
    errors.push('Relationship key must use lowercase letters, numbers, and underscores');
  }
  if (!CUSTOM_OBJECT_RELATIONSHIP_CARDINALITIES.includes(definition?.cardinality)) {
    errors.push('Relationship cardinality is invalid');
  }
  if (!CUSTOM_OBJECT_LIFECYCLE_STATES.includes(definition?.status)) {
    errors.push('Relationship lifecycle state is invalid');
  }
  for (const side of ['source', 'target']) {
    const kind = definition?.[`${side}_kind`];
    const customObjectId = definition?.[`${side}_custom_object_id`];
    if (!CUSTOM_OBJECT_ENDPOINT_KINDS.includes(kind)) {
      errors.push(`${side} endpoint kind is invalid`);
    } else if (kind === 'custom_object' && !customObjectId) {
      errors.push(`${side} Custom Object id is required`);
    } else if (kind !== 'custom_object' && customObjectId) {
      errors.push(`${side} Custom Object id must be empty for a core endpoint`);
    }
    if (typeof definition?.[`${side}_label`] !== 'string'
      || !definition[`${side}_label`].trim()) {
      errors.push(`${side} label is required`);
    }
  }
  for (const key of [
    'is_required', 'show_on_source', 'show_on_target',
    'edit_from_source', 'edit_from_target',
  ]) {
    if (typeof definition?.[key] !== 'boolean') errors.push(`${key} must be a boolean`);
  }
  if (!definition?.configuration || typeof definition.configuration !== 'object'
    || Array.isArray(definition.configuration)) {
    errors.push('Relationship configuration must be an object');
  }
  return { ok: errors.length === 0, errors };
}

export function buildCustomObjectAuditEvent({
  tenantId,
  customObjectId = null,
  recordId = null,
  relationshipDefinitionId = null,
  relationshipId = null,
  actorId = null,
  actorType = 'system',
  action,
  entityType,
  entityId,
  before = null,
  after = null,
  metadata = {},
}) {
  if (!tenantId || !action || !entityType || !entityId) {
    throw new CustomObjectDomainError(
      'INVALID_AUDIT_EVENT',
      'Audit events require tenant, action, entity type, and entity id',
    );
  }
  if (!CUSTOM_OBJECT_AUDIT_ENTITY_TYPES.includes(entityType)) {
    throw new CustomObjectDomainError(
      'INVALID_AUDIT_ENTITY_TYPE',
      `Unsupported Custom Object audit entity type: ${entityType}`,
    );
  }
  return {
    tenant_id: tenantId,
    custom_object_id: customObjectId,
    record_id: recordId,
    relationship_definition_id: relationshipDefinitionId,
    relationship_id: relationshipId,
    actor_id: actorId,
    actor_type: actorType,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_data: before === null ? null : structuredClone(before),
    after_data: after === null ? null : structuredClone(after),
    metadata: isPlainObject(metadata) ? structuredClone(metadata) : {},
  };
}

export async function recordCustomObjectAuditEvent({ supabase, event }) {
  if (!supabase) {
    throw new CustomObjectDomainError('AUDIT_STORAGE_UNAVAILABLE', 'Audit storage is unavailable');
  }
  const payload = buildCustomObjectAuditEvent(event);
  const { data, error } = await supabase
    .from('custom_object_audit_event')
    .insert(payload)
    .select('*')
    .single();
  if (error) {
    throw new CustomObjectDomainError('AUDIT_WRITE_FAILED', 'Failed to record Custom Object audit event', {
      cause: error.message,
    });
  }
  return data;
}