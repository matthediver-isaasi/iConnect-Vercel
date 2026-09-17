import { resolveCountryToIso2 } from './countries.js';
import {
  isCustomObjectRowSource,
  isDistinctRowSource,
  validateRowSourceConfiguration,
} from './formCustomObjectRowSources.js';
import { repeatableDateSettings } from './formRepeatableDates.js';

export const REPEATABLE_ROW_SCHEMA_VERSION = 1;
export const REPEATABLE_ROW_FIELD_TYPE = 'repeatable_row';
export const REPEATABLE_ROW_FIELD_TYPES = Object.freeze([
  REPEATABLE_ROW_FIELD_TYPE,
  'repeatable_rows',
  'repeatable_grid',
]);
export const REPEATABLE_ROW_LAYOUT_CARDS = 'cards';
export const REPEATABLE_ROW_LAYOUT_SPREADSHEET = 'spreadsheet';

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

export const REPEATABLE_ROW_EXCLUSION_TYPES = Object.freeze([
  'dropdown', 'select', 'radio', 'checkbox', 'checkboxes', 'list', 'multiselect',
  'country', 'countries', 'category_dropdown', 'category_multiselect', 'custom_field',
  'organisation_dropdown', 'organisation_group_dropdown', 'relationship_dropdown',
]);

const CHILD_TYPES = new Set(REPEATABLE_ROW_CHILD_TYPES);
const DEPENDENCY_TYPES = new Set(REPEATABLE_ROW_DEPENDENCY_TYPES);
const EXCLUSION_TYPES = new Set(REPEATABLE_ROW_EXCLUSION_TYPES);
const DEFAULT_MAX_ROWS = 10;
const HARD_MAX_ROWS = 100;

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
};

export function isRepeatableRowField(field) {
  return REPEATABLE_ROW_FIELD_TYPES.includes(field?.type);
}

export function supportsRepeatableRowStaticOptions(child) {
  return ['select', 'dropdown', 'radio', 'checkbox'].includes(child?.type);
}

export function parseRepeatableRowOptionsText(text) {
  return text.split(/\r\n?|\n/).map(option => option.trim()).filter(Boolean);
}

export function repeatableRowChildren(field) {
  const config = field?.repeatable_row && typeof field.repeatable_row === 'object'
    ? field.repeatable_row : field;
  const children = config?.children ?? config?.child_fields ?? config?.fields;
  return Array.isArray(children) ? children.filter((child) => child && typeof child === 'object') : [];
}

const REPEATABLE_NOT_LISTED_TEXT_KEY = '__not_listed_choice_text';
const REPEATABLE_NOT_LISTED_LABELS_KEY = '__not_listed_choice_labels';
const ROW_VISIBILITY_MODES = new Set(['always', 'show_when', 'hide_when']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyTrue(value) {
  return value === true || value === 'true';
}

function rowVisibilityRule(child) {
  return child?.row_visibility == null ? null : child.row_visibility;
}

function isMultiValueRepeatableSource(source) {
  return source?.selection_mode === 'multiple'
    || ['multi', 'multiselect', 'multi_select'].includes(source?.selection_mode)
    || source?.multiple === true;
}

/**
 * Return the same-row static scalar choice children which may drive a
 * visibility rule. Dynamic option sources and multi-value controls are not
 * deterministic enough for a row rule and are deliberately excluded.
 */
export function repeatableRowVisibilitySources(field, child) {
  const children = normalizeRepeatableRowField(field).children;
  const childId = child?.id == null ? null : String(child.id);
  return children.filter((source) => (
    source
    && String(source.id) !== childId
    && ['dropdown', 'select'].includes(source.type)
    && source.option_source === undefined
    && !isMultiValueRepeatableSource(source)
  ));
}

export function repeatableRowVisibilityOptions(source) {
  if (!source || source.option_source !== undefined
      || !['dropdown', 'select'].includes(source.type)
      || isMultiValueRepeatableSource(source)) {
    return [];
  }
  const configured = Array.isArray(source.options) ? source.options : [];
  return configured.flatMap((option) => {
    const value = optionValue(option);
    if (value === undefined || value === null) return [];
    const label = option && typeof option === 'object'
      ? option.label ?? option.name ?? option.title ?? String(value)
      : String(value);
    return [{ value, label: String(label) }];
  });
}

function rowVisibilityError(field, child) {
  const rule = rowVisibilityRule(child);
  if (rule === null) return null;
  if (!isPlainObject(rule) || !ROW_VISIBILITY_MODES.has(rule.mode)) {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A row visibility rule must use always, show_when, or hide_when',
    };
  }
  if (Object.prototype.hasOwnProperty.call(rule, 'operator')
      && rule.operator !== 'equals') {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A row visibility rule only supports the equals operator',
    };
  }
  if (Object.prototype.hasOwnProperty.call(rule, 'scope')
      && rule.scope !== 'row') {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A row visibility rule only supports same-row scope',
    };
  }
  const hasSource = Object.prototype.hasOwnProperty.call(rule, 'source_field_id');
  const hasValue = Object.prototype.hasOwnProperty.call(rule, 'value');
  if (rule.mode === 'always') {
    if (hasSource || hasValue) {
      return {
        code: 'invalid_row_visibility',
        child_id: child?.id,
        message: 'An always-visible child cannot specify a visibility source or value',
      };
    }
    return null;
  }
  if (!hasSource || typeof rule.source_field_id !== 'string' || !rule.source_field_id.trim()
      || !hasValue || rule.value === undefined || rule.value === null) {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A conditional row visibility rule must specify a source field and value',
    };
  }
  const source = repeatableRowVisibilitySources(field, child)
    .find(candidate => String(candidate.id) === rule.source_field_id);
  if (!source) {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A row visibility source must be a same-row static single-select child',
    };
  }
  if (!repeatableRowVisibilityOptions(source).some(option => (
    repeatableRowValuesMatch(option.value, rule.value)
  ))) {
    return {
      code: 'invalid_row_visibility',
      child_id: child?.id,
      message: 'A row visibility value must be one of the source options',
    };
  }
  return null;
}

/**
 * Validate visibility independently so editors and submission validators can
 * report a bad rule rather than silently treating it as a hidden child.
 */
export function validateRepeatableRowVisibilityConfiguration(field) {
  const children = normalizeRepeatableRowField(field).children;
  const errors = children
    .map(child => rowVisibilityError(field, child))
    .filter(Boolean);
  const validRules = new Map(
    children
      .filter(child => rowVisibilityRule(child)
        && rowVisibilityRule(child).mode !== 'always'
        && !rowVisibilityError(field, child))
      .map(child => [String(child.id), String(rowVisibilityRule(child).source_field_id)]),
  );
  const cycleChildren = new Set();
  for (const start of validRules.keys()) {
    const path = [];
    const pathIndexes = new Map();
    let current = start;
    while (validRules.has(current) && !cycleChildren.has(current)) {
      if (pathIndexes.has(current)) {
        for (const childId of path.slice(pathIndexes.get(current))) {
          cycleChildren.add(childId);
        }
        break;
      }
      pathIndexes.set(current, path.length);
      path.push(current);
      current = validRules.get(current);
    }
  }
  for (const childId of cycleChildren) {
    errors.push({
      code: 'invalid_row_visibility_cycle',
      child_id: childId,
      message: 'Row visibility rules cannot contain a cycle',
    });
  }
  return errors;
}

function repeatableRowValuesMatch(answer, expected) {
  if (answer === undefined || answer === null) return false;
  if (Array.isArray(answer) || Array.isArray(expected)
      || (answer && typeof answer === 'object')
      || (expected && typeof expected === 'object')) return false;
  return Object.is(answer, expected) || String(answer) === String(expected);
}

function asIdSet(value) {
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

/**
 * Resolve children hidden in one row. Conditions intentionally read rawRow;
 * callers must not feed a previously projected row back into this function.
 */
export function getRepeatableRowHiddenChildIds(
  field,
  rawRow,
  { hiddenFieldIds = new Set(), parentHidden = false } = {},
) {
  const children = normalizeRepeatableRowField(field).children;
  const hidden = asIdSet(hiddenFieldIds);
  const parentIsHidden = parentHidden === true
    || (field?.id != null && hidden.has(String(field.id)));
  if (field?.id != null) hidden.delete(String(field.id));
  children.forEach((child) => {
    if (isLegacyTrue(child.hidden) || isLegacyTrue(child.starts_hidden)) {
      hidden.add(String(child.id));
    }
    if (parentIsHidden) hidden.add(String(child.id));
  });
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) return hidden;
  children.forEach((child) => {
    const rule = rowVisibilityRule(child);
    if (!rule || rowVisibilityError(field, child)) return;
    if (rule.mode === 'always') return;
    const matches = repeatableRowValuesMatch(rawRow[rule.source_field_id], rule.value);
    if ((rule.mode === 'show_when' && !matches)
        || (rule.mode === 'hide_when' && matches)) {
      hidden.add(String(child.id));
    }
  });
  return hidden;
}

function omitRepeatableRowMetadata(row, hidden) {
  const result = { ...row };
  for (const key of [REPEATABLE_NOT_LISTED_TEXT_KEY, REPEATABLE_NOT_LISTED_LABELS_KEY]) {
    const metadata = result[key];
    if (!isPlainObject(metadata)) continue;
    const projected = Object.fromEntries(
      Object.entries(metadata).filter(([childId]) => !hidden.has(String(childId))),
    );
    if (Object.keys(projected).length) result[key] = projected;
    else delete result[key];
  }
  return result;
}

/**
 * Project raw repeatable answers for mappings, emails and other side effects.
 * Raw rows are never mutated; storage and validation retain the original
 * answers so dependency and visibility evaluation cannot lose hidden sources.
 */
export function effectiveRepeatableRowAnswers(
  field,
  rawRows,
  { hiddenFieldIds = new Set(), parentHidden = false } = {},
) {
  if (!Array.isArray(rawRows)) return rawRows;
  return rawRows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const hidden = getRepeatableRowHiddenChildIds(field, row, { hiddenFieldIds, parentHidden });
    return omitRepeatableRowMetadata(
      Object.fromEntries(Object.entries(row).filter(([key]) => (
        key === '_row_id' || !hidden.has(String(key))
      ))),
      hidden,
    );
  });
}

export function repeatableRowAddLabelEditorValue(field) {
  const source = field?.repeatable_row && typeof field.repeatable_row === 'object'
    ? field.repeatable_row : field;
  return typeof source?.add_row_label === 'string' ? source.add_row_label : 'Add another';
}

export function repeatableRowFieldConfigUpdate(field, updates = {}) {
  if (field?.repeatable_row && typeof field.repeatable_row === 'object') {
    return {
      repeatable_row: {
        ...field.repeatable_row,
        ...updates,
      },
    };
  }
  const topLevelUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(topLevelUpdates, 'children')) {
    const childKey = Array.isArray(field?.children)
      ? 'children'
      : Array.isArray(field?.child_fields)
        ? 'child_fields'
        : Array.isArray(field?.fields)
          ? 'fields'
          : 'child_fields';
    topLevelUpdates[childKey] = topLevelUpdates.children;
    if (childKey !== 'children') delete topLevelUpdates.children;
  }
  return topLevelUpdates;
}

export function normalizeRepeatableRowField(field = {}) {
  const source = field.repeatable_row && typeof field.repeatable_row === 'object'
    ? field.repeatable_row : field;
  const children = repeatableRowChildren(field).map((child) => {
    const exclusion = child.exclude_values_from;
    const normalizedExclusion = exclusion
      && typeof exclusion === 'object'
      && !Array.isArray(exclusion)
      && exclusion.scope === 'form'
      && typeof exclusion.source_field_id === 'string'
      && exclusion.source_field_id
      ? { scope: 'form', source_field_id: exclusion.source_field_id }
      : null;
    return {
      ...child,
      id: child.id == null ? '' : String(child.id),
      required: child.required === true || child.is_required === true,
      unique_across_rows: child.unique_across_rows === true,
      ...(normalizedExclusion
        ? { exclude_values_from: normalizedExclusion }
        : { exclude_values_from: undefined }),
    };
  });
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
    hide_when_first_column_empty: source.hide_when_first_column_empty === true,
    add_row_label: typeof source.add_row_label === 'string' && source.add_row_label.trim()
      ? source.add_row_label.trim() : 'Add another',
    layout: (source.layout ?? source.display_style) === REPEATABLE_ROW_LAYOUT_SPREADSHEET
      ? REPEATABLE_ROW_LAYOUT_SPREADSHEET : REPEATABLE_ROW_LAYOUT_CARDS,
  };
}

/**
 * Availability-based hiding is deliberately limited to option sources whose
 * domain can be resolved without inventing a row answer.  In particular, an
 * organisation child with a form-scoped group parent has a deterministic
 * domain; a row-scoped parent does not, because every row could have a
 * different set of choices.
 *
 * Keep this contract shared by the editor, renderer and server.  Callers may
 * explain `reason` to administrators, but must treat unsupported sources as
 * visible rather than guessing that they are empty.
 */
export function repeatableEmptyAvailabilitySupport(field) {
  if (!isRepeatableRowField(field)) {
    return { supported: false, reason: 'not_repeatable_row' };
  }
  const config = normalizeRepeatableRowField(field);
  const first = config.children[0];
  if (!first) return { supported: false, reason: 'missing_first_column' };
  if (first.type !== 'organisation_dropdown') {
    return { supported: false, reason: 'unsupported_first_column_type' };
  }
  if (first.option_source !== undefined) {
    return { supported: false, reason: 'unsupported_first_column_source' };
  }
  if (first.organisation_group_parent_field_id) {
    const scope = first.organisation_group_parent_scope
      ?? first.organisation_group_parent_field_scope ?? 'row';
    if (scope !== 'form') {
      return { supported: false, reason: 'row_scoped_group_dependency' };
    }
  }
  return { supported: true, reason: null };
}

function relationshipValueDescriptor(field) {
  if (isDistinctRowSource(field)
      || (field?.option_source !== undefined && !isCustomObjectRowSource(field))) {
    return { kind: null, customObjectId: null };
  }
  const sourceObjectId = isCustomObjectRowSource(field)
    ? field.option_source.custom_object_id : null;
  return {
    kind: field?.related_kind || (sourceObjectId || field?.custom_object_id ? 'custom_object' : null),
    customObjectId: sourceObjectId || field?.related_custom_object_id || field?.custom_object_id || null,
  };
}

function choiceFamily(field) {
  if (!field || !EXCLUSION_TYPES.has(field.type)) return null;
  if (field.type === 'organisation_dropdown') return 'organization';
  if (field.type === 'organisation_group_dropdown') return 'organization_group';
  if (field.type === 'relationship_dropdown') {
    const descriptor = relationshipValueDescriptor(field);
    return descriptor.kind
      ? `relationship:${descriptor.kind}:${descriptor.customObjectId || ''}`
      : null;
  }
  if (field.type === 'country' || field.type === 'countries') return 'country';
  if (field.type === 'category_dropdown' || field.type === 'category_multiselect') {
    return `category:${field.category_id || ''}`;
  }
  if (field.type === 'custom_field') {
    return field.custom_field_id ? `custom:${field.custom_field_id}` : null;
  }
  return 'static_choice';
}

export function isRepeatableExclusionSourceCompatible(child, sourceField) {
  const childFamily = choiceFamily(child);
  const sourceFamily = choiceFamily(sourceField);
  return Boolean(childFamily && sourceFamily && childFamily === sourceFamily);
}

export function repeatableExclusionSourceFields(rootFields, containerField, child) {
  const fields = Array.isArray(rootFields) ? rootFields : [];
  const containerIndex = fields.findIndex(candidate => (
    String(candidate?.id) === String(containerField?.id)
  ));
  if (containerIndex < 0) return [];
  return fields.slice(0, containerIndex).filter(source => (
    source?.id && isRepeatableExclusionSourceCompatible(child, source)
  ));
}

function formValue(values, field) {
  if (!values || typeof values !== 'object' || !field) return undefined;
  if (field.id != null && values[field.id] !== undefined) return values[field.id];
  return field.name != null ? values[field.name] : undefined;
}

function exclusionSelectedValues(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap(item => Array.isArray(item) ? exclusionSelectedValues(item) : [item])
    .map(item => (
      item && typeof item === 'object' && !Array.isArray(item) && 'value' in item
        ? item.value : item
    ))
    .filter(item => !isRepeatableValueEmpty(item));
}

export function resolveRepeatableExcludedValues(child, rootFields = [], rootValues = {}, containerField = null) {
  const sourceId = child?.exclude_values_from?.scope === 'form'
    ? child.exclude_values_from.source_field_id : null;
  if (!sourceId) return [];
  const source = repeatableExclusionSourceFields(
    rootFields,
    containerField || rootFields.find(field => repeatableRowChildren(field).some(candidate => candidate === child
      || String(candidate?.id) === String(child?.id))),
    child,
  ).find(field => String(field.id) === String(sourceId));
  return source ? exclusionSelectedValues(formValue(rootValues, source)) : [];
}

export function repeatableSelectionContainsExcludedValue(selection, child, excludedValues = []) {
  if (isRepeatableValueEmpty(selection) || !Array.isArray(excludedValues) || excludedValues.length === 0) {
    return false;
  }
  const excluded = new Set(excludedValues.map(value => repeatableUniqueValueKey(value, child)));
  return exclusionSelectedValues(selection)
    .some(value => excluded.has(repeatableUniqueValueKey(value, child)));
}

export function removeRepeatableExcludedSelection(selection, child, excludedValues = []) {
  if (!repeatableSelectionContainsExcludedValue(selection, child, excludedValues)) return selection;
  if (!Array.isArray(selection)) return '';
  return selection.filter(value => (
    !repeatableSelectionContainsExcludedValue(value, child, excludedValues)
  ));
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

function repeatableRowValueEquals(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => repeatableRowValueEquals(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => (
      Object.prototype.hasOwnProperty.call(right, key)
      && repeatableRowValueEquals(left[key], right[key])
    ));
}

export function reconcilePendingRepeatableRows(incomingRows, pendingRows) {
  if (!pendingRows) return { currentRows: incomingRows, pendingRows: null };
  if (repeatableRowValueEquals(incomingRows, pendingRows)) {
    return { currentRows: incomingRows, pendingRows: null };
  }
  return { currentRows: pendingRows, pendingRows };
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

function repeatableRowVisibilitySourceIds(field) {
  return new Set(normalizeRepeatableRowField(field).children
    .filter((child) => {
      const rule = rowVisibilityRule(child);
      return rule && rule.mode !== 'always' && !rowVisibilityError(field, child);
    })
    .map(child => String(child.row_visibility.source_field_id)));
}

export function repeatableUniqueValueKey(value, child) {
  if (Array.isArray(value)) {
    return `array:${JSON.stringify(value
      .map(item => repeatableUniqueValueKey(item, child))
      .sort())}`;
  }
  if (value && typeof value === 'object') {
    return `object:${JSON.stringify(Object.keys(value).sort().map(key => [
      key,
      repeatableUniqueValueKey(value[key], child),
    ]))}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      child?.type === 'country'
      || child?.type === 'countries'
      || child?.custom_field_type === 'country'
      || child?.custom_field_type === 'countries'
      || child?.type === 'custom_field'
    ) {
      const countryCode = resolveCountryToIso2(trimmed);
      if (countryCode) return `country:${countryCode}`;
    }
    if (['number', 'percentage', 'currency'].includes(child?.type)
        && trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return `number:${Number(trimmed)}`;
    }
    return `string:${child?.type === 'email' ? trimmed.toLowerCase() : trimmed}`;
  }
  if (typeof value === 'number') return `number:${Number(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return `${typeof value}:${String(value)}`;
}

export function repeatableSiblingUniqueValueKeys(rows, child, currentRowId, options = {}) {
  const keys = new Set();
  if (!child?.unique_across_rows || isLegacyTrue(child.hidden) || isLegacyTrue(child.starts_hidden)
      || !Array.isArray(rows)) return keys;
  rows.forEach((row) => {
    if (!row || row._row_id === currentRowId) return;
    if (options.field && getRepeatableRowHiddenChildIds(options.field, row, options).has(child.id)) {
      return;
    }
    const selected = row[child.id];
    if (!isRepeatableValueEmpty(selected)) {
      keys.add(repeatableUniqueValueKey(selected, child));
    }
  });
  return keys;
}

export function repeatableSiblingUniqueValues(rows, child, currentRowId, options = {}) {
  if (!child?.unique_across_rows || isLegacyTrue(child.hidden) || isLegacyTrue(child.starts_hidden)
      || !Array.isArray(rows)) return [];
  const values = rows
    .filter(row => row && row._row_id !== currentRowId)
    .filter(row => !options.field
      || !getRepeatableRowHiddenChildIds(options.field, row, options).has(child.id))
    .map(row => row[child.id])
    .filter(selected => !isRepeatableValueEmpty(selected));
  return child?.type === 'relationship_dropdown' && child?.selection_mode === 'multiple'
    ? values.flatMap(selected => Array.isArray(selected) ? selected : [selected])
    : values;
}

export function isRepeatableUniqueOptionAvailable(
  optionValue,
  currentValue,
  child,
  excludedValueKeys,
) {
  if (!(excludedValueKeys instanceof Set) || excludedValueKeys.size === 0) return true;
  const optionKey = repeatableUniqueValueKey(optionValue, child);
  return optionKey === repeatableUniqueValueKey(currentValue, child)
    || !excludedValueKeys.has(optionKey);
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
  errors.push(...validateRepeatableRowVisibilityConfiguration(field));
  config.children.forEach((child, index) => {
    if (!child.id || child.id === '_row_id' || child.id.length > 200 || ids.has(child.id)) {
      errors.push({ code: 'invalid_child_key', child_id: child.id, message: 'Child keys must be non-empty and unique' });
    }
    ids.add(child.id);
    if (!CHILD_TYPES.has(child.type)) {
      errors.push({ code: 'unsupported_child_type', child_id: child.id, message: `Unsupported repeatable row child type: ${child.type || 'unknown'}` });
    }
    if (child.type === 'date') {
      const dateSettings = repeatableDateSettings(child);
      if (dateSettings.error) {
        errors.push({
          code: 'invalid_date_configuration',
          child_id: child.id,
          message: dateSettings.error,
        });
      }
    }
    const rowSourceValidation = validateRowSourceConfiguration(child, config.children);
    errors.push(...rowSourceValidation.errors);
    const rawChild = repeatableRowChildren(field)[index];
    if (rawChild?.exclude_values_from !== undefined) {
      const sourceId = child.exclude_values_from?.source_field_id;
      const eligible = repeatableExclusionSourceFields(rootFields, field, child);
      if (!sourceId || !eligible.some(source => String(source.id) === String(sourceId))) {
        errors.push({
          code: 'invalid_exclusion_source',
          child_id: child.id,
          message: 'An excluded-value source must be a compatible earlier form field',
        });
      }
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
      const directRowSource = isCustomObjectRowSource(child)
        && child.option_source.kind === 'records'
        && !parentId
        && !child.relationship_definition_id
        && !child.relationship_parent_kind
        && !child.relationship_parent_custom_object_id
        && !child.parent_custom_object_id;
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
      const parentDescriptor = parent?.option_source !== undefined
        && !isCustomObjectRowSource(parent)
        ? null
        : parent?.type === 'organisation_dropdown'
        ? { kind: 'organization', customObjectId: null }
        : parent?.type === 'organisation_group_dropdown'
          ? { kind: 'organization_group', customObjectId: null }
          : parent?.type === 'relationship_dropdown' && !isDistinctRowSource(parent)
            ? {
              kind: parent.related_kind || 'custom_object',
              customObjectId: (isCustomObjectRowSource(parent)
                ? parent.option_source.custom_object_id : null)
                || parent.related_custom_object_id || parent.custom_object_id || null,
            }
            : null;
      const expectedKind = child.relationship_parent_kind || null;
      const expectedObjectId = child.relationship_parent_custom_object_id
        || child.parent_custom_object_id || null;
      const descriptorMatches = parentDescriptor
        && (!expectedKind || parentDescriptor.kind === expectedKind)
        && (!expectedObjectId || (parentDescriptor.kind === 'custom_object'
          && String(parentDescriptor.customObjectId) === String(expectedObjectId)));
      if (!directRowSource && (!isValidScope || !precedesChild
          || !descriptorMatches)) {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'A relationship child must reference a compatible preceding parent' });
      }
      if (isDistinctRowSource(parent)) {
        errors.push({ code: 'invalid_dependency', child_id: child.id, message: 'A distinct scalar relationship child cannot be used as a relationship parent' });
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
  const visibilitySourceIds = repeatableRowVisibilitySourceIds(field);
  value.forEach((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ code: 'invalid_row', row: rowIndex, message: `Row ${rowIndex + 1} is invalid` });
      return;
    }
    for (const key of Object.keys(row)) {
      if (key !== '_row_id'
          && key !== REPEATABLE_NOT_LISTED_TEXT_KEY
          && key !== REPEATABLE_NOT_LISTED_LABELS_KEY
          && !childIds.has(key)) {
        errors.push({ code: 'unknown_child', row: rowIndex, child_id: key, message: `Row ${rowIndex + 1} contains an unsupported field` });
      }
    }
    if (row._row_id !== undefined) {
      if (typeof row._row_id !== 'string' || !row._row_id.trim()
          || row._row_id.length > 200 || rowIds.has(row._row_id)) {
        errors.push({ code: 'invalid_row_id', row: rowIndex, message: `Row ${rowIndex + 1} has an invalid row ID` });
      } else rowIds.add(row._row_id);
    }
    const hiddenChildIds = getRepeatableRowHiddenChildIds(field, row, {
      hiddenFieldIds: options.hiddenFieldIds,
      parentHidden: options.parentHidden,
    });
    for (const sourceId of visibilitySourceIds) {
      if (hiddenChildIds.has(sourceId)) continue;
      const source = config.children.find(child => child.id === sourceId);
      const sourceValue = row[sourceId];
      if (source && (Array.isArray(sourceValue)
          || (sourceValue !== null && typeof sourceValue === 'object'))) {
        errors.push({
          code: 'invalid_selection',
          row: rowIndex,
          child_id: sourceId,
          message: `${source.label || source.id} must contain one scalar selection`,
        });
      }
    }
    const visibleChildren = config.children.filter(child => !hiddenChildIds.has(child.id));
    const active = !isRepeatableRowEmpty(row, visibleChildren)
      || rowIndex < config.min_rows || (rowIndex === 0 && config.first_row_required);
    if (!active) return;
    for (const child of config.children) {
      if (hiddenChildIds.has(child.id)) continue;
      const selected = row[child.id];
      if (child.required && isRepeatableValueEmpty(selected)
          && !options.allowRequiredBlank?.({ child, row, rowIndex, field })) {
        errors.push({ code: 'required_child', row: rowIndex, child_id: child.id, message: `${child.label || child.id} is required in row ${rowIndex + 1}` });
        continue;
      }
      if (isRepeatableValueEmpty(selected)) continue;
      if (isCustomObjectRowSource(child)
          && (Array.isArray(selected) || selected === '__form_not_listed__')) {
        errors.push({
          code: 'invalid_selection',
          row: rowIndex,
          child_id: child.id,
          message: `${child.label || child.id} must contain one catalogue selection`,
        });
        continue;
      }
      if (Array.isArray(child.options) && child.options.length) {
        const allowed = new Set(child.options.map(optionValue).filter((item) => item != null).map(String));
        if (selectedValues(selected).some((item) => (
          !allowed.has(String(item))
          && !(typeof options.isAllowedSpecialSelection === 'function'
            && options.isAllowedSpecialSelection({ child, value: item, row, rowIndex, field }))
        ))) {
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
  for (const child of config.children) {
    if (!child.unique_across_rows) continue;
    const rowsByValue = new Map();
    value.forEach((row, rowIndex) => {
       const hiddenChildIds = getRepeatableRowHiddenChildIds(field, row, {
         hiddenFieldIds: options.hiddenFieldIds,
         parentHidden: options.parentHidden,
       });
       if (hiddenChildIds.has(child.id)) return;
      const selected = row?.[child.id];
      if (isRepeatableValueEmpty(selected)) return;
      const selections = child.type === 'relationship_dropdown'
        && child.selection_mode === 'multiple'
        && Array.isArray(selected)
        ? selected
        : [selected];
      selections.forEach((entry) => {
        const key = repeatableUniqueValueKey(entry, child);
        const matchingRows = rowsByValue.get(key) || [];
        matchingRows.push(rowIndex);
        rowsByValue.set(key, matchingRows);
      });
    });
    for (const matchingRows of rowsByValue.values()) {
      if (matchingRows.length < 2) continue;
      const rowLabels = matchingRows.map(index => index + 1);
      const message = `${child.label || child.id} must be unique; rows ${rowLabels.join(', ')} have the same value`;
      matchingRows.forEach(rowIndex => {
        errors.push({
          code: 'duplicate_child_value',
          row: rowIndex,
          child_id: child.id,
          conflicting_rows: rowLabels,
          message,
        });
      });
    }
  }
  return { valid: errors.length === 0, errors, rows: value, config };
}

export async function validateRepeatableRowsAsync(field, value, options = {}) {
  const basic = validateRepeatableRows(field, value, options);
  if (!basic.valid || typeof options.validateChildAsync !== 'function') return basic;
  const errors = [];
  for (let rowIndex = 0; rowIndex < basic.rows.length; rowIndex += 1) {
    const row = basic.rows[rowIndex];
    const hiddenChildIds = getRepeatableRowHiddenChildIds(field, row, {
      hiddenFieldIds: options.hiddenFieldIds,
      parentHidden: options.parentHidden,
    });
    const visibleChildren = basic.config.children.filter(child => !hiddenChildIds.has(child.id));
    const active = !isRepeatableRowEmpty(row, visibleChildren)
      || rowIndex < basic.config.min_rows || (rowIndex === 0 && basic.config.first_row_required);
    if (!active) continue;
    for (const child of basic.config.children) {
      if (hiddenChildIds.has(child.id)) continue;
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
