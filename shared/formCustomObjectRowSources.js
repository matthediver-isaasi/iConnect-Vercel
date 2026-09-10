const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Equality domains shared by source configuration and authoritative validation. */
export function rowSourceValueDomain(type) {
  const normalized = String(type || '').toLowerCase();
  if (['number', 'decimal', 'currency', 'percentage', 'integer'].includes(normalized)) return 'number';
  if (['boolean', 'bool'].includes(normalized)) return 'boolean';
  if (normalized === 'date') return 'date';
  if (['text', 'textarea', 'email', 'url', 'tel', 'phone', 'country', 'select', 'radio', 'dropdown', 'time'].includes(normalized)) return 'string';
  return null;
}

const RECORD_FIELD_TYPES = new Set([
  'member_dropdown',
  'organisation_dropdown',
  'organization_dropdown',
  'organisation_group_dropdown',
  'organization_group_dropdown',
]);

const MULTI_VALUE_FIELD_TYPES = new Set([
  'checkbox',
  'checkboxes',
  'list',
  'multiselect',
  'countries',
  'category_multiselect',
]);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function uuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function rowChildId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value.trim() === value
    && value !== '_row_id'
    && value !== 'row_id'
    && !value.startsWith('__');
}

function rowSource(field) {
  return field?.option_source;
}

function hasOnlyKeys(object, keys) {
  return Object.keys(object).every(key => keys.has(key));
}

function structurallyValidSource(field) {
  const source = rowSource(field);
  if (field?.type !== 'relationship_dropdown'
      || (field.selection_mode !== undefined && field.selection_mode !== 'single')
      || field.not_listed_choice?.enabled === true
      || !source || typeof source !== 'object' || Array.isArray(source)
      || source.version !== 1
      || (source.kind !== 'records' && source.kind !== 'distinct')
      || !uuid(source.custom_object_id)
      || !uuid(source.primary_display_field_id)
      || !Array.isArray(source.filters)) {
    return false;
  }
  const allowed = new Set([
    'version',
    'kind',
    'custom_object_id',
    'primary_display_field_id',
    'filters',
    ...(source.kind === 'distinct' ? ['value_field_id'] : []),
  ]);
  if (!hasOnlyKeys(source, allowed)) return false;
  if (source.kind === 'distinct') {
    if (!uuid(source.value_field_id)) return false;
  } else if (own(source, 'value_field_id')) {
    return false;
  }
  return source.filters.every(filter => (
    filter && typeof filter === 'object' && !Array.isArray(filter)
    && hasOnlyKeys(filter, new Set(['field_id', 'source_field_id']))
    && uuid(filter.field_id)
    && rowChildId(filter.source_field_id)
  ));
}

export function isCustomObjectRowSource(field) {
  return structurallyValidSource(field);
}

export function isDistinctRowSource(field) {
  return structurallyValidSource(field) && field.option_source.kind === 'distinct';
}

export function rowSourceDependencyIds(field) {
  if (!structurallyValidSource(field)) return [];
  const ids = field.option_source.filters.map(filter => filter.source_field_id);
  if (typeof field.parent_field_id === 'string' && field.parent_field_id) {
    ids.unshift(field.parent_field_id);
  }
  return [...new Set(ids)];
}

function isScalarRowField(field) {
  if (!field || RECORD_FIELD_TYPES.has(field.type) || MULTI_VALUE_FIELD_TYPES.has(field.type)) {
    return false;
  }
  if (field.selection_mode === 'multiple') return false;
  if (field.type === 'relationship_dropdown') return isDistinctRowSource(field);
  if (field.type === 'custom_field') {
    return !MULTI_VALUE_FIELD_TYPES.has(field.custom_field_type)
      && field.custom_field_type !== 'multi_select';
  }
  return true;
}

function recordDescriptor(field) {
  if (!field) return null;
  if (field.type === 'organisation_dropdown' || field.type === 'organization_dropdown') {
    return { kind: 'organization', customObjectId: null };
  }
  if (field.type === 'organisation_group_dropdown'
      || field.type === 'organization_group_dropdown') {
    return { kind: 'organization_group', customObjectId: null };
  }
  if (field.type !== 'relationship_dropdown' || isDistinctRowSource(field)) return null;
  const customObjectId = isCustomObjectRowSource(field)
    ? field.option_source.custom_object_id
    : field.related_custom_object_id || field.custom_object_id || null;
  return {
    kind: field.related_kind || (customObjectId ? 'custom_object' : null),
    customObjectId,
  };
}

/**
 * Validate a custom-object option source in the context of all children in its
 * repeatable row. A missing option_source remains valid for legacy relationship
 * dropdowns; a present source is accepted only when the complete v1 contract
 * is valid.
 */
export function validateRowSourceConfiguration(child, siblings) {
  const errors = [];
  if (child?.option_source === undefined) return { valid: true, errors };
  if (!structurallyValidSource(child)) {
    return {
      valid: false,
      errors: [{
        code: 'invalid_row_option_source',
        child_id: child?.id,
        message: 'The custom object row option source is malformed',
      }],
    };
  }

  const fields = Array.isArray(siblings) ? siblings : [];
  const childIndex = fields.findIndex(candidate => (
    candidate === child || (candidate?.id != null && String(candidate.id) === String(child?.id))
  ));
  if (childIndex < 0) {
    errors.push({
      code: 'invalid_row_option_source',
      child_id: child?.id,
      message: 'A custom object row option source must belong to a repeatable row',
    });
    return { valid: false, errors };
  }

  const source = child.option_source;
  if (child.parent_field_scope === 'form') {
    errors.push({
      code: 'invalid_row_source_parent',
      child_id: child.id,
      message: 'Custom object row sources support only same-row parents',
    });
  }
  const seenFilterFields = new Set();
  for (const filter of source.filters) {
    const dependencyIndex = fields.findIndex(candidate => (
      String(candidate?.id) === String(filter.source_field_id)
    ));
    if (dependencyIndex < 0 || dependencyIndex >= childIndex
        || !isScalarRowField(fields[dependencyIndex])
        || seenFilterFields.has(filter.field_id)) {
      errors.push({
        code: 'invalid_row_source_dependency',
        child_id: child.id,
        source_field_id: filter.source_field_id,
        message: 'A row source filter must reference a compatible earlier scalar column',
      });
    }
    seenFilterFields.add(filter.field_id);
  }

  const hasRelationshipConstraint = Boolean(
    child.relationship_definition_id
    || child.parent_field_id
    || child.relationship_parent_kind
    || child.relationship_parent_custom_object_id
    || child.parent_custom_object_id,
  );
  if (source.kind === 'distinct' || hasRelationshipConstraint) {
    const parentId = child.parent_field_id;
    const isRowParent = (child.parent_field_scope ?? 'row') === 'row';
    const parentIndex = isRowParent
      ? fields.findIndex(candidate => String(candidate?.id) === String(parentId))
      : -1;
    const descriptor = isRowParent && parentIndex >= 0 && parentIndex < childIndex
      ? recordDescriptor(fields[parentIndex]) : null;
    if (!child.relationship_definition_id
        || !parentId
        || !descriptor) {
      errors.push({
        code: source.kind === 'distinct'
          ? 'invalid_distinct_row_source_parent' : 'invalid_row_source_parent',
        child_id: child.id,
        message: source.kind === 'distinct'
          ? 'A distinct row source must have a compatible earlier relationship parent'
          : 'A relationship-constrained row source must have a compatible parent',
      });
    } else if (descriptor) {
      const expectedKind = child.relationship_parent_kind || null;
      const expectedObjectId = child.relationship_parent_custom_object_id
        || child.parent_custom_object_id || null;
      if ((expectedKind && descriptor.kind !== expectedKind)
          || (expectedObjectId && (descriptor.kind !== 'custom_object'
            || String(descriptor.customObjectId) !== String(expectedObjectId)))) {
        errors.push({
          code: source.kind === 'distinct'
            ? 'invalid_distinct_row_source_parent' : 'invalid_row_source_parent',
          child_id: child.id,
          message: 'The distinct row source parent does not match its relationship constraint',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}