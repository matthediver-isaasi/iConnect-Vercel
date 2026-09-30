export function normalizePreferenceFieldOption(option) {
  if (typeof option === 'string') return { value: option, label: option };
  if (option && typeof option === 'object') {
    const value = option.value == null ? '' : String(option.value);
    const label = option.label == null ? value : String(option.label);
    return { value, label };
  }
  return { value: '', label: '' };
}

export function preparePreferenceFieldOptions(options) {
  const normalized = (Array.isArray(options) ? options : []).map(normalizePreferenceFieldOption);
  const seenValues = new Set();

  for (const option of normalized) {
    option.label = option.label.trim();

    if (!option.value.trim()) {
      return { options: normalized, error: 'Every option must have a stored value.' };
    }
    if (!option.label) {
      return { options: normalized, error: 'Every option must have a visible name.' };
    }
    if (seenValues.has(option.value)) {
      return { options: normalized, error: `Stored option values must be unique. "${option.value}" is used more than once.` };
    }
    seenValues.add(option.value);
  }

  return { options: normalized, error: null };
}

export function optionsForPreferenceFieldPayload(fieldType, options) {
  if (fieldType !== 'picklist' && fieldType !== 'dropdown') return null;
  const prepared = preparePreferenceFieldOptions(options);
  if (prepared.error) throw new Error(prepared.error);
  return prepared.options;
}