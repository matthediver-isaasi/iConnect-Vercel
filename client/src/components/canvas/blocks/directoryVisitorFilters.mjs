// Keep visitor choices independent of the author's fixed filter overrides.
export function normalizeVisitorFilterFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.filter(field => field && field.id != null && Array.isArray(field.options))
    .map(field => ({
      ...field,
      id: String(field.id),
      label: String(field.label || field.id),
      options: field.options.filter(option => option && option.value != null).map(option => ({
        value: String(option.value), label: String(option.label ?? option.value),
      })),
    })).filter(field => field.options.length > 0);
}

export function pruneVisitorFilters(selection, fields) {
  const result = {};
  for (const field of fields) {
    const allowed = new Set(field.options.map(option => option.value));
    const values = [...new Set(selection[field.id] || [])].filter(value => allowed.has(value)).sort();
    if (values.length) result[field.id] = values;
  }
  return result;
}

export function visitorFiltersKey(selection) {
  return JSON.stringify(Object.fromEntries(Object.keys(selection).sort()
    .filter(id => selection[id]?.length)
    .map(id => [id, [...selection[id]].sort()])));
}
