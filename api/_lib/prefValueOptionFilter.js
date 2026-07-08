// Shared matching logic for option-based custom-field filters on the admin
// CRM paginated endpoints (/api/admin/members/paginated and
// /api/admin/organizations/paginated).
//
// Preference values are stored two ways:
//   - scalar:      value = 'A'                (dropdown / radio)
//   - JSON array:  value = '["A","B"]'        (checkbox / multi-select)
// so each selected option must match either the exact scalar or the quoted
// option inside the JSON array. Quoting the option in the ilike pattern
// prevents substring false-positives (e.g. "Niger" vs "Nigeria").

// Escape a value for use inside a PostgREST .or() filter list: wrap in double
// quotes and backslash-escape embedded backslashes/quotes so commas, dots and
// parentheses inside option values don't break the filter grammar.
function quoteForOr(val) {
  return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Build the OR condition string for one or more selected option values.
// OR semantics within a field; the caller ANDs across different fields via
// separate aliased joins.
export function buildOptionValueOrConditions(values) {
  const conditions = [];
  for (const v of values) {
    const str = String(v);
    // Exact scalar storage.
    conditions.push(`value.eq.${quoteForOr(str)}`);
    // JSON-array storage: the value contains the JSON-encoded (quoted) option.
    // Escape LIKE wildcards so options containing % or _ match literally.
    const jsonEncoded = JSON.stringify(str).replace(/[%_]/g, (ch) => `\\${ch}`);
    conditions.push(`value.ilike.${quoteForOr(`*${jsonEncoded}*`)}`);
  }
  return conditions.join(',');
}

// Parse the raw value for one field out of the customFilters query param:
// returns a non-empty array of strings for option filters, a non-empty string
// for legacy/prefixed values, or null when nothing usable remains.
export function parseCustomFilterRawValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const vals = raw
      .map((v) => String(v))
      .filter((v) => v !== '' && v !== 'all');
    return vals.length > 0 ? vals : null;
  }
  const val = String(raw);
  if (val === '' || val === 'all') return null;
  return val;
}
