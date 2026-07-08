// Shared helpers for the admin CRM list pages (/members, /organisations)
// custom-field filters. Option-bearing fields (dropdown/radio/checkbox) are
// multi-select and store an ARRAY of selected values; boolean, text and
// country filters keep their legacy prefixed-string encodings.

const PREFIXED = ['__text__:', '__bool__:', '__country__:'];

// True when a stored filter value should actually filter the list.
export function isActiveCustomFilterValue(v) {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'string' && v !== '' && v !== 'all' && v.trim() !== '';
}

// Coerce a single stored value: legacy saved views stored option filters as a
// plain string — wrap those in an array. Prefixed encodings stay strings.
export function coerceCustomFilterValue(v) {
  if (Array.isArray(v)) {
    return v.filter((x) => typeof x === 'string' && x !== '' && x !== 'all');
  }
  if (typeof v !== 'string') return '';
  if (v === '' || v === 'all') return '';
  if (PREFIXED.some((p) => v.startsWith(p))) return v;
  return [v];
}

// Coerce a whole saved customFieldFilters object (string values -> arrays).
export function coerceCustomFilters(obj) {
  const out = {};
  Object.entries(obj || {}).forEach(([fieldId, v]) => {
    out[fieldId] = coerceCustomFilterValue(v);
  });
  return out;
}
