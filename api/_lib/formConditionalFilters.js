import { resolveCountryToIso2 } from '../../shared/countries.js';
import { FORM_NOT_LISTED_VALUE, hasEnabledFormNotListedChoice } from '../../shared/formNotListedChoice.js';

const OPERATORS = new Set([
  'equals', 'not_equals', 'includes', 'not_includes', 'in', 'not_in',
  'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal',
  'is_empty', 'is_not_empty',
]);
const FILTER_MODES = new Set(['include', 'exclude']);

function filterMode(value) {
  return value === undefined ? 'include' : (FILTER_MODES.has(value) ? value : null);
}

function unwrap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return unwrap(value.value);
  }
  return value;
}

export function normalizeConditionalValue(value) {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) return unwrapped.flatMap((item) => {
    const normalized = normalizeConditionalValue(item);
    return Array.isArray(normalized) ? normalized : [normalized];
  });
  return unwrapped;
}

function values(value) {
  const normalized = normalizeConditionalValue(value);
  return Array.isArray(normalized) ? normalized : [normalized];
}

function isCountryField(field) {
  if (field?.type === 'country' || field?.type === 'countries') return true;
  if (field?.type !== 'custom_field') return false;
  const persistedType = field.custom_field_type
    || field.field_type
    || field.custom_field?.field_type
    || field.custom_field_definition?.field_type;
  return persistedType === 'country' || persistedType === 'countries';
}

function fieldValues(field, value, { source = false } = {}) {
  if (field?.type === 'communication_preferences' && value
      && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .filter(([, subscribed]) => !source || subscribed === true)
      .map(([categoryId]) => categoryId);
  }
  const normalized = values(value);
  if (isCountryField(field)) {
    return normalized.map((item) => resolveCountryToIso2(item) || item);
  }
  return normalized;
}

function key(value) {
  if (value === null) return 'null:';
  if (value === undefined) return 'undefined:';
  if (typeof value === 'object') {
    try { return `object:${JSON.stringify(value)}`; } catch { return 'object:'; }
  }
  return `${typeof value}:${String(value)}`;
}

function same(left, right) {
  if (key(left) === key(right)) return true;
  // Persisted select values commonly cross the JSON/string boundary (for
  // example numeric IDs and boolean option values).
  if (left == null || right == null) return false;
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return String(left) === String(right);
}

function empty(value) {
  const normalized = normalizeConditionalValue(value);
  return normalized === undefined || normalized === null || normalized === ''
    || (Array.isArray(normalized) && normalized.length === 0);
}

function overlap(left, right) {
  const rightValues = values(right);
  return values(left).some((candidate) => rightValues.some((expected) => same(candidate, expected)));
}

function numericCompare(left, right, predicate) {
  const expectedNumbers = values(right).map(Number).filter(Number.isFinite);
  return values(left).some((candidate) => {
    const number = Number(candidate);
    return Number.isFinite(number)
      && expectedNumbers.some((expectedNumber) => predicate(number, expectedNumber));
  });
}

export function conditionalRuleMatches(rule, sourceValue, sourceField = null) {
  const normalizedSource = fieldValues(sourceField, sourceValue, { source: true });
  const normalizedRule = { ...rule, value: fieldValues(sourceField, rule?.value) };
  switch (rule?.operator) {
    case 'equals': return overlap(normalizedSource, normalizedRule.value);
    case 'not_equals': return !overlap(normalizedSource, normalizedRule.value);
    case 'includes': {
      if (Array.isArray(normalizeConditionalValue(sourceValue)) || sourceField?.type === 'communication_preferences') {
        return overlap(normalizedSource, normalizedRule.value);
      }
      const source = normalizedSource[0];
      return normalizedRule.value.some((expected) => String(source ?? '').includes(String(expected ?? '')));
    }
    case 'not_includes': return !conditionalRuleMatches({ ...rule, operator: 'includes' }, sourceValue, sourceField);
    case 'in': return overlap(normalizedSource, normalizedRule.value);
    case 'not_in': return !overlap(normalizedSource, normalizedRule.value);
    case 'greater_than': return numericCompare(normalizedSource, normalizedRule.value, (a, b) => a > b);
    case 'greater_or_equal': return numericCompare(normalizedSource, normalizedRule.value, (a, b) => a >= b);
    case 'less_than': return numericCompare(normalizedSource, normalizedRule.value, (a, b) => a < b);
    case 'less_or_equal': return numericCompare(normalizedSource, normalizedRule.value, (a, b) => a <= b);
    case 'is_empty':
      return sourceField?.type === 'communication_preferences'
        ? normalizedSource.length === 0 : empty(sourceValue);
    case 'is_not_empty':
      return sourceField?.type === 'communication_preferences'
        ? normalizedSource.length > 0 : !empty(sourceValue);
    default: return false;
  }
}

function validOrgFilter(filter) {
  if (filter == null) return true;
  return filter && typeof filter === 'object' && !Array.isArray(filter)
    && (filter.type === 'core' || filter.type === 'custom')
    && typeof filter.field === 'string' && filter.field.length > 0
    && Array.isArray(filter.values)
    && (filter.value_source === undefined || filter.value_source === 'fixed' || filter.value_source === 'source')
    && filterMode(filter.mode) !== null;
}

export function validateConditionalFilters(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['conditional_filters must be an object'] };
  }
  if (config.version !== 1) errors.push('conditional_filters.version must be 1');
  if (!Array.isArray(config.rules)) errors.push('conditional_filters.rules must be an array');
  else config.rules.forEach((rule, index) => {
    const at = `conditional_filters.rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof rule.id !== 'string' || !rule.id) errors.push(`${at}.id is required`);
    for (const property of [
      'source_field_id', 'operator', 'value', 'is_fallback', 'allowed_values', 'org_filter',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(rule, property)) errors.push(`${at}.${property} is required`);
    }
    if (typeof rule.is_fallback !== 'boolean') errors.push(`${at}.is_fallback must be boolean`);
    if (!rule.is_fallback) {
      if (typeof rule.source_field_id !== 'string' || !rule.source_field_id) {
        errors.push(`${at}.source_field_id is required`);
      }
      if (!OPERATORS.has(rule.operator)) errors.push(`${at}.operator is unsupported`);
    }
    if (!Array.isArray(rule.allowed_values)) errors.push(`${at}.allowed_values must be an array`);
    if (filterMode(rule.allowed_values_mode) === null) {
      errors.push(`${at}.allowed_values_mode must be include or exclude`);
    }
    if (!validOrgFilter(rule.org_filter)
        || (rule?.org_filter?.value_source === 'source' && rule.is_fallback)) {
      errors.push(`${at}.org_filter is invalid`);
    }
  });
  return { valid: errors.length === 0, errors };
}

function submittedValue(submissionData, fieldId, fields) {
  if (Object.prototype.hasOwnProperty.call(submissionData || {}, fieldId)) return submissionData[fieldId];
  const source = (fields || []).find((field) => String(field?.id) === String(fieldId));
  return source?.name ? submissionData?.[source.name] : undefined;
}

function baseAllowedValues(field) {
  if (field?.type === 'communication_preferences'
      && Array.isArray(field.allowed_category_ids)) {
    return field.allowed_category_ids.length > 0
      ? fieldValues(field, field.allowed_category_ids)
      : null;
  }
  const configured = Array.isArray(field?.options) ? field.options
    : (Array.isArray(field?.choices) ? field.choices : null);
  if (!configured) return null;
  if (
    configured.length === 0
    && (field?.type === 'organisation_dropdown' || field?.type === 'relationship_dropdown')
  ) {
    return null;
  }
  const values = fieldValues(field, configured);
  return hasEnabledFormNotListedChoice(field) ? [...values, FORM_NOT_LISTED_VALUE] : values;
}

export function resolveConditionalFilter(field, submissionData = {}, fields = []) {
  const config = field?.conditional_filters;
  if (config === undefined || config === null) {
    return { configured: false, rule: null, allowedValues: null, excludedValues: [], targetMode: 'include', orgFilter: null, valid: true };
  }
  const validation = validateConditionalFilters(config);
  if (!validation.valid) {
    return { configured: true, rule: null, allowedValues: [], excludedValues: [], targetMode: 'include', orgFilter: null, valid: false, errors: validation.errors };
  }
  if (config.rules.length === 0) {
    return { configured: false, rule: null, allowedValues: null, excludedValues: [], targetMode: 'include', orgFilter: null, valid: true };
  }
  let matched = config.rules.find((rule) => !rule.is_fallback && conditionalRuleMatches(
    rule,
    submittedValue(submissionData, rule.source_field_id, fields),
    {
      ...fields.find((candidate) => String(candidate?.id) === String(rule.source_field_id)),
      ...(rule.source_field_type ? { custom_field_type: rule.source_field_type } : {}),
    },
  ));
  if (!matched) matched = config.rules.find((rule) => rule.is_fallback) || null;
  if (!matched) {
    return { configured: true, rule: null, allowedValues: [], excludedValues: [], targetMode: 'include', orgFilter: null, valid: true };
  }
  const ruleAllowed = fieldValues(field, matched.allowed_values);
  const base = baseAllowedValues(field);
  const targetMode = filterMode(matched.allowed_values_mode) || 'include';
  const matchedSourceField = {
    ...fields.find((candidate) => String(candidate?.id) === String(matched.source_field_id)),
    ...(matched.source_field_type ? { custom_field_type: matched.source_field_type } : {}),
  };
  const resolvedOrgFilter = matched.org_filter
    ? {
      ...matched.org_filter,
      values: matched.org_filter.value_source === 'source'
        ? fieldValues(
          matchedSourceField,
          submittedValue(submissionData, matched.source_field_id, fields),
          { source: true },
        ).filter((item) => !empty(item))
        : matched.org_filter.values,
    }
    : null;
  // A matched empty list adds no extra restriction. When the field has a
  // locally persisted base set, that base remains authoritative; otherwise
  // null tells dynamic validators to enforce their existing eligibility rules.
  const allowedValues = ruleAllowed.length === 0
    ? base
    : targetMode === 'exclude'
      ? (base === null
        ? null
        : base.filter((candidate) => !ruleAllowed.some((excluded) => same(candidate, excluded))))
    : (base === null
      ? ruleAllowed
      : ruleAllowed.filter((candidate) => base.some((baseValue) => same(candidate, baseValue))));
  return {
    configured: true,
    rule: matched,
    allowedValues,
    excludedValues: targetMode === 'exclude' ? ruleAllowed : [],
    targetMode,
    orgFilter: resolvedOrgFilter,
    targetField: field,
    valid: true,
  };
}

export function conditionalSelectionAllowed(selection, resolution) {
  if (!resolution?.configured) return true;
  if (empty(selection)) return true;
  const selectedValues = fieldValues(resolution.targetField, selection);
  if ((resolution.excludedValues || []).some(
    (excluded) => selectedValues.some((selected) => same(selected, excluded)),
  )) return false;
  if (resolution.allowedValues === null && resolution.rule) return true;
  const allowed = resolution.allowedValues || [];
  return selectedValues
    .every((selected) => allowed.some((candidate) => same(selected, candidate)));
}