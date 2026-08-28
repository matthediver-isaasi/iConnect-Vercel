export const FORM_NOT_LISTED_VALUE = '__form_not_listed__';
export const FORM_NOT_LISTED_LABELS_KEY = '__not_listed_choice_labels';

export const FORM_NOT_LISTED_FIELD_TYPES = new Set([
  'organisation_dropdown',
  'relationship_dropdown',
  'category_dropdown',
  'category_multiselect',
  'country',
  'countries',
]);

export function supportsFormNotListedChoice(field) {
  return FORM_NOT_LISTED_FIELD_TYPES.has(field?.type);
}

export function formNotListedChoiceLabel(field, { requireEnabled = true } = {}) {
  if (!supportsFormNotListedChoice(field)) return '';
  const config = field?.not_listed_choice;
  if (requireEnabled && config?.enabled !== true) return '';
  return typeof config?.label === 'string' ? config.label.trim() : '';
}

export function hasEnabledFormNotListedChoice(field) {
  return formNotListedChoiceLabel(field) !== '';
}

export function isFormNotListedValue(value) {
  return value === FORM_NOT_LISTED_VALUE;
}

export function containsFormNotListedValue(value) {
  return Array.isArray(value)
    ? value.some(isFormNotListedValue)
    : isFormNotListedValue(value);
}

export function applyExclusiveFormNotListedSelection(currentValue, nextValue) {
  const current = Array.isArray(currentValue) ? currentValue : [];
  if (nextValue === FORM_NOT_LISTED_VALUE) {
    return current.includes(FORM_NOT_LISTED_VALUE) ? [] : [FORM_NOT_LISTED_VALUE];
  }
  const withoutNotListed = current.filter(value => value !== FORM_NOT_LISTED_VALUE);
  return withoutNotListed.includes(nextValue)
    ? withoutNotListed.filter(value => value !== nextValue)
    : [...withoutNotListed, nextValue];
}

export function prependFormNotListedOption(field, options, createOption = (value, label) => ({ value, label })) {
  const list = Array.isArray(options) ? options : [];
  const label = formNotListedChoiceLabel(field);
  return label ? [createOption(FORM_NOT_LISTED_VALUE, label), ...list] : list;
}

export function snapshotFormNotListedLabels(fields, submissionData) {
  const data = submissionData && typeof submissionData === 'object' && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const labels = {};
  for (const field of (Array.isArray(fields) ? fields : [])) {
    const value = data[field?.id] !== undefined ? data[field.id] : data[field?.name];
    if (!containsFormNotListedValue(value)) continue;
    const label = formNotListedChoiceLabel(field);
    if (label && field?.id) labels[field.id] = label;
  }
  if (Object.keys(labels).length === 0) return data;
  return {
    ...data,
    [FORM_NOT_LISTED_LABELS_KEY]: {
      ...(data[FORM_NOT_LISTED_LABELS_KEY] || {}),
      ...labels,
    },
  };
}

export function resolveFormNotListedDisplayValue(field, value, submissionData) {
  if (!containsFormNotListedValue(value)) return value;
  const snapshot = submissionData?.[FORM_NOT_LISTED_LABELS_KEY];
  const label = (field?.id && typeof snapshot?.[field.id] === 'string' && snapshot[field.id].trim())
    || formNotListedChoiceLabel(field, { requireEnabled: false })
    || 'Not listed';
  if (Array.isArray(value)) {
    return value.map(entry => entry === FORM_NOT_LISTED_VALUE ? label : entry);
  }
  return label;
}