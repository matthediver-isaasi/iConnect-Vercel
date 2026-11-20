// Optional extension: no defaults are injected into opaque saved definitions.
export function validateReportSort(report) {
  if (report?.sort === undefined) return [];
  if (!Array.isArray(report.sort) || report.sort.length > 10) throw new Error('Report sort must contain at most 10 rules.');
  const used = new Set();
  return report.sort.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || typeof rule.column_id !== 'string' || !rule.column_id.trim()
      || !['asc', 'desc'].includes(rule.direction)) throw new Error('Each report sort rule requires a column and ASC or DESC direction.');
    const matches = (Array.isArray(report.columns) ? report.columns : [])
      .flatMap((column, index) => column?.id === rule.column_id ? [index] : []);
    if (matches.length !== 1) throw new Error('A sorted report column is missing or has a duplicate identity.');
    if (used.has(rule.column_id)) throw new Error('A report column can only be sorted once.');
    used.add(rule.column_id);
    return { column_id: rule.column_id, direction: rule.direction, index: matches[0] };
  });
}

export function reportDefinitionKey(definition) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(definition));
}

// The existing renderer determines identity/deduplication and multi-value order.
// Scalars retain their types; joined lists compare as displayed text.
export function reportSortValue(values, displayed) {
  const present = values.filter(value => value != null && value !== '');
  if (!present.length) return null;
  if (values.length !== 1 || Array.isArray(present[0]) || typeof present[0] === 'object') return displayed || null;
  const value = present[0];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'boolean' ? value : String(value);
}
