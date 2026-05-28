// Shared helpers for form field validation/prefill logic.
// Used by both the standalone FormView page and IEdit-embedded forms so that
// fixes to either helper apply everywhere at once.

export const isFieldValueFilled = (field, value) => {
  if (!value) return false;

  if (field.type === 'countries') {
    return Array.isArray(value) && value.length > 0;
  }

  if (field.type === 'contact') {
    if (typeof value !== 'object') return false;
    if (!field.required) return Object.values(value).some(v => typeof v === 'string' && v.trim());
    const subDefaults = { firstName: { visible: true, required: true }, lastName: { visible: true, required: true }, jobTitle: { visible: true, required: false }, organisation: { visible: true, required: false }, email: { visible: true, required: true } };
    const subFields = field.contact_sub_fields || subDefaults;
    const requiredKeys = Object.keys(subDefaults).filter(k => {
      const cfg = subFields[k] || subDefaults[k];
      return cfg.visible !== false && cfg.required === true;
    });
    return requiredKeys.every(k => !!value[k]?.trim());
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'string') {
    return value.length > 0;
  }

  if (typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return true;
};

export const parseCustomFieldValue = (cfv, fieldType) => {
  if (!cfv || cfv.value === undefined || cfv.value === null) return null;
  let parsedValue = cfv.value;
  if (fieldType === 'list' || fieldType === 'countries') {
    if (Array.isArray(cfv.value)) {
      parsedValue = cfv.value;
    } else if (typeof cfv.value === 'string') {
      try {
        const parsed = JSON.parse(cfv.value);
        parsedValue = Array.isArray(parsed) ? parsed : (cfv.value ? [cfv.value] : []);
      } catch {
        parsedValue = cfv.value ? [cfv.value] : [];
      }
    } else {
      parsedValue = [];
    }
  }
  return parsedValue;
};
