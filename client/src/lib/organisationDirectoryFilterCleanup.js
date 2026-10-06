/** Never silently coerce a multi-value selection into its first value. */
export function cleanOrganisationDirectoryFilters(filters, fields) {
  const byKey = new Map(fields.map(field => [field.key, field]));
  const next = {};
  const singleSelectionLabels = [];
  for (const [key, filter] of Object.entries(filters)) {
    const field = byKey.get(key);
    if (!field) continue;
    if (["choice", "source-choice"].includes(field.control)
      && field.multi_select === false
      && Array.isArray(filter?.value) && filter.value.length > 1) {
      singleSelectionLabels.push(field.label || key);
      continue;
    }
    next[key] = filter;
  }
  return { filters: next, singleSelectionLabels };
}
