export const GROUP_FIELDS_KEY = 'member_group_custom_fields';
export const GROUP_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'boolean', 'email', 'url'];
export const populatedGroupValue = value => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function validateGroupDefinitions(fields) {
  if (!Array.isArray(fields) || fields.length > 50) fail('Supply at most 50 fields.');
  const ids = new Set();
  return fields.map(field => {
    if (!field || typeof field !== 'object' || !uuid.test(field.id) || ids.has(field.id)) fail('Invalid or duplicate field ID.');
    ids.add(field.id);
    if (typeof field.name !== 'string' || !field.name.trim() || field.name.trim().length > 120) fail('Field names must contain 1–120 characters.');
    if (!GROUP_FIELD_TYPES.includes(field.type)) fail('Unknown field type.');
    if (field.show_on_detail !== undefined && typeof field.show_on_detail !== 'boolean') fail('Invalid visibility.');
    const choices = field.choices ?? [];
    if (!Array.isArray(choices) || choices.length > 100 || choices.some(c => typeof c !== 'string' || !c.trim() || c.length > 200)) fail('Invalid dropdown choices.');
    const clean = choices.map(c => c.trim());
    if (new Set(clean).size !== clean.length || (field.type === 'select' && !clean.length)) fail('Dropdown choices must be nonempty and unique.');
    return { id: field.id, name: field.name.trim(), type: field.type, show_on_detail: field.show_on_detail === true, choices: field.type === 'select' ? clean : [] };
  });
}

export function validateGroupValues(values, fields) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 50) fail('Custom field values must be an object with at most 50 fields.');
  const result = {};
  for (const [id, value] of Object.entries(values)) {
    const field = fields.find(f => f.id === id);
    if (!field) fail('Unknown custom field ID.');
    if (!populatedGroupValue(value)) continue;
    let valid = false;
    if (field.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
    else if (field.type === 'boolean') valid = typeof value === 'boolean';
    else if (typeof value === 'string' && value.length <= (field.type === 'textarea' ? 10000 : 2000)) {
      valid = true;
      if (field.type !== 'textarea' && /[\r\n]/.test(value)) valid = false;
      if (field.type === 'date') valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (field.type === 'select') valid = field.choices.includes(value);
      if (field.type === 'email') valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      if (field.type === 'url') {
        try { const url = new URL(value); valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { valid = false; }
      }
    }
    if (!valid) fail(`Invalid value for ${field.name}.`);
    result[id] = value;
  }
  return result;
}

export function groupDisplayValues(values, fields) {
  return fields.filter(f => f.show_on_detail && populatedGroupValue(values?.[f.id])).flatMap(f => {
    try {
      const clean = validateGroupValues({ [f.id]: values[f.id] }, [f]);
      return [{ id: f.id, name: f.name, type: f.type, value: clean[f.id] }];
    } catch { return []; }
  });
}
