export const CUSTOM_FIELD_TYPES = [
  ['text', 'Single-line text'], ['textarea', 'Multi-line text'],
  ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'],
  ['boolean', 'Yes / No'], ['email', 'Email'], ['url', 'URL'],
];

export function customFieldType(type) {
  return ({ single_line_text: 'text', multiline: 'textarea', multi_line_text: 'textarea',
    dropdown: 'select', checkbox: 'boolean' })[type] || type;
}

export function copyCustomFieldValues(values) {
  return values && typeof values === 'object' && !Array.isArray(values) ? { ...values } : {};
}

// Explicit replacement; never send retired IDs, nulls or blank values.
export function buildCustomFieldValues(fields, values = {}) {
  const result = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;
    const type = customFieldType(field.type);
    if (type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${field.name}: enter a valid number.`);
      result[field.id] = number;
    } else if (type === 'boolean') {
      if (value !== true && value !== false) throw new Error(`${field.name}: choose Yes, No or Not set.`);
      result[field.id] = value;
    } else {
      if (typeof value !== 'string') throw new Error(`${field.name}: enter text.`);
      if (value.length > (type === 'textarea' ? 10000 : 2000) || (type !== 'textarea' && /[\r\n]/.test(value))) {
        throw new Error(`${field.name}: text is too long or contains unsupported line breaks.`);
      }
      if (type === 'select' && !field.choices.includes(value)) throw new Error(`${field.name}: choose an available option.`);
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${field.name}: enter a valid email address.`);
      if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`${field.name}: enter a valid date.`);
      if (type === 'url') {
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch { throw new Error(`${field.name}: enter an http or https URL.`); }
      }
      result[field.id] = value;
    }
  }
  return result;
}

export function buildCustomFieldDefinitions(fields) {
  if (fields.length > 50) throw new Error('Supply at most 50 custom fields.');
  return fields.map((field) => {
    const name = field.name.trim();
    if (!name || name.length > 120) throw new Error('Every field needs a name of 1–120 characters.');
    const choices = customFieldType(field.type) === 'select'
      ? field.choices.map((choice) => choice.trim()) : [];
    if (customFieldType(field.type) === 'select' && (!choices.length || choices.length > 100 || choices.some((choice) => !choice || choice.length > 200) || new Set(choices).size !== choices.length)) {
      throw new Error(`${name}: add unique, non-empty dropdown choices.`);
    }
    return { ...(field.id ? { id: field.id } : {}), name, type: field.type,
      show_on_detail: !!field.show_on_detail, choices };
  });
}

export function populatedCustomFieldDisplay(fields) {
  return (Array.isArray(fields) ? fields : []).filter((field) =>
    field && field.value != null && ['string', 'number', 'boolean'].includes(typeof field.value)
    && !(typeof field.value === 'string' && !field.value.trim()));
}

export function formatCustomFieldValue(value) {
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
}
