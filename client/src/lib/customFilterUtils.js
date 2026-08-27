// Shared helpers for the admin CRM list pages (/members, /organisations)
// custom-field filters. Option-bearing fields (dropdown/radio/checkbox) are
// multi-select and store an ARRAY of selected values; boolean, text and
// country filters keep their legacy prefixed-string encodings.

const PREFIXED = ['__text__:', '__bool__:', '__country__:'];
export const ORGANIZATION_FILTER_PREFIX = 'org:';

export function organizationFilterKey(fieldId) {
  return `${ORGANIZATION_FILTER_PREFIX}${fieldId}`;
}

export function organizationFieldIdFromFilterKey(key) {
  return typeof key === 'string' && key.startsWith(ORGANIZATION_FILTER_PREFIX)
    ? key.slice(ORGANIZATION_FILTER_PREFIX.length)
    : null;
}

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

// ---------------------------------------------------------------------------
// Per-filter condition operators. The FIRST entry of each list is the default
// operator: with the default op the wire value keeps its legacy encoding, so
// old saved views and old server code stay compatible.
// ---------------------------------------------------------------------------

export const TEXT_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'equals', label: 'equals' },
  { value: 'empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

export const OPTION_OPERATORS = [
  { value: 'any_of', label: 'is any of' },
  { value: 'none_of', label: 'is none of' },
  { value: 'empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

export const BOOLEAN_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

// Single-value selects (organisation / role on /members).
export const SELECT_OPERATORS = [
  { value: 'any_of', label: 'is' },
  { value: 'none_of', label: 'is not' },
  { value: 'empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

export const COUNTRY_OPERATORS = [
  { value: 'any_of', label: 'is any of' },
  { value: 'none_of', label: 'is none of' },
  { value: 'empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

export function isEmptinessOp(op) {
  return op === 'empty' || op === 'not_empty';
}

const DEFAULT_OPS = new Set(['contains', 'any_of', 'is']);

// Build the wire value the server receives for one custom-field filter, given
// the stored UI value (legacy shape) and the selected operator. Default
// operators keep the legacy encoding; non-default ones send { op, value }.
export function buildCustomFilterWireValue(value, op) {
  if (isEmptinessOp(op)) return { op };
  if (!op || DEFAULT_OPS.has(op)) return value;
  let v = value;
  if (typeof v === 'string' && v.startsWith('__text__:')) {
    v = v.slice('__text__:'.length);
  }
  return { op, value: v };
}

// Build the separately transmitted organisation-filter payload. Operator keys
// are namespaced while values remain keyed by raw field id, so member and
// organisation fields can safely share the same underlying id. Reading
// namespaced emptiness ops directly also lets a saved view filter correctly
// before preference-field definitions finish loading.
export function buildOrganizationFilterPayload(values, filterOps) {
  const out = {};
  const fieldIds = new Set(Object.keys(values || {}));
  for (const key of Object.keys(filterOps || {})) {
    const fieldId = organizationFieldIdFromFilterKey(key);
    if (fieldId) fieldIds.add(fieldId);
  }
  for (const fieldId of fieldIds) {
    const op = filterOps?.[organizationFilterKey(fieldId)];
    if (isEmptinessOp(op)) out[fieldId] = { op };
    else if (isActiveCustomFilterValue(values?.[fieldId])) {
      out[fieldId] = buildCustomFilterWireValue(values[fieldId], op);
    }
  }
  return out;
}

// True when a filter should be applied given its value AND operator.
export function isActiveCustomFilterWithOp(value, op) {
  if (isEmptinessOp(op)) return true;
  return isActiveCustomFilterValue(value);
}

// Sanitize a saved-view filterOps map (id -> operator string).
export function sanitizeFilterOps(obj) {
  const out = {};
  Object.entries(obj || {}).forEach(([id, op]) => {
    if (typeof op === 'string' && op) out[id] = op;
  });
  return out;
}
