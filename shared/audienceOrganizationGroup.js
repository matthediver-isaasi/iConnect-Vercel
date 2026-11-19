export const organizationGroupScope = 'organization_group';
export function organizationGroupOperators(type) {
  const base = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
  if (type === 'boolean') return ['is_true', 'is_false'];
  if (['list', 'multiselect', 'multi_select', 'country', 'countries'].includes(type)) return ['contains', 'is_empty', 'is_not_empty'];
  if (['number', 'decimal'].includes(type)) return [...base, 'greater_than', 'less_than'];
  if (type === 'date') return [...base, 'before', 'after'];
  if (['picklist', 'dropdown'].includes(type)) return [...base, 'is_one_of'];
  if (['text', 'textarea', 'email', 'url', 'phone'].includes(type)) return [...base, 'contains'];
  return [];
}

export function organizationGroupConditionError(c, field) {
  if (!field || field.is_active !== true || field.entity_scope !== organizationGroupScope) return 'Organisation Group field is unavailable. Reselect an active field.';
  if (c.field_type !== 'custom' || c.data_type !== field.field_type ||
      !organizationGroupOperators(field.field_type).includes(c.operator)) return 'Invalid Organisation Group field type or operator.';
  if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(c.operator)) return null;
  const multi = c.operator === 'is_one_of' || (c.operator === 'contains' && ['list', 'multiselect', 'multi_select', 'country', 'countries'].includes(field.field_type));
  const values = multi ? c.value : [c.value];
  if (!Array.isArray(values) || !values.length || values.some(v => !['string', 'number'].includes(typeof v) || !String(v).trim())) return 'Choose a valid Organisation Group filter value.';
  if (!multi && Array.isArray(c.value)) return 'Choose a single Organisation Group filter value.';
  if (['number', 'decimal'].includes(field.field_type) && values.some(v => !Number.isFinite(Number(v)))) return 'Enter a valid number.';
  if (field.field_type === 'date' && values.some(v => !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)) return 'Enter a valid date.';
  if (['picklist', 'dropdown', 'multiselect', 'multi_select'].includes(field.field_type) || field.options?.length) {
    if (!Array.isArray(field.options)) return 'Organisation Group field choices are unavailable.';
    const choices = field.options.map(o => String(typeof o === 'object' ? o.value ?? o.label : o));
    if (values.some(v => !choices.includes(String(v)))) return 'The saved Organisation Group value is unavailable. Choose again.';
  }
  return null;
}
