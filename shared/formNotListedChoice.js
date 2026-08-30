import {
  isRepeatableRowField,
  normalizeRepeatableRowField,
} from './formRepeatableRows.js';

export const FORM_NOT_LISTED_VALUE = '__form_not_listed__';
export const FORM_NOT_LISTED_LABELS_KEY = '__not_listed_choice_labels';
export const FORM_NOT_LISTED_TEXT_KEY = '__not_listed_choice_text';
export const FORM_NOT_LISTED_TEXT_MAX_LENGTH = 500;

export const FORM_NOT_LISTED_FIELD_TYPES = new Set([
  'organisation_dropdown',
  'organisation_group_dropdown',
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fieldValue(data, field) {
  if (field?.id != null && data?.[field.id] !== undefined) return data[field.id];
  return field?.name != null ? data?.[field.name] : undefined;
}

function normalizedNotListedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveFormNotListedText(field, submissionData, options = {}) {
  if (!field?.id) return '';
  const source = options.row || submissionData;
  return normalizedNotListedText(source?.[FORM_NOT_LISTED_TEXT_KEY]?.[field.id]);
}

export function setFormNotListedText(submissionData, fieldId, text) {
  const data = isPlainObject(submissionData) ? submissionData : {};
  const current = isPlainObject(data[FORM_NOT_LISTED_TEXT_KEY])
    ? data[FORM_NOT_LISTED_TEXT_KEY]
    : {};
  const next = { ...current };
  const value = typeof text === 'string' ? text : '';
  if (value) next[fieldId] = value;
  else delete next[fieldId];
  const result = { ...data };
  if (Object.keys(next).length) result[FORM_NOT_LISTED_TEXT_KEY] = next;
  else delete result[FORM_NOT_LISTED_TEXT_KEY];
  return result;
}

export function setRepeatableRowNotListedText(row, childId, text) {
  return setFormNotListedText(row, childId, text);
}

export function pruneFormNotListedText(fields, submissionData) {
  const data = isPlainObject(submissionData) ? submissionData : {};
  const list = Array.isArray(fields) ? fields : [];
  let changed = false;
  let result = data;
  const ensureCopy = () => {
    if (result === data) result = { ...data };
    return result;
  };
  const rootText = isPlainObject(data[FORM_NOT_LISTED_TEXT_KEY])
    ? data[FORM_NOT_LISTED_TEXT_KEY]
    : {};
  const keptRootText = {};
  for (const field of list) {
    if (!field?.id || !supportsFormNotListedChoice(field)) continue;
    if (!containsFormNotListedValue(fieldValue(data, field))) continue;
    if (rootText[field.id] !== undefined) keptRootText[field.id] = rootText[field.id];
  }
  if (data[FORM_NOT_LISTED_TEXT_KEY] !== undefined) {
    if (!isPlainObject(data[FORM_NOT_LISTED_TEXT_KEY])
        || Object.keys(rootText).length !== Object.keys(keptRootText).length) {
      changed = true;
      if (Object.keys(keptRootText).length) {
        ensureCopy()[FORM_NOT_LISTED_TEXT_KEY] = keptRootText;
      } else {
        delete ensureCopy()[FORM_NOT_LISTED_TEXT_KEY];
      }
    }
  }
  for (const field of list) {
    if (!isRepeatableRowField(field)) continue;
    const rows = fieldValue(data, field);
    if (!Array.isArray(rows)) continue;
    const children = normalizeRepeatableRowField(field).children;
    const nextRows = rows.map((row) => pruneFormNotListedText(children, row));
    if (nextRows.some((row, index) => row !== rows[index])) {
      changed = true;
      ensureCopy()[field.id] = nextRows;
    }
  }
  return changed ? result : data;
}

export function validateFormNotListedText(fields, submissionData, options = {}) {
  const data = isPlainObject(submissionData) ? submissionData : {};
  const list = Array.isArray(fields) ? fields : [];
  const rootText = data[FORM_NOT_LISTED_TEXT_KEY];
  if (rootText !== undefined && !isPlainObject(rootText)) {
    return { valid: false, error: 'Invalid not-listed text' };
  }
  const allowedRootIds = new Set(list
    .filter(field => field?.id && supportsFormNotListedChoice(field))
    .map(field => String(field.id)));
  for (const key of Object.keys(rootText || {})) {
    if (!allowedRootIds.has(String(key))) {
      return { valid: false, error: 'Invalid not-listed text' };
    }
  }

  const validateEntry = (field, selected, textMap, context = {}) => {
    const rawText = textMap?.[field.id];
    const selectedNotListed = containsFormNotListedValue(selected);
    if (!selectedNotListed && rawText !== undefined) {
      return { valid: false, error: 'Not-listed text must match a not-listed selection' };
    }
    if (!selectedNotListed) return { valid: true };
    if (rawText === undefined
        && options.allowMissingText?.({ field, selected, ...context })) {
      return { valid: true };
    }
    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { valid: false, error: 'Please specify the not-listed value' };
    }
    if (rawText.trim().length > FORM_NOT_LISTED_TEXT_MAX_LENGTH) {
      return { valid: false, error: `Not-listed text must be ${FORM_NOT_LISTED_TEXT_MAX_LENGTH} characters or fewer` };
    }
    return { valid: true };
  };

  for (const field of list) {
    if (!field) continue;
    if (supportsFormNotListedChoice(field) && field.id) {
      const result = validateEntry(field, fieldValue(data, field), rootText, {
        containerField: null,
        row: null,
      });
      if (!result.valid) return result;
    }
    if (!isRepeatableRowField(field)) continue;
    const rows = fieldValue(data, field);
    if (!Array.isArray(rows)) continue;
    const children = normalizeRepeatableRowField(field).children;
    const allowedChildIds = new Set(children
      .filter(child => child?.id && supportsFormNotListedChoice(child))
      .map(child => String(child.id)));
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      const rowText = row[FORM_NOT_LISTED_TEXT_KEY];
      if (rowText !== undefined && !isPlainObject(rowText)) {
        return { valid: false, error: 'Invalid not-listed text' };
      }
      for (const key of Object.keys(rowText || {})) {
        if (!allowedChildIds.has(String(key))) {
          return { valid: false, error: 'Invalid not-listed text' };
        }
      }
      for (const child of children) {
        if (!child?.id || !supportsFormNotListedChoice(child)) continue;
        const result = validateEntry(child, fieldValue(row, child), rowText, {
          containerField: field,
          row,
        });
        if (!result.valid) return result;
      }
    }
  }
  return { valid: true };
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
  const freeText = resolveFormNotListedText(field, submissionData, options);
  const display = freeText ? `${label} — ${freeText}` : label;
  if (Array.isArray(value)) {
    return value.map(entry => entry === FORM_NOT_LISTED_VALUE ? display : entry);
  }
  return display;
}