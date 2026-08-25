import { coerceBooleanPreferenceValue } from './booleanCoercion.js';

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

const INTERNAL_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
      if (metadata.required && isBlank(output[metadata.key])) {
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