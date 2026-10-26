import { readDirectoryPages } from './directoryExpression.js';
import { enrichField } from './directoryConfig.js';

// Filter publication is independent of card publication. Only definitions, never
// preference records or directory inclusion rules, cross this boundary.
export async function fetchDirectoryVisitorFields(db, tenantId, directory) {
  const fields = await readDirectoryPages(() => db.from('preference_field')
    .select('id, label, field_type, options, directory_visibility')
    .eq('tenant_id', tenantId).eq('entity_scope', directory.entity_type)
    .eq('is_active', true).eq('is_filterable', true)
    .order('display_order').order('id'));
  return projectDirectoryVisitorFields(fields, directory);
}

export function projectDirectoryVisitorFields(fields, directory) {
  const selected = directory.selected_filter_fields;
  return fields.filter(field => field.id !== directory.filter_field_id
    && (selected == null || (Array.isArray(selected) && selected.includes(field.id))))
    .map(field => {
      let options = field.options;
      if (typeof options === 'string') {
        try { options = JSON.parse(options); } catch { options = []; }
      }
      const normalized = field.field_type === 'boolean'
        ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
        : (Array.isArray(options) ? options : []).flatMap(option => {
          const value = typeof option === 'string' ? option : option?.value;
          if (typeof value !== 'string' || !value) return [];
          return [{ value, label: typeof option?.label === 'string' ? option.label : value }];
        });
      return { id: field.id, label: enrichField(field, directory.id)._displayLabel,
        field_type: field.field_type, options: normalized };
    }).filter(field => field.options.length > 0);
}

export function parseVisitorFilters(raw) {
  if (raw === undefined) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid visitor filters');
  return parsed;
}

export function validateVisitorFilters(filters, fields) {
  const constraints = [];
  for (const [fieldId, value] of Object.entries(filters)) {
    const field = fields.find(field => field.id === fieldId);
    const values = Array.isArray(value) ? value : [value];
    if (!field || values.some(v => typeof v !== 'string' || !field.options.some(option => option.value === v))) {
      throw new Error('Unavailable visitor filter');
    }
    if (values.length) constraints.push({ fieldId, value: [...new Set(values)] });
  }
  return constraints;
}
