import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';
import { isRelationshipMultiSelect } from '../../../shared/formRelationshipSelection.js';
import { projectConditionalSourceValues } from './formConditionalFilters.js';

export const CONDITIONAL_COPY_MODE_STORED_VALUE = 'stored_value';
export const CONDITIONAL_COPY_MODE_DISPLAY_NAME = 'display_name';

const RECORD_SELECTION_TYPES = new Set([
  'organisation_dropdown',
  'organisation_group_dropdown',
  'relationship_dropdown',
]);

export function isDisplayNameCopyMode(action) {
  return action?.set_value_source === 'field'
    && action?.copy_mode === CONDITIONAL_COPY_MODE_DISPLAY_NAME;
}

export function isSupportedDisplayNameCopySource(field) {
  return Boolean(
    field
    && RECORD_SELECTION_TYPES.has(field.type)
    // A row value is not an unambiguous top-level answer. Row-copy support,
    // including label joining, is deliberately outside this first version.
    && !field.repeatable_container_field_id
    // Custom-object row/distinct sources have a different authorization and
    // value contract. They are intentionally not record-display copy sources.
    && field.option_source === undefined
    && !isRelationshipMultiSelect(field),
  );
}

export function isSupportedDisplayNameCopyTarget(field) {
  return field?.type === 'text' || field?.type === 'textarea';
}

function savedValue(values, fields, fieldId) {
  const field = fields.find(candidate => String(candidate?.id) === String(fieldId));
  return values?.[field?.id] ?? (field?.name ? values?.[field.name] : undefined);
}

// This contains exactly the answer context which can alter a top-level
// picker's authorised option list. A response from a former parent/filter
// scope must never be reused merely because it happens to contain the same ID.
export function recordSelectionOptionScope(field, fields = [], values = {}) {
  if (!field) return '';
  const conditionalSources = projectConditionalSourceValues({ field, fields, values });
  const relationshipParent = field.type === 'relationship_dropdown'
    ? savedValue(values, fields, field.parent_field_id)
    : null;
  return JSON.stringify({
    type: field.type,
    conditionalSources,
    relationshipParent: relationshipParent ?? null,
  });
}

export function displayNameCopyConfigurationError(action, fields = []) {
  if (action?.set_value_source === 'field'
    && action?.copy_mode != null
    && ![CONDITIONAL_COPY_MODE_STORED_VALUE, CONDITIONAL_COPY_MODE_DISPLAY_NAME].includes(action.copy_mode)) {
    return 'Conditional field copy mode must be Stored value or Selected record display name.';
  }
  if (!isDisplayNameCopyMode(action)) return null;
  const source = fields.find(field => String(field?.id) === String(action.set_value_field_id));
  const target = fields.find(field => String(field?.id) === String(action.target_field_id));
  if (!isSupportedDisplayNameCopySource(source)) {
    return 'Selected record display name requires a top-level single-select Organisation, Organisation group, or relationship source.';
  }
  if (!isSupportedDisplayNameCopyTarget(target)) {
    return 'Selected record display name can only be copied into a text or textarea field.';
  }
  return null;
}

/**
 * Resolves a label only from the option list already authorised for this
 * respondent. It intentionally never looks up a record by ID: a missing,
 * loading, filtered-out, or failed option is not a safe display name.
 */
export function resolveDisplayNameCopyValue({ action, fields = [], values = {}, optionStates = {} }) {
  if (!isDisplayNameCopyMode(action)) return null;
  const configurationError = displayNameCopyConfigurationError(action, fields);
  if (configurationError) return { state: 'unavailable', value: '', error: configurationError };

  const sourceId = action.set_value_field_id;
  const source = fields.find(field => String(field?.id) === String(sourceId));
  const selected = values?.[sourceId];
  if (selected === FORM_NOT_LISTED_VALUE || Array.isArray(selected)) {
    return { state: 'unavailable', value: '' };
  }
  if (selected == null || selected === '') {
    return { state: 'empty', value: '' };
  }
  const optionState = optionStates?.[sourceId];
  if (!optionState || optionState.status === 'pending') return { state: 'pending', value: '' };
  if (optionState.scope !== recordSelectionOptionScope(source, fields, values)) {
    return { state: 'pending', value: '' };
  }
  if (optionState.status !== 'resolved') return { state: 'unavailable', value: '' };

  const option = (optionState.options || []).find(candidate => (
    String(candidate?.id ?? candidate?.value) === String(selected)
  ));
  const label = option?.label ?? option?.name ?? option?.display_label;
  if (typeof label !== 'string' || !label.trim()) return { state: 'unavailable', value: '' };
  return { state: 'resolved', value: label };
}

export function activeDisplayNameCopyIssues({ rules = [], fields = [], values = {}, optionStates = {}, evaluateRule }) {
  const issues = [];
  for (const rule of rules) {
    if (!evaluateRule?.(rule, values)) continue;
    const actions = Array.isArray(rule.actions)
      ? rule.actions
      : ((rule?.rule_type === 'set_value' || rule?.action === 'set_value') ? [rule] : []);
    for (const action of actions) {
      const result = resolveDisplayNameCopyValue({ action, fields, values, optionStates });
      const target = fields.find(field => String(field?.id) === String(action.target_field_id));
      const targetValue = target ? savedValue(values, fields, target.id) : undefined;
      if (result && (
        result.state === 'pending'
        || result.state === 'unavailable'
        || ((result.state === 'resolved' || result.state === 'empty') && targetValue !== result.value)
      )) {
        issues.push({ action, ...result });
      }
    }
  }
  return issues;
}