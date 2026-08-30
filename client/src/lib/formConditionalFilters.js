import { resolveCountryToIso2 } from '../../../shared/countries.js';

function primitive(value) {
  if (value != null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return primitive(value.value);
  }
  return value;
}

export function normalizeConditionalValue(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map(primitive)
    .filter((item) => item !== undefined && item !== null);
}

function comparable(value) {
  if (typeof value === 'string') return value.toLowerCase();
  return value;
}

function overlaps(left, right) {
  return left.some((item) => right.some((candidate) => comparable(item) === comparable(candidate)));
}

function isCountrySourceField(sourceField) {
  if (['country', 'countries'].includes(sourceField?.type)) return true;
  if (sourceField?.type !== 'custom_field') return false;
  const inferredType = sourceField.custom_field_type
    || sourceField.field_type
    || sourceField.custom_field?.field_type
    || sourceField.custom_field_definition?.field_type;
  return ['country', 'countries'].includes(inferredType);
}

function sourceComparison(sourceField) {
  return isCountrySourceField(sourceField) ? 'country' : undefined;
}

function normalizeForSourceField(value, sourceField, { source = false } = {}) {
  if (
    sourceField?.type === 'communication_preferences'
    && value
    && typeof value === 'object'
    && !Array.isArray(value)
  ) {
    return Object.entries(value)
      .filter(([, subscribed]) => !source || subscribed === true)
      .map(([categoryId]) => categoryId);
  }
  const normalized = normalizeConditionalValue(value);
  if (isCountrySourceField(sourceField)) {
    return normalized.map((item) => resolveCountryToIso2(item) || item);
  }
  return normalized;
}

export function conditionalRuleMatches(rule, sourceValue, sourceField = null) {
  const source = normalizeForSourceField(sourceValue, sourceField, { source: true });
  const expected = normalizeForSourceField(rule?.value, sourceField);
  switch (rule?.operator) {
    case 'is_empty':
      return source.length === 0 || source.every((item) => item === '');
    case 'is_not_empty':
      return source.length > 0 && source.some((item) => item !== '');
    case 'equals':
    case 'in':
      return overlaps(source, expected);
    case 'not_equals':
    case 'not_in':
      return !overlaps(source, expected);
    case 'includes':
      if (sourceField?.type === 'communication_preferences') return overlaps(source, expected);
      return source.some((item) => (
        Array.isArray(item)
          ? overlaps(item, expected)
          : expected.some((candidate) => String(item).includes(String(candidate)))
      ));
    case 'not_includes':
      return !conditionalRuleMatches({ ...rule, operator: 'includes' }, sourceValue, sourceField);
    case 'greater_than':
      return source.some((item) => expected.some((candidate) => Number(item) > Number(candidate)));
    case 'greater_or_equal':
      return source.some((item) => expected.some((candidate) => Number(item) >= Number(candidate)));
    case 'less_than':
      return source.some((item) => expected.some((candidate) => Number(item) < Number(candidate)));
    case 'less_or_equal':
      return source.some((item) => expected.some((candidate) => Number(item) <= Number(candidate)));
    default:
      return false;
  }
}

function sourceValue(values, fields, id) {
  if (!values || typeof values !== 'object') return undefined;
  if (values[id] !== undefined) return values[id];
  const source = (Array.isArray(fields) ? fields : []).find((item) => item?.id === id);
  return source?.name != null ? values[source.name] : undefined;
}

const SUPPORTED_OPERATORS = new Set([
  'equals', 'not_equals', 'includes', 'not_includes', 'in', 'not_in',
  'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal',
  'is_empty', 'is_not_empty',
]);
const FILTER_MODES = new Set(['include', 'exclude']);

function filterMode(value) {
  return value === undefined ? 'include' : (FILTER_MODES.has(value) ? value : null);
}

function validRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  const required = [
    'id', 'source_field_id', 'operator', 'value', 'is_fallback', 'allowed_values', 'org_filter',
  ];
  if (!required.every((key) => Object.prototype.hasOwnProperty.call(rule, key))) return false;
  if (!rule.id || typeof rule.id !== 'string') return false;
  if (typeof rule.is_fallback !== 'boolean') return false;
  if (!SUPPORTED_OPERATORS.has(rule.operator)) return false;
  if (!rule.is_fallback && (!rule.source_field_id || typeof rule.source_field_id !== 'string')) return false;
  if (!Array.isArray(rule.allowed_values)) return false;
  if (filterMode(rule.allowed_values_mode) === null) return false;
  return rule.org_filter == null
    || (
      typeof rule.org_filter === 'object'
      && !Array.isArray(rule.org_filter)
      && ['core', 'custom'].includes(rule.org_filter.type)
      && typeof rule.org_filter.field === 'string'
      && rule.org_filter.field.length > 0
      && Array.isArray(rule.org_filter.values)
      && (rule.org_filter.value_source === undefined
        || ['fixed', 'source'].includes(rule.org_filter.value_source))
      && (rule.org_filter.value_source !== 'source' || rule.is_fallback !== true)
      && filterMode(rule.org_filter.mode) !== null
    );
}

export function projectConditionalSourceValues({ field, fields = [], values = {} }) {
  const config = field?.conditional_filters;
  const projection = {};
  const groupParentId = field?.type === 'organisation_dropdown'
    ? field.organisation_group_parent_field_id
    : null;
  if (groupParentId) {
    projection[groupParentId] = sourceValue(values, fields, groupParentId) ?? null;
  }
  if (config?.version === 1 && Array.isArray(config.rules) && config.rules.every(validRule)) {
    for (const rule of config.rules) {
      if (rule.is_fallback || !rule.source_field_id) continue;
      projection[rule.source_field_id] = sourceValue(values, fields, rule.source_field_id) ?? null;
    }
  }
  return projection;
}

export function resolveConditionalFilters({ field, fields = [], values = {} }) {
  const config = field?.conditional_filters;
  const hasConfig = config !== undefined && config !== null;
  if (hasConfig && (
    typeof config !== 'object'
    || Array.isArray(config)
    || config.version !== 1
    || !Array.isArray(config.rules)
    || !config.rules.every(validRule)
  )) {
    return {
      configured: true,
      valid: false,
      matchedRule: null,
      allowedValues: [],
      excludedValues: [],
      targetMode: 'include',
      orgFilter: null,
    };
  }
  const rules = config?.rules || [];
  if (rules.length === 0) {
    return { configured: false, valid: true, matchedRule: null, allowedValues: null, excludedValues: [], targetMode: 'include', orgFilter: null };
  }
  const matchedRule = rules.find((rule) => (
    !rule?.is_fallback
    && conditionalRuleMatches(
      rule,
      sourceValue(values, fields, rule?.source_field_id),
      {
        ...fields.find((candidate) => candidate?.id === rule?.source_field_id),
        ...(rule?.source_field_type ? { custom_field_type: rule.source_field_type } : {}),
      },
    )
  )) || rules.find((rule) => rule?.is_fallback) || null;
  const matchedSourceField = matchedRule
    ? fields.find((candidate) => candidate?.id === matchedRule.source_field_id)
    : null;
  const matchedSourceDefinition = {
    ...matchedSourceField,
    ...(matchedRule?.source_field_type
      ? { custom_field_type: matchedRule.source_field_type }
      : {}),
  };
  const matchedSourceComparison = sourceComparison(matchedSourceDefinition);
  const { comparison: _ignoredComparison, ...savedOrgFilter } = matchedRule?.org_filter || {};
  const resolvedOrgFilter = matchedRule?.org_filter
    ? {
      ...savedOrgFilter,
      values: matchedRule.org_filter.value_source === 'source'
        ? normalizeForSourceField(
          sourceValue(values, fields, matchedRule.source_field_id),
          matchedSourceDefinition,
          { source: true },
        ).filter((item) => item !== '')
        : matchedRule.org_filter.values,
      ...(matchedRule.org_filter.value_source === 'source' && matchedSourceComparison
        ? { comparison: matchedSourceComparison }
        : {}),
    }
    : null;
  return {
    configured: true,
    valid: true,
    matchedRule,
    allowedValues: matchedRule && Array.isArray(matchedRule.allowed_values)
      ? normalizeConditionalValue(matchedRule.allowed_values)
      : [],
    excludedValues: filterMode(matchedRule?.allowed_values_mode) === 'exclude'
      ? normalizeConditionalValue(matchedRule?.allowed_values || [])
      : [],
    targetMode: filterMode(matchedRule?.allowed_values_mode) || 'include',
    orgFilter: resolvedOrgFilter,
  };
}

export function intersectConditionalOptions(options, resolution, getValue = (option) => (
  option != null && typeof option === 'object' ? option.value ?? option.id ?? option.code ?? option.name : option
)) {
  const list = Array.isArray(options) ? options : [];
  if (!resolution?.configured) return list;
  if (!resolution.matchedRule) return [];
  const allowed = resolution.allowedValues || [];
  if (allowed.length === 0) return list;
  return list.filter((option) => {
    const matches = overlaps(normalizeConditionalValue(getValue(option)), allowed);
    return resolution.targetMode === 'exclude' ? !matches : matches;
  });
}

export function removeInvalidConditionalValue(value, options, getValue) {
  const allowed = new Set((options || []).flatMap((option) => (
    normalizeConditionalValue(getValue ? getValue(option) : option).map(comparable)
  )));
  if (Array.isArray(value)) {
    const next = value.filter((item) => allowed.has(comparable(primitive(item))));
    return next.length === value.length ? value : next;
  }
  if (value == null || value === '') return value;
  return allowed.has(comparable(primitive(value))) ? value : '';
}

export function applyOrganizationFilter(organizations, filter) {
  if (filter?.mode !== undefined && !FILTER_MODES.has(filter.mode)) return [];
  if (!filter?.field || !Array.isArray(filter.values)) return [];
  if (filter.values.length === 0) {
    return Array.isArray(organizations) ? organizations : [];
  }
  const compare = filter.comparison === 'country'
    ? (value) => comparable(resolveCountryToIso2(value) || value)
    : comparable;
  const allowed = filter.values.map(compare);
  return (organizations || []).filter((organization) => {
    const raw = filter.type === 'custom'
      ? organization?.custom_fields?.[filter.field]
        ?? organization?.custom_field_values?.[filter.field]
        ?? organization?.[filter.field]
      : organization?.[filter.field];
    const values = normalizeConditionalValue(raw).filter((item) => (
      typeof item !== 'string' || item.trim().length > 0
    ));
    if (values.length === 0) return false;
    const matches = values.some((item) => allowed.includes(compare(item)));
    return filter.mode === 'exclude' ? !matches : matches;
  });
}

function organizationFilterValue(value) {
  const raw = value && typeof value === 'object'
    ? value.value ?? value.id ?? value.name ?? value.label
    : value;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return String(raw).trim();
}

export function configuredOrganizationFilterOptions(fieldType, fieldName, customFields = []) {
  if (fieldType !== 'custom' || !fieldName) return [];
  const field = customFields.find((candidate) => (
    candidate?.name === fieldName && candidate?.entity_scope === 'organization'
  ));
  if (!field) return [];
  const configured = Array.isArray(field.options) ? field.options
    : (Array.isArray(field.choices) ? field.choices : []);
  const seen = new Set();
  return configured.flatMap((option) => {
    const value = organizationFilterValue(option);
    if (value === null || seen.has(value)) return [];
    seen.add(value);
    return [{
      value,
      label: option && typeof option === 'object'
        ? String(option.label ?? option.name ?? value)
        : value,
    }];
  });
}

export function mergeOrganizationFilterOptions(availableValues = [], selectedValues = []) {
  const options = [];
  const seen = new Set();
  for (const item of availableValues) {
    const value = organizationFilterValue(item);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: item && typeof item === 'object'
        ? String(item.label ?? item.name ?? value)
        : value,
    });
  }
  for (const item of selectedValues) {
    const value = organizationFilterValue(item);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: `${value} (unavailable)`, unavailable: true });
  }
  return options;
}