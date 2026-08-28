import {
  isRepeatableRowField,
  normalizeRepeatableRowField,
} from './formRepeatableRows.js';

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
    if (containsFormNotListedValue(value)) {
      const label = formNotListedChoiceLabel(field);
      if (label && field?.id) labels[field.id] = label;
    }
    if (!isRepeatableRowField(field) || !field?.id || !Array.isArray(value)) continue;
    const childLabels = {};
    for (const child of normalizeRepeatableRowField(field).children) {
      if (!child?.id || !value.some(row => containsFormNotListedValue(row?.[child.id]))) continue;
      const label = formNotListedChoiceLabel(child);
      if (label) childLabels[child.id] = label;
    }
    if (Object.keys(childLabels).length > 0) {
      const existing = data[FORM_NOT_LISTED_LABELS_KEY]?.[field.id];
      labels[field.id] = {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
        ...childLabels,
      };
    }
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

export function preserveFormNotListedLabelSnapshots(submissionData, trustedSubmissionData) {
  const current = submissionData && typeof submissionData === 'object' && !Array.isArray(submissionData)
    ? submissionData
    : {};
  const trusted = trustedSubmissionData?.[FORM_NOT_LISTED_LABELS_KEY];
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted)) return current;
  const merged = {
    ...(current[FORM_NOT_LISTED_LABELS_KEY] || {}),
  };
  for (const [fieldId, label] of Object.entries(trusted)) {
    if (label && typeof label === 'object' && !Array.isArray(label)) {
      merged[fieldId] = {
        ...(merged[fieldId] && typeof merged[fieldId] === 'object' ? merged[fieldId] : {}),
        ...label,
      };
    } else if (typeof label === 'string') {
      merged[fieldId] = label;
    }
  }
  return {
    ...current,
    [FORM_NOT_LISTED_LABELS_KEY]: merged,
  };
}

export function resolveFormNotListedDisplayValue(field, value, submissionData, options = {}) {
  if (!containsFormNotListedValue(value)) return value;
  const snapshot = submissionData?.[FORM_NOT_LISTED_LABELS_KEY];
  const parentId = options.parentField?.id;
  const nestedLabel = parentId && field?.id
    && snapshot?.[parentId] && typeof snapshot[parentId] === 'object'
    && typeof snapshot[parentId][field.id] === 'string'
    ? snapshot[parentId][field.id].trim()
    : '';
  const label = nestedLabel
    || (field?.id && typeof snapshot?.[field.id] === 'string' && snapshot[field.id].trim())
    || formNotListedChoiceLabel(field, { requireEnabled: false })
    || 'Not listed';
  if (Array.isArray(value)) {
    return value.map(entry => entry === FORM_NOT_LISTED_VALUE ? label : entry);
  }
  return label;
}