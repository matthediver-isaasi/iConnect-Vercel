import {
  applyInclusiveFormNotListedSelection,
  FORM_NOT_LISTED_VALUE,
  hasEnabledFormNotListedChoice,
} from './formNotListedChoice.js';

export const RELATIONSHIP_SELECTION_SINGLE = 'single';
export const RELATIONSHIP_SELECTION_MULTIPLE = 'multiple';

export function relationshipSelectionMode(field) {
  return ['multiple', 'multi', 'multiselect', 'multi_select'].includes(field?.selection_mode)
    ? RELATIONSHIP_SELECTION_MULTIPLE
    : RELATIONSHIP_SELECTION_SINGLE;
}

export function isRelationshipMultiSelect(field) {
  return field?.type === 'relationship_dropdown'
    && relationshipSelectionMode(field) === RELATIONSHIP_SELECTION_MULTIPLE;
}

export function emptyRelationshipSelection(field) {
  return isRelationshipMultiSelect(field) ? [] : '';
}

export function normalizeRelationshipSelection(field, value) {
  if (!isRelationshipMultiSelect(field)) {
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  }
  const entries = Array.isArray(value)
    ? value
    : (value == null || value === '' ? [] : [value]);
  const seen = new Set();
  return entries.filter((entry) => {
    if (entry == null || entry === '') return false;
    const key = String(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toggleRelationshipSelection(field, currentValue, optionValue) {
  if (!isRelationshipMultiSelect(field)) return optionValue;
  const current = normalizeRelationshipSelection(field, currentValue);
  if (optionValue === FORM_NOT_LISTED_VALUE) {
    return applyInclusiveFormNotListedSelection(current, optionValue);
  }
  return current.some(entry => String(entry) === String(optionValue))
    ? current.filter(entry => String(entry) !== String(optionValue))
    : [...current, optionValue];
}

export function reconcileRelationshipSelection({
  field,
  value,
  parentValue,
  previousParentValue,
  options,
  optionsLoaded = false,
}) {
  if (!isRelationshipMultiSelect(field)) return undefined;
  const current = normalizeRelationshipSelection(field, value);
  if (parentValue === FORM_NOT_LISTED_VALUE) {
    return hasEnabledFormNotListedChoice(field)
      ? (current.length === 1 && current[0] === FORM_NOT_LISTED_VALUE
        ? current
        : [FORM_NOT_LISTED_VALUE])
      : [];
  }
  if (!parentValue) return [];
  // While a new parent's options are loading, retain the current answer. Once
  // the authoritative result arrives, prune only members that are no longer
  // available instead of clearing the whole selection.
  if (!optionsLoaded) return current;
  const allowed = new Set((options || []).map(option => String(option?.id ?? option?.value ?? option)));
  return current.filter(entry => allowed.has(String(entry)));
}