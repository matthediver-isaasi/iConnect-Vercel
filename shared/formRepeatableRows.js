export const REPEATABLE_ROW_SCHEMA_VERSION = 1;
export const REPEATABLE_ROW_FIELD_TYPE = 'repeatable_row';
export const REPEATABLE_ROW_FIELD_TYPES = Object.freeze([
  REPEATABLE_ROW_FIELD_TYPE,
  'repeatable_rows',
  'repeatable_grid',
]);

export const REPEATABLE_ROW_CHILD_TYPES = Object.freeze([
  'text', 'textarea', 'email', 'phone', 'tel', 'url', 'number', 'percentage',
  'currency', 'date', 'time', 'boolean', 'dropdown', 'select', 'radio',
  'checkbox', 'checkboxes', 'list', 'multiselect', 'country', 'countries',
  'category_dropdown', 'category_multiselect', 'custom_field',
  'organisation_dropdown', 'organisation_group_dropdown', 'relationship_dropdown',
]);

export const REPEATABLE_ROW_DEPENDENCY_TYPES = Object.freeze([
  'organisation_dropdown',
  'relationship_dropdown',
  'dropdown', 'select',
  'radio',
  'checkbox', 'checkboxes', 'list', 'multiselect',
  'country', 'countries',
  'category_dropdown', 'category_multiselect', 'custom_field',
]);

const CHILD_TYPES = new Set(REPEATABLE_ROW_CHILD_TYPES);
const DEPENDENCY_TYPES = new Set(REPEATABLE_ROW_DEPENDENCY_TYPES);
const DEFAULT_MAX_ROWS = 10;
const HARD_MAX_ROWS = 100;

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
};

export function isRepeatableRowField(field) {
  return REPEATABLE_ROW_FIELD_TYPES.includes(field?.type);
}

export function repeatableRowChildren(field) {
  const config = field?.repeatable_row && typeof field.repeatable_row === 'object'
    ? field.repeatable_row : field;
  const children = config?.children ?? config?.child_fields ?? config?.fields;
  return Array.isArray(children) ? children.filter((child) => child && typeof child === 'object') : [];
}

export function normalizeRepeatableRowField(field = {}) {
  const source = field.repeatable_row && typeof field.repeatable_row === 'object'
    ? field.repeatable_row : field;
  const children = repeatableRowChildren(field).map((child) => ({
    ...child,
    id: child.id == null ? '' : String(child.id),
    required: child.required === true || child.is_required === true,
  }));
  const minimum = integer(source.min_rows ?? source.minimum_rows, 0, 0, HARD_MAX_ROWS);
  const firstRequired = source.first_row_required === true || source.initial_row_required === true;
  const minRows = Math.max(minimum, firstRequired ? 1 : 0);
  const maxRows = integer(source.max_rows ?? source.maximum_rows, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS);
  return {
    version: Number.parseInt(
      source.repeatable_rows_version ?? source.version ?? source.schema_version,
      10,
    ) || REPEATABLE_ROW_SCHEMA_VERSION,
    children,
    min_rows: Math.min(minRows, maxRows),
    max_rows: maxRows,
    first_row_required: firstRequired,
    add_row_label: typeof source.add_row_label === 'string' && source.add_row_label.trim()
      ? source.add_row_label.trim() : 'Add another',
  };
}

export function createRepeatableRowId(random = Math.random, now = Date.now) {
  const time = Number(now()).toString(36);
  const entropy = Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36).padStart(10, '0');
  return `row_${time}_${entropy}`;
}

export function ensureRepeatableRowIds(rows, createId = createRepeatableRowId) {
  const used = new Set();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const value = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    let id = typeof value._row_id === 'string' ? value._row_id.trim() : '';
    if (!id || used.has(id)) {
      do { id = createId(); } while (used.has(id));
    }
    used.add(id);
    return { ...value, _row_id: id };
  });
}

export function isRepeatableValueEmpty(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function isRepeatableRowEmpty(row, fieldOrChildren) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  const children = Array.isArray(fieldOrChildren)
    ? fieldOrChildren : repeatableRowChildren(fieldOrChildren);
  return children.every((child) => isRepeatableValueEmpty(row[child.id]));
}

function optionValue(option) {
  if (option && typeof option === 'object') return option.value ?? option.id ?? option.key;
  return option;
}

function selectedValues(value) {
  return Array.isArray(value) ? value : [value];
}

export function validateRepeatableRowConfiguration(field, options = {}) {
  const config = normalizeRepeatableRowField(field);
  const rootFields = Array.isArray(options.rootFields) ? options.rootFields : [];
  const containerIndex = rootFields.findIndex(
    (candidate) => String(candidate?.id) === String(field?.id),
  );
  const errors = [];
  if (config.version !== REPEATABLE_ROW_SCHEMA_VERSION) {
    errors.push({ code: 'unsupported_version', message: 'Unsupported repeatable row schema version' });
  }
  const ids = new Set();
  if (config.children.length === 0) {
    errors.push({ code: 'missing_children', message: 'A repeatable row must contain at least one child field' });
  }
  config.children.forEach((child, index) => {
    if (!child.id || child.id === '_row_id' || child.id.length > 200 || ids.has(child.id)) {
      errors.push({ code: 'invalid_child_key', child_id: child.id, message: 'Child keys must be non-empty and unique' });
    }
    ids.add(child.id);
    if (!CHILD_TYPES.has(child.type)) {
      errors.push({ code: 'unsupported_child_type', child_id: child.id, message: `Unsupported repeatable row child type: ${child.type || 'unknown'}` });
    }
    const dependency = child.row_dependency ?? child.dependency;
    if (dependency) {
      const parentId = dependency.source_field_id ?? dependency.parent_field_id;
      const parentIndex = config.children.findIndex((candidate) => candidate.id === String(parentId));
      if (!DEPENDENCY_TYPES.has(child.type) || parentIndex < 0 || parentIndex >= index) {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'A row dependency must reference a compatible preceding sibling' });
      }
    }
    const conditionalRules = child.conditional_filters?.rules;
    if (Array.isArray(conditionalRules)) {
      if (!DEPENDENCY_TYPES.has(child.type)) {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'This child type does not support dependent options' });
      }
      for (const rule of conditionalRules) {
        if (rule?.is_fallback) continue;
        const parentIndex = config.children.findIndex(
          (candidate) => candidate.id === String(rule?.source_field_id),
        );
        if (parentIndex < 0 || parentIndex >= index) {
          errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'A row dependency must reference a preceding sibling' });
          break;
        }
      }
    }
    if (child.type === 'relationship_dropdown') {
      const parentId = child.parent_field_id;
      const scope = child.parent_field_scope ?? 'row';
      const parentFields = scope === 'form' ? rootFields : config.children;
      const parentIndex = parentFields.findIndex(
        (candidate) => String(candidate?.id) === String(parentId),
      );
      const isValidScope = scope === 'row' || scope === 'form';
      const precedesChild = scope === 'form'
        ? containerIndex >= 0 && parentIndex >= 0 && parentIndex < containerIndex
        : parentIndex >= 0 && parentIndex < index;
      const parent = parentFields[parentIndex];
      const parentDescriptor = parent?.type === 'organisation_dropdown'
        ? { kind: 'organization', customObjectId: null }
        : parent?.type === 'organisation_group_dropdown'
          ? { kind: 'organization_group', customObjectId: null }
          : parent?.type === 'relationship_dropdown'
            ? {
              kind: parent.related_kind || 'custom_object',
              customObjectId: parent.related_custom_object_id || parent.custom_object_id || null,
            }
            : null;
      const expectedKind = child.relationship_parent_kind || null;
      const expectedObjectId = child.relationship_parent_custom_object_id
        || child.parent_custom_object_id || null;
      const descriptorMatches = parentDescriptor
        && (!expectedKind || parentDescriptor.kind === expectedKind)
        && (!expectedObjectId || (parentDescriptor.kind === 'custom_object'
          && String(parentDescriptor.customObjectId) === String(expectedObjectId)));
      if (!isValidScope || !precedesChild
          || !descriptorMatches) {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'A relationship child must reference a compatible preceding parent' });
      }
    }
    if (child.type === 'organisation_dropdown' && child.organisation_group_parent_field_id) {
      const scope = child.organisation_group_parent_scope
        ?? child.organisation_group_parent_field_scope ?? 'row';
      const parentFields = scope === 'form' ? rootFields : config.children;
      const parentIndex = parentFields.findIndex(
        candidate => String(candidate?.id) === String(child.organisation_group_parent_field_id),
      );
      const isValidScope = scope === 'row' || scope === 'form';
      const precedesChild = scope === 'form'
        ? containerIndex >= 0 && parentIndex >= 0 && parentIndex < containerIndex
        : parentIndex >= 0 && parentIndex < index;
      if (!isValidScope || !precedesChild
          || parentFields[parentIndex]?.type !== 'organisation_group_dropdown') {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'An organisation child group filter must reference a compatible preceding Organisation Group parent' });
      }
    }
  });
  return { valid: errors.length === 0, errors, config };
}

export function validateRepeatableRows(field, value, options = {}) {
  const configuration = validateRepeatableRowConfiguration(field, options);
  const errors = [...configuration.errors];
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      errors.push({ code: 'invalid_rows', message: 'Repeatable row answer must be an array' });
    } else if (configuration.config.min_rows > 0) {
      errors.push({ code: 'min_rows', message: `At least ${configuration.config.min_rows} row(s) are required` });
    }
    return { valid: errors.length === 0, errors, rows: [], config: configuration.config };
  }
  const { config } = configuration;
  if (value.length < config.min_rows) errors.push({ code: 'min_rows', message: `At least ${config.min_rows} row(s) are required` });
  if (value.length > config.max_rows) errors.push({ code: 'max_rows', message: `No more than ${config.max_rows} row(s) are allowed` });
  const childIds = new Set(config.children.map((child) => child.id));
  const rowIds = new Set();
  value.forEach((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ code: 'invalid_row', row: rowIndex, message: `Row ${rowIndex + 1} is invalid` });
      return;
    }
    for (const key of Object.keys(row)) {
      if (key !== '_row_id' && !childIds.has(key)) {
        errors.push({ code: 'unknown_child', row: rowIndex, child_id: key, message: `Row ${rowIndex + 1} contains an unsupported field` });
      }
    }
    if (row._row_id !== undefined) {
      if (typeof row._row_id !== 'string' || !row._row_id.trim()
          || row._row_id.length > 200 || rowIds.has(row._row_id)) {
        errors.push({ code: 'invalid_row_id', row: rowIndex, message: `Row ${rowIndex + 1} has an invalid row ID` });
      } else rowIds.add(row._row_id);
    }
    const active = !isRepeatableRowEmpty(row, config.children)
      || rowIndex < config.min_rows || (rowIndex === 0 && config.first_row_required);
    if (!active) return;
    for (const child of config.children) {
      const selected = row[child.id];
      if (child.required && isRepeatableValueEmpty(selected)) {
        errors.push({ code: 'required_child', row: rowIndex, child_id: child.id, message: `${child.label || child.id} is required in row ${rowIndex + 1}` });
        continue;
      }
      if (isRepeatableValueEmpty(selected)) continue;
      if (Array.isArray(child.options) && child.options.length) {
        const allowed = new Set(child.options.map(optionValue).filter((item) => item != null).map(String));
        if (selectedValues(selected).some((item) => !allowed.has(String(item)))) {
          errors.push({ code: 'invalid_selection', row: rowIndex, child_id: child.id, message: `${child.label || child.id} has an invalid selection` });
        }
      }
      const scalar = Array.isArray(selected) ? null : selected;
      if (child.type === 'email' && (typeof scalar !== 'string'
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(scalar.trim()))) {
        errors.push({ code: 'invalid_email', row: rowIndex, child_id: child.id, message: `${child.label || child.id} must be a valid email address` });
      } else if (child.type === 'number' && (scalar === null || scalar === ''
          || !Number.isFinite(Number(scalar)))) {
        errors.push({ code: 'invalid_number', row: rowIndex, child_id: child.id, message: `${child.label || child.id} must be a number` });
      } else if (child.type === 'url' && (typeof scalar !== 'string'
          || !/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(scalar.trim()))) {
        errors.push({ code: 'invalid_url', row: rowIndex, child_id: child.id, message: `${child.label || child.id} must be a valid URL` });
      } else if ((child.type === 'date' || child.type === 'time')
          && typeof scalar !== 'string') {
        errors.push({ code: 'invalid_value', row: rowIndex, child_id: child.id, message: `${child.label || child.id} has an invalid value` });
      }
      if (typeof options.validateChild === 'function') {
        const result = options.validateChild({ child, value: selected, row, rowIndex, field });
        if (result === false || typeof result === 'string') {
          errors.push({ code: 'invalid_child', row: rowIndex, child_id: child.id, message: typeof result === 'string' ? result : `${child.label || child.id} is invalid` });
        }
      }
    }
  });
  return { valid: errors.length === 0, errors, rows: value, config };
}

export async function validateRepeatableRowsAsync(field, value, options = {}) {
  const basic = validateRepeatableRows(field, value, options);
  if (!basic.valid || typeof options.validateChildAsync !== 'function') return basic;
  const errors = [];
  for (let rowIndex = 0; rowIndex < basic.rows.length; rowIndex += 1) {
    const row = basic.rows[rowIndex];
    const active = !isRepeatableRowEmpty(row, basic.config.children)
      || rowIndex < basic.config.min_rows || (rowIndex === 0 && basic.config.first_row_required);
    if (!active) continue;
    for (const child of basic.config.children) {
      const valueAtChild = row[child.id];
      if (isRepeatableValueEmpty(valueAtChild)) continue;
      const result = await options.validateChildAsync({ child, value: valueAtChild, row, rowIndex, field });
      if (result === false || typeof result === 'string') {
        errors.push({ code: 'invalid_child', row: rowIndex, child_id: child.id, message: typeof result === 'string' ? result : `${child.label || child.id} is invalid` });
      }
    }
  }
  return { ...basic, valid: errors.length === 0, errors };
}

export function formatRepeatableRows(field, value, options = {}) {
  if (!Array.isArray(value) || value.length === 0) return options.emptyText ?? '';
  const children = normalizeRepeatableRowField(field).children;
  const formatValue = options.formatValue || ((item) => Array.isArray(item) ? item.join(', ') : String(item));
  return value.filter((row) => !isRepeatableRowEmpty(row, children)).map((row, index) => {
    const values = children
      .filter((child) => !isRepeatableValueEmpty(row?.[child.id]))
      .map((child) => `${child.label || child.id}: ${formatValue(row[child.id], child, row)}`);
    return `${options.rowLabel || 'Row'} ${index + 1}: ${values.join('; ')}`;
  }).join(options.separator || '\n');
}