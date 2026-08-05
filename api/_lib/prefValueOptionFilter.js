// Shared matching logic for custom-field filters on the admin CRM paginated
// endpoints (/api/admin/members/paginated and /api/admin/organizations/paginated)
// and the organisation CSV export.
//
// Preference values are stored two ways:
//   - scalar:      value = 'A'                (dropdown / radio)
//   - JSON array:  value = '["A","B"]'        (checkbox / multi-select)
// so each selected option must match either the exact scalar or the quoted
// option inside the JSON array. Quoting the option in the ilike pattern
// prevents substring false-positives (e.g. "Niger" vs "Nigeria").
//
// Filter wire format (the `customFilters` query param JSON values):
//   - legacy/default-operator encodings: ["A","B"] (option any-of),
//     "__text__:<substring>" (text contains), "__bool__:Yes|No",
//     "__country__:<name>" (country any-of), or a bare legacy string.
//   - operator objects for non-default conditions:
//     { "op": "none_of", "value": ["A","B"] }
//     { "op": "not_contains" | "equals", "value": "<text>" }
//     { "op": "empty" } / { "op": "not_empty" }
//     Country values keep their "__country__:" prefix inside the object.

// Escape a value for use inside a PostgREST .or() filter list: wrap in double
// quotes and backslash-escape embedded backslashes/quotes so commas, dots and
// parentheses inside option values don't break the filter grammar.
export function quoteForOr(val) {
  return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Escape LIKE/ILIKE wildcards so user text matches literally.
export function escapeIlikeWildcards(val) {
  return String(val).replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

const COUNTRY_PREFIX = '__country__:';
const TEXT_PREFIX = '__text__:';
const BOOL_PREFIX = '__bool__:';

// Normalize one customFilters entry (legacy encoding OR operator object) into
// a canonical shape the query builders understand:
//   { op, kind, values? , value? }
// ops: any_of | none_of | contains | not_contains | equals | bool_is | empty | not_empty
// kinds: option | country | text | bool | any
// Returns null when the entry carries nothing usable.
export function normalizeCustomFilterEntry(raw) {
  if (raw === undefined || raw === null) return null;

  // Operator-object form.
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const op = typeof raw.op === 'string' ? raw.op : '';
    if (op === 'empty' || op === 'not_empty') {
      return { op, kind: 'any' };
    }
    if (op === 'none_of' || op === 'any_of') {
      const value = raw.value;
      if (Array.isArray(value)) {
        const vals = value.map((v) => String(v)).filter((v) => v !== '' && v !== 'all');
        return vals.length > 0 ? { op, kind: 'option', values: vals } : null;
      }
      if (typeof value === 'string' && value !== '' && value !== 'all') {
        if (value.startsWith(COUNTRY_PREFIX)) {
          const name = value.slice(COUNTRY_PREFIX.length);
          return name ? { op, kind: 'country', values: [name] } : null;
        }
        return { op, kind: 'option', values: [value] };
      }
      return null;
    }
    if (op === 'not_contains' || op === 'contains' || op === 'equals') {
      let value = typeof raw.value === 'string' ? raw.value : '';
      if (value.startsWith(TEXT_PREFIX)) value = value.slice(TEXT_PREFIX.length);
      return value ? { op, kind: 'text', value } : null;
    }
    return null;
  }

  // Legacy encodings (default operators).
  if (Array.isArray(raw)) {
    const vals = raw.map((v) => String(v)).filter((v) => v !== '' && v !== 'all');
    return vals.length > 0 ? { op: 'any_of', kind: 'option', values: vals } : null;
  }
  const val = String(raw);
  if (val === '' || val === 'all') return null;
  if (val.startsWith(TEXT_PREFIX)) {
    const substr = val.slice(TEXT_PREFIX.length);
    return substr ? { op: 'contains', kind: 'text', value: substr } : null;
  }
  if (val.startsWith(BOOL_PREFIX)) {
    const label = val.slice(BOOL_PREFIX.length);
    return label === 'Yes' || label === 'No'
      ? { op: 'bool_is', kind: 'bool', value: label }
      : null;
  }
  if (val.startsWith(COUNTRY_PREFIX)) {
    const name = val.slice(COUNTRY_PREFIX.length);
    return name ? { op: 'any_of', kind: 'country', values: [name] } : null;
  }
  // Legacy single-value option filter (old saved views / bookmarked URLs).
  return { op: 'any_of', kind: 'option', values: [val] };
}

// Ops that must be executed as an anti-join: LEFT-embed the preference-value
// rows that WOULD match, then keep only parents where no such row exists
// (`.is(alias, null)`). Absence of a row therefore satisfies the negation.
const ANTI_JOIN_OPS = new Set(['none_of', 'not_contains', 'empty']);

export function prefEntryNeedsAntiJoin(entry) {
  return ANTI_JOIN_OPS.has(entry.op);
}

// Apply the embed-level conditions for one normalized entry onto an aliased
// join of the preference-value table. The caller is responsible for using the
// right join type (`!inner` for positive ops, `!left` + `.is(alias, null)` for
// anti-join ops) — the embedded conditions are identical either way.
// opts.buildCountryConditions(names) may translate country names into an OR
// condition string (name + ISO code variants); option matching is the fallback.
export function applyPrefFilterEntry(query, alias, fieldId, entry, opts = {}) {
  query = query.eq(`${alias}.field_id`, fieldId);
  switch (entry.op) {
    case 'any_of':
    case 'none_of': {
      const conds = entry.kind === 'country' && opts.buildCountryConditions
        ? opts.buildCountryConditions(entry.values)
        : buildOptionValueOrConditions(entry.values);
      return query.or(conds, { foreignTable: alias });
    }
    case 'contains':
    case 'not_contains':
      return query.ilike(`${alias}.value`, `%${entry.value}%`);
    case 'equals': {
      // Case-insensitive exact match on scalar storage, or the exact element
      // inside JSON-array storage.
      const scalar = escapeIlikeWildcards(entry.value);
      const jsonEncoded = JSON.stringify(String(entry.value)).replace(/[%_]/g, (ch) => `\\${ch}`);
      return query.or(
        `value.ilike.${quoteForOr(scalar)},value.ilike.${quoteForOr(`*${jsonEncoded}*`)}`,
        { foreignTable: alias }
      );
    }
    case 'bool_is':
      return query.or(
        entry.value === 'Yes' ? 'value.eq.Yes,value.eq.true' : 'value.eq.No,value.eq.false',
        { foreignTable: alias }
      );
    case 'empty':
    case 'not_empty':
      // The embed matches NON-empty rows ('' / '[]' / NULL values excluded).
      // For 'not_empty' the inner join keeps parents with such a row; for
      // 'empty' the left join + `.is(alias, null)` keeps parents without one,
      // which also covers members/orgs with no preference row at all.
      return query.not(`${alias}.value`, 'in', '("","[]")');
    default:
      return query;
  }
}

// ---------------------------------------------------------------------------
// Core (direct-column) filters: the `coreFilters` query param JSON.
// Shape: { "<column>": { "op": "...", "value": "..." } }
// Text columns:  contains | not_contains | equals | empty | not_empty
// Id columns:    any_of | none_of | empty | not_empty
// ---------------------------------------------------------------------------

const TEXT_COLUMN_OPS = new Set(['contains', 'not_contains', 'equals', 'empty', 'not_empty']);
const ID_COLUMN_OPS = new Set(['any_of', 'none_of', 'empty', 'not_empty']);
const MAX_CORE_FILTERS = 10;

// Parse + whitelist the coreFilters param. `allowedColumns` maps a column name
// to { idColumn?: true }. Returns [{ col, op, value?, idColumn }].
export function parseCoreFilters(raw, allowedColumns) {
  const out = [];
  if (!raw || !String(raw).trim()) return out;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [col, entry] of Object.entries(obj)) {
    if (out.length >= MAX_CORE_FILTERS) break;
    const colDef = allowedColumns[col];
    if (!colDef) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const op = typeof entry.op === 'string' ? entry.op : '';
    const allowedOps = colDef.idColumn ? ID_COLUMN_OPS : TEXT_COLUMN_OPS;
    if (!allowedOps.has(op)) continue;
    if (op === 'empty' || op === 'not_empty') {
      out.push({ col, op, idColumn: !!colDef.idColumn });
      continue;
    }
    if (colDef.idColumn) {
      // Id columns accept a single id string, a comma-separated list, or an
      // array of ids (multi-select filters send several values at once).
      const rawVals = Array.isArray(entry.value)
        ? entry.value
        : typeof entry.value === 'string' ? entry.value.split(',') : [];
      const values = rawVals
        .map(v => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .slice(0, 100);
      if (values.length === 0) continue;
      out.push({ col, op, value: values[0], values, idColumn: true });
      continue;
    }
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!value) continue;
    out.push({ col, op, value, idColumn: false });
  }
  return out;
}

// Apply one parsed core filter to a query on the base table.
export function applyDirectColumnFilter(query, entry) {
  const { col, op, value, idColumn } = entry;
  if (idColumn) {
    const values = Array.isArray(entry.values) && entry.values.length > 0 ? entry.values : [value];
    switch (op) {
      case 'any_of':
        return values.length > 1 ? query.in(col, values) : query.eq(col, values[0]);
      case 'none_of':
        return values.length > 1
          ? query.or(`${col}.is.null,${col}.not.in.(${values.map(quoteForOr).join(',')})`)
          : query.or(`${col}.is.null,${col}.neq.${quoteForOr(values[0])}`);
      case 'empty':
        return query.is(col, null);
      case 'not_empty':
        return query.not(col, 'is', null);
      default:
        return query;
    }
  }
  switch (op) {
    case 'contains':
      return query.ilike(col, `%${value}%`);
    case 'not_contains': {
      // NULL and empty-string values "do not contain" anything.
      const pattern = quoteForOr(`*${escapeIlikeWildcards(value)}*`);
      return query.or(`${col}.is.null,${col}.eq."",${col}.not.ilike.${pattern}`);
    }
    case 'equals':
      return query.ilike(col, escapeIlikeWildcards(value));
    case 'empty':
      return query.or(`${col}.is.null,${col}.eq.""`);
    case 'not_empty':
      return query.not(col, 'is', null).neq(col, '');
    default:
      return query;
  }
}
