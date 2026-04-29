import { supabase } from '../../_lib/database.js';
import { tenantFilter } from './permissions.js';
import { getSourceDef, getCustomFieldsForSource } from './sources.js';

const MAX_BUCKETS = 50;
const MAX_GROUPS = 20;
const PAGE_SIZE = 1000;
// Hard ceiling on the number of rows we are willing to scan for a single
// widget before refusing the query. This protects the API from runaway
// computations on huge tables; users who hit it must add filters.
const MAX_TOTAL_ROWS = 50000;
const NUMERIC_TYPES = new Set(['number', 'decimal']);
const NUMERIC_AGGREGATORS = new Set(['sum', 'avg', 'min', 'max']);

/**
 * Run a widget configuration against the database and return chart-ready
 * data. The result shape varies slightly per widget type but always
 * includes a `categories` array (legend) and a `rows` array.
 */
export async function runWidgetConfig(config, tenantId) {
  if (!supabase) {
    throw new Error('Database not configured');
  }
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid widget config');
  }

  const source = getSourceDef(config.source);
  if (!source) {
    throw new Error(`Unknown source: ${config.source}`);
  }

  const measure = normaliseMeasure(config.measure);
  const groupBy = config.groupBy || null;
  const timeBucket = config.timeBucket || null;

  if (!measure) {
    throw new Error('Measure is required');
  }
  if (groupBy && timeBucket) {
    throw new Error('Choose either group-by or time-bucket, not both');
  }

  // count and count_distinct accept any field type; numeric aggregators
  // require a numeric field. Reject mismatches up front. This
  // prevents silent string coercion that would otherwise return zero or NaN.
  if (NUMERIC_AGGREGATORS.has(measure.aggregator)) {
    if (!measure.field && !measure.fieldId) {
      throw new Error(`${measure.aggregator} requires a numeric field`);
    }
    const fieldType = await resolveFieldType(source, measure, tenantId);
    if (!fieldType || !NUMERIC_TYPES.has(fieldType)) {
      throw new Error(
        `${measure.aggregator} can only be applied to numeric fields (got ${fieldType || 'unknown'})`,
      );
    }
  }

  // Build column selection: id, plus measure column, plus group/time columns,
  // plus all filter columns. Custom fields require a join to the preference
  // value table (handled separately below).
  const systemColumns = new Set(['id']);
  if (source.timestampField) systemColumns.add(source.timestampField);
  if (measure.field && measure.fieldKind === 'system') {
    systemColumns.add(measure.field);
  }
  if (groupBy?.kind === 'system') systemColumns.add(groupBy.field);
  // Custom-field timeBucket (e.g. organisation.go_live) does NOT add to the
  // system column set — its value is hydrated via the preference store
  // below, not the base row.
  if (timeBucket?.field && timeBucket.fieldKind !== 'custom') {
    systemColumns.add(timeBucket.field);
  }
  (config.filters || []).forEach(f => {
    if (f.fieldKind === 'system' && f.field) systemColumns.add(f.field);
  });

  // Resolve any `lmic` operator filters into concrete IN-lists by loading
  // the tenant's saved LMIC country codes once per query. Doing this at
  // query time (rather than baking the codes into the widget config)
  // means LMIC settings edits are reflected in widget output immediately.
  const lmicCodes = needsLmicResolution(config) ? await loadTenantLmicCodes(tenantId) : null;

  // Fetch base rows (tenant scoped + system filters applied directly).
  // Supabase enforces a per-request row cap (default 1000), so we paginate
  // explicitly via .range() instead of relying on .limit(). If the dataset
  // exceeds MAX_TOTAL_ROWS we refuse the query so the user adds filters
  // rather than receiving silently-incomplete numbers.
  const selectColumns = Array.from(systemColumns).join(', ');
  const systemFilters = (config.filters || []).filter(f => f.fieldKind === 'system');
  let workingRows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1);
    let q = supabase.from(source.table).select(selectColumns);
    q = tenantFilter(q, tenantId);
    q = applySystemFilters(q, systemFilters, lmicCodes);
    const { data: page, error } = await q.range(from, to);
    if (error) {
      throw new Error(`Source query failed: ${error.message}`);
    }
    if (!page || page.length === 0) break;
    workingRows = workingRows.concat(page);
    // A short page means we've drained the source.
    if (page.length < PAGE_SIZE) break;
    // A full page that fills our scan budget means more rows remain — refuse
    // rather than silently truncate.
    if (workingRows.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. ` +
        `Add filters to narrow the dataset.`,
      );
    }
  }

  // Hydrate custom fields (preferences) used by measure / group / filter.
  const customFieldsNeeded = collectCustomFieldIds(config);
  let prefMap = new Map();
  if (customFieldsNeeded.size > 0 && workingRows.length > 0) {
    prefMap = await loadPreferenceValues({
      table: source.preferenceTable,
      fkColumn: source.preferenceFkColumn,
      ids: workingRows.map(r => r.id),
      fieldIds: Array.from(customFieldsNeeded),
    });
  }

  // Apply custom-field filters in JS.
  const customFilters = (config.filters || []).filter(f => f.fieldKind === 'custom');
  if (customFilters.length > 0) {
    workingRows = workingRows.filter(row => {
      const prefs = prefMap.get(row.id) || {};
      return customFilters.every(f => matchFilter(prefs[f.fieldId], f, lmicCodes));
    });
  }

  // Resolve a value for each row. When measure.additionalFields is set
  // (e.g. children_impacted_direct + children_impacted_indirect) the
  // per-row value is the numeric sum of the primary field's value plus
  // every additional field's value — non-numeric / missing values are
  // coerced to 0 so a row with only one of the two fields populated
  // still contributes its known portion.
  const additional = Array.isArray(measure.additionalFields) ? measure.additionalFields : [];
  const toNum = v => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const measureValueOf = additional.length > 0
    ? row => {
        const primary = toNum(valueFor(row, measure, prefMap));
        return additional.reduce(
          (sum, ref) => sum + toNum(valueFor(row, ref, prefMap)),
          primary,
        );
      }
    : row => valueFor(row, measure, prefMap);
  const groupKeyOf = groupBy
    ? row => normaliseKey(valueFor(row, groupBy, prefMap))
    : null;
  // timeBucket on a custom date field reads through the preference map; for
  // system date columns it reads the value directly off the base row.
  const timeKeyOf = timeBucket
    ? row => {
        const raw = timeBucket.fieldKind === 'custom'
          ? extractPrimitive((prefMap.get(row.id) || {})[timeBucket.fieldId])
          : row[timeBucket.field];
        return bucketTimestamp(raw, timeBucket.granularity);
      }
    : null;

  // No grouping — single value (count, sum, etc.).
  if (!groupBy && !timeBucket) {
    const value = aggregate(workingRows.map(measureValueOf), measure.aggregator);
    return {
      type: 'scalar',
      total: workingRows.length,
      value,
      rows: [{ key: 'total', value }],
    };
  }

  // Group-by aggregation.
  if (groupBy) {
    const buckets = new Map();
    workingRows.forEach(row => {
      const key = groupKeyOf(row);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(measureValueOf(row));
    });
    const grouped = Array.from(buckets.entries())
      .map(([key, values]) => ({ key, value: aggregate(values, measure.aggregator) }))
      .sort((a, b) => b.value - a.value);
    if (grouped.length > MAX_GROUPS) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${MAX_GROUPS}). ` +
        `Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories: ['value'],
      rows: grouped,
    };
  }

  // Time-bucket aggregation.
  const buckets = new Map();
  workingRows.forEach(row => {
    const key = timeKeyOf(row);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(measureValueOf(row));
  });
  const sortedKeys = Array.from(buckets.keys()).sort();
  if (sortedKeys.length > MAX_BUCKETS) {
    throw new Error(
      `Time bucketing produced ${sortedKeys.length} buckets (max ${MAX_BUCKETS}). ` +
      `Use a coarser granularity or add a date filter.`,
    );
  }
  return {
    type: 'time',
    total: workingRows.length,
    categories: ['value'],
    rows: sortedKeys.map(key => ({ key, value: aggregate(buckets.get(key), measure.aggregator) })),
    granularity: timeBucket.granularity,
  };
}

function needsLmicResolution(config) {
  return (config.filters || []).some(f => f.operator === 'lmic');
}

async function loadTenantLmicCodes(tenantId) {
  let q = supabase.from('tenant_lmic_country').select('country_code');
  q = tenantId ? q.eq('tenant_id', tenantId) : q.is('tenant_id', null);
  const { data, error } = await q;
  if (error) {
    console.error('[Dashboard Aggregation] Failed to load LMIC codes:', error.message);
    return [];
  }
  const codes = (data || []).map(r => String(r.country_code || '').toUpperCase()).filter(Boolean);
  if (codes.length > 0 || !tenantId) return codes;
  // No rows: distinguish "never initialised" from "admin saved empty list"
  // via the tenant_lmic_seed marker. Only the never-initialised case
  // triggers a lazy seed of the World Bank defaults; an intentionally
  // empty list is left empty (the lmic operator will then resolve to
  // "match nothing", which is the correct semantic).
  const { data: seedRow, error: seedErr } = await supabase
    .from('tenant_lmic_seed')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (seedErr) {
    console.warn('[Dashboard Aggregation] LMIC seed marker lookup warning:', seedErr.message);
  }
  if (seedRow) return [];
  try {
    const { WORLD_BANK_LMIC_ISO2 } = await import('../../../shared/lmicCountries.js');
    const rows = WORLD_BANK_LMIC_ISO2.map(code => ({ tenant_id: tenantId, country_code: code }));
    const { error: insertErr } = await supabase
      .from('tenant_lmic_country')
      .insert(rows);
    if (insertErr) {
      // Most likely a race with another request that just seeded the
      // same tenant — re-read and use whatever is now there.
      console.warn('[Dashboard Aggregation] LMIC seed insert warning:', insertErr.message);
      const { data: after } = await supabase
        .from('tenant_lmic_country')
        .select('country_code')
        .eq('tenant_id', tenantId);
      return (after || []).map(r => String(r.country_code || '').toUpperCase()).filter(Boolean);
    }
    const { error: markErr } = await supabase
      .from('tenant_lmic_seed')
      .upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id' });
    if (markErr) {
      console.warn('[Dashboard Aggregation] LMIC seed marker upsert warning:', markErr.message);
    }
    return [...WORLD_BANK_LMIC_ISO2];
  } catch (err) {
    console.error('[Dashboard Aggregation] LMIC seed failed:', err.message || err);
    return [];
  }
}

async function resolveFieldType(source, ref, tenantId) {
  if (ref.fieldKind === 'system' && ref.field) {
    const def = (source.systemFields || []).find(f => f.name === ref.field);
    return def?.type || null;
  }
  if (ref.fieldKind === 'custom' && ref.fieldId) {
    const customFields = await getCustomFieldsForSource(source, tenantId);
    const def = customFields.find(f => f.id === ref.fieldId);
    return def?.type || null;
  }
  return null;
}

// ---------------------------------------------------------------------------

function normaliseMeasure(raw) {
  if (!raw) {
    return { aggregator: 'count', field: null, fieldKind: null, fieldId: null, additionalFields: [] };
  }
  const aggregator = (raw.aggregator || 'count').toLowerCase();
  // Keep this allow-list in sync with measureSchema in validation.js.
  if (!['count', 'count_distinct', 'sum', 'avg', 'min', 'max'].includes(aggregator)) {
    throw new Error(`Unsupported aggregator: ${aggregator}`);
  }
  // additionalFields lets a single measure sum across multiple fields
  // per row before the aggregator runs across rows (e.g. children_impacted
  // = direct + indirect). Drop entries that lack a field reference so a
  // malformed config can't crash the engine.
  const additionalFields = Array.isArray(raw.additionalFields)
    ? raw.additionalFields
        .filter(f => f && (f.field || f.fieldId))
        .map(f => ({
          field: f.field || null,
          fieldKind: f.fieldKind || null,
          fieldId: f.fieldId || null,
        }))
    : [];
  return {
    aggregator,
    field: raw.field || null,
    fieldKind: raw.fieldKind || null,
    fieldId: raw.fieldId || null,
    additionalFields,
  };
}

function applySystemFilters(query, filters, lmicCodes) {
  for (const f of filters) {
    if (!f.field) continue;
    switch (f.operator) {
      case 'lmic': {
        // LMIC operator expands to "field IN (tenant codes)". We treat an
        // empty list as "match nothing" — returning every row would be a
        // surprising no-op when the tenant has cleared their LMIC list.
        const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
        query = query.in(f.field, codes.length > 0 ? codes : ['__never__']);
        break;
      }
      case 'eq':
        query = query.eq(f.field, f.value);
        break;
      case 'neq':
        query = query.neq(f.field, f.value);
        break;
      case 'gt':
        query = query.gt(f.field, f.value);
        break;
      case 'gte':
        query = query.gte(f.field, f.value);
        break;
      case 'lt':
        query = query.lt(f.field, f.value);
        break;
      case 'lte':
        query = query.lte(f.field, f.value);
        break;
      case 'in':
        if (Array.isArray(f.value)) query = query.in(f.field, f.value);
        break;
      case 'contains':
        if (f.value !== null && f.value !== undefined && f.value !== '') {
          query = query.ilike(f.field, `%${String(f.value)}%`);
        }
        break;
      case 'is_null':
        query = query.is(f.field, null);
        break;
      case 'is_not_null':
        query = query.not(f.field, 'is', null);
        break;
      default:
        break;
    }
  }
  return query;
}

function collectCustomFieldIds(config) {
  const ids = new Set();
  if (config.measure?.fieldKind === 'custom' && config.measure.fieldId) {
    ids.add(config.measure.fieldId);
  }
  // additionalFields entries (multi-field sum) also need hydration.
  (config.measure?.additionalFields || []).forEach(ref => {
    if (ref.fieldKind === 'custom' && ref.fieldId) ids.add(ref.fieldId);
  });
  if (config.groupBy?.kind === 'custom' && config.groupBy.fieldId) {
    ids.add(config.groupBy.fieldId);
  }
  if (config.timeBucket?.fieldKind === 'custom' && config.timeBucket.fieldId) {
    ids.add(config.timeBucket.fieldId);
  }
  (config.filters || []).forEach(f => {
    if (f.fieldKind === 'custom' && f.fieldId) ids.add(f.fieldId);
  });
  return ids;
}

async function loadPreferenceValues({ table, fkColumn, ids, fieldIds }) {
  const map = new Map();
  if (ids.length === 0 || fieldIds.length === 0) return map;
  // Chunk the ids list to avoid hitting URL length limits.
  const chunk = 500;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { data, error } = await supabase
      .from(table)
      .select(`${fkColumn}, field_id, value`)
      .in(fkColumn, slice)
      .in('field_id', fieldIds);
    if (error) {
      console.error('[Dashboard Aggregation] Preference fetch failed:', error.message);
      continue;
    }
    (data || []).forEach(row => {
      const ownerId = row[fkColumn];
      if (!map.has(ownerId)) map.set(ownerId, {});
      map.get(ownerId)[row.field_id] = parsePreferenceValue(row.value);
    });
  }
  return map;
}

function parsePreferenceValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return trimmed;
}

function valueFor(row, ref, prefMap) {
  if (!ref) return null;
  if (ref.fieldKind === 'custom' || ref.kind === 'custom') {
    const prefs = prefMap.get(row.id) || {};
    return extractPrimitive(prefs[ref.fieldId]);
  }
  return row[ref.field];
}

function extractPrimitive(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0];
    return typeof first === 'object' && first?.value !== undefined ? first.value : first;
  }
  return value;
}

function normaliseKey(value) {
  if (value === null || value === undefined || value === '') return 'Unspecified';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function aggregate(values, aggregator) {
  if (aggregator === 'count') {
    return values.length;
  }
  if (aggregator === 'count_distinct') {
    // Distinct count over non-empty values. Stringification keeps the
    // semantics consistent across system columns (which can return any
    // primitive) and custom preference values (which often arrive as
    // already-string JSONB extractions).
    const seen = new Set();
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s === '') continue;
      seen.add(s.toUpperCase());
    }
    return seen.size;
  }
  const numeric = values
    .map(v => (v === null || v === undefined || v === '' ? null : Number(v)))
    .filter(v => v !== null && !Number.isNaN(v));
  if (numeric.length === 0) return 0;
  switch (aggregator) {
    case 'sum': return numeric.reduce((a, b) => a + b, 0);
    case 'avg': return numeric.reduce((a, b) => a + b, 0) / numeric.length;
    case 'min': return Math.min(...numeric);
    case 'max': return Math.max(...numeric);
    default: return numeric.length;
  }
}

// Coerce a value for ordered comparison. ISO-style date strings compare
// by their parsed timestamp so a custom date field filter like
// `go_live >= '2026-01-01T00:00:00.000Z'` works correctly — a previous
// implementation used Number() on both sides which produced NaN and
// silently dropped every row.
function toComparable(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Detect anything that looks like a date string (full ISO or
    // calendar date) before falling back to numeric coercion.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compare(value, filterValue, op) {
  const a = toComparable(value);
  const b = toComparable(filterValue);
  if (a === null || b === null) return false;
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return false;
  }
}

function matchFilter(rawValue, filter, lmicCodes) {
  const value = extractPrimitive(rawValue);
  switch (filter.operator) {
    case 'lmic': {
      const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
      if (codes.length === 0) return false;
      const v = String(value ?? '').trim().toUpperCase();
      return codes.includes(v);
    }
    case 'eq': return String(value ?? '') === String(filter.value ?? '');
    case 'neq': return String(value ?? '') !== String(filter.value ?? '');
    case 'gt': return compare(value, filter.value, 'gt');
    case 'gte': return compare(value, filter.value, 'gte');
    case 'lt': return compare(value, filter.value, 'lt');
    case 'lte': return compare(value, filter.value, 'lte');
    case 'in':
      if (!Array.isArray(filter.value)) return false;
      return filter.value.map(String).includes(String(value ?? ''));
    case 'contains':
      if (filter.value === null || filter.value === undefined || filter.value === '') return true;
      return String(value ?? '').toLowerCase().includes(String(filter.value).toLowerCase());
    case 'is_null': return value === null || value === undefined || value === '';
    case 'is_not_null': return !(value === null || value === undefined || value === '');
    default: return true;
  }
}

function bucketTimestamp(raw, granularity) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  switch ((granularity || 'month').toLowerCase()) {
    case 'day':
      return d.toISOString().slice(0, 10);
    case 'week': {
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
      return monday.toISOString().slice(0, 10);
    }
    case 'month':
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case 'year':
      return String(d.getUTCFullYear());
    default:
      return d.toISOString().slice(0, 10);
  }
}
