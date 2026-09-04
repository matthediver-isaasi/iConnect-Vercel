export const FORM_MAPPING_FALLBACK_VERSION = 1;

export function isExplicitFallbackMapping(mapping) {
  return mapping?.fallback_group?.version === FORM_MAPPING_FALLBACK_VERSION
    && typeof mapping.fallback_group.id === 'string'
    && mapping.fallback_group.id.trim() !== '';
}

export function mappingTargetKey(mapping) {
  const target = mapping?.target_field_id ?? mapping?.target_field;
  return `${mapping?.target_entity || ''}:${mapping?.target_type || 'core'}:${target || ''}`;
}

export function isFallbackValueEmpty(value) {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

export function rawMappingValue(mapping, values) {
  if (mapping?.source_type === 'clear') return '__clear__';
  if (mapping?.source_type === 'current_date' || mapping?.transformation === 'current_date') {
    return '__current_date__';
  }
  if (mapping?.source_type === 'static'
    || (!mapping?.source_field_id && mapping?.static_value !== undefined)) {
    return mapping.static_value;
  }
  let value = values?.[mapping?.source_field_id];
  if (mapping?.source_component !== undefined) {
    value = value && typeof value === 'object' && !Array.isArray(value)
      ? value[mapping.source_component]
      : undefined;
  }
  if (mapping?.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
    value = value[mapping.source_category_id];
  }
  return value;
}

function candidateValue(mapping, values) {
  const value = rawMappingValue(mapping, values);
  if (value == null || value === '__clear__' || value === '__current_date__') return value;
  const transformation = mapping?.transformation;
  if (!transformation || transformation === 'none') return value;
  const text = String(value);
  if (transformation === 'trim') return text.trim();
  if (transformation === 'lowercase') return text.toLowerCase();
  if (transformation === 'uppercase') return text.toUpperCase();
  if (transformation === 'remove_spaces') return text.replace(/\s/g, '');
  if (transformation === 'numbers_only') return text.replace(/\D/g, '');
  return value;
}

/**
 * Legacy mappings are returned byte-for-byte and in their original order.
 * Explicit fallback groups are replaced, at their first position, by their
 * first visible, present, non-empty candidate (or an explicit clear).
 */
export function coalesceExplicitFallbackMappings(mappings, values, hiddenFieldIds = new Set()) {
  if (!Array.isArray(mappings) || !mappings.some(isExplicitFallbackMapping)) return mappings;
  const winners = new Map();
  for (const mapping of mappings) {
    if (!isExplicitFallbackMapping(mapping)) continue;
    const groupId = mapping.fallback_group.id;
    if (winners.has(groupId)) continue;
    const sourceId = mapping.source_field_id == null ? null : String(mapping.source_field_id);
    if (sourceId && hiddenFieldIds.has(sourceId)) continue;
    const present = mapping.source_type === 'clear'
      || mapping.source_type === 'current_date'
      || mapping.transformation === 'current_date'
      || mapping.source_type === 'static'
      || (!mapping.source_field_id && mapping.static_value !== undefined)
      || (sourceId && Object.prototype.hasOwnProperty.call(values || {}, sourceId));
    if (!present) continue;
    const value = candidateValue(mapping, values);
    if (value === '__clear__' || value === '__current_date__' || !isFallbackValueEmpty(value)) winners.set(groupId, mapping);
  }
  const emitted = new Set();
  const result = [];
  for (const mapping of mappings) {
    if (!isExplicitFallbackMapping(mapping)) {
      result.push(mapping);
      continue;
    }
    const groupId = mapping.fallback_group.id;
    if (emitted.has(groupId)) continue;
    emitted.add(groupId);
    const winner = winners.get(groupId);
    if (winner) result.push(winner);
  }
  return result;
}

export function validateExplicitFallbackGroups(mappings) {
  const errors = [];
  const groups = new Map();
  const counts = new Map();
  const targetOwners = new Map();
  for (const mapping of mappings || []) {
    if (mapping?.fallback_group == null) continue;
    if (!isExplicitFallbackMapping(mapping)) {
      errors.push('fallback_group must have version 1 and a non-empty id');
      continue;
    }
    const id = mapping.fallback_group.id;
    const target = mappingTargetKey(mapping);
    if (groups.has(id) && groups.get(id) !== target) {
      errors.push(`fallback group ${id} must map every source to the same destination`);
    } else {
      groups.set(id, target);
    }
    counts.set(id, (counts.get(id) || 0) + 1);
    if (targetOwners.has(target) && targetOwners.get(target) !== id) {
      errors.push(`destination ${target} cannot belong to more than one fallback group`);
    } else {
      targetOwners.set(target, id);
    }
  }
  for (const mapping of mappings || []) {
    if (isExplicitFallbackMapping(mapping)) continue;
    const target = mappingTargetKey(mapping);
    if (targetOwners.has(target)) {
      errors.push(`destination ${target} cannot mix fallback and legacy mappings`);
    }
  }
  for (const [id, count] of counts) {
    if (count < 2) errors.push(`fallback group ${id} must contain at least two mappings`);
  }
  return errors;
}

export function assertValidExplicitFallbackGroups(mappings) {
  const errors = validateExplicitFallbackGroups(mappings);
  if (errors.length) {
    const error = new Error(`Invalid fallback mapping contract: ${errors.join('; ')}`);
    error.code = 'INVALID_FORM_MAPPING_FALLBACK';
    error.details = errors;
    throw error;
  }
}