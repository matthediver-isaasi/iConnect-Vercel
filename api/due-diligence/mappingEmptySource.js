import { computeHiddenFieldIds } from '../_lib/formFieldVisibility.js';

// Empty answers are not clearing instructions. Keep false and zero as values.
export function isEmptyMappingAnswer(value) {
  return value == null
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function classifyEmptyMappingSource(mapping, value, {
  sourceForm = {},
  answers = {},
  explicitEmpty = false,
} = {}) {
  if (explicitEmpty || !isEmptyMappingAnswer(value)) return null;
  const attention = (reason) => ({ status: 'requires_attention', reason });
  if (mapping?.source_type === 'static') return attention('Static source value is empty');
  const field = sourceForm.fields?.find((candidate) => candidate && [
    candidate.id, candidate.name, candidate.key,
  ].includes(mapping?.source_field_id) && mapping?.source_field_id);
  if (!field) return attention('Source field definition is missing');
  // Match the persisted-form requiredness contract: unknown flags and future
  // conditional-required metadata fail closed, never imply optional.
  const conditional = ['conditional_required', 'required_if', 'required_when',
    'required_conditions', 'required_rules'].some((key) => field[key] != null);
  if (conditional) return attention('Conditional source requiredness cannot be confirmed');
  const hidden = computeHiddenFieldIds(sourceForm, answers).has(field.id);
  const required = [field.required, field.is_required]
    .some((flag) => flag != null && flag !== false);
  if (required && !hidden) return attention('Required source value is empty');
  return { status: 'skipped', reason: hidden ? 'Hidden source value is empty' : 'Optional source value is empty' };
}

export function summarizeMappingResults(mappings) {
  const counts = { applied_count: 0, skipped_count: 0, attention_count: 0, noop_count: 0 };
  for (const mapping of mappings) {
    if (['error', 'failed', 'partial', 'requires_attention'].includes(mapping.status)) counts.attention_count++;
    else if (mapping.status === 'skipped') counts.skipped_count++;
    else if (mapping.status === 'noop') counts.noop_count++;
    else if (['updated', 'created'].includes(mapping.status)) counts.applied_count++;
  }
  return {
    status: counts.attention_count ? 'partial' : 'success',
    history: { mappings_count: counts.applied_count, ...counts },
  };
}