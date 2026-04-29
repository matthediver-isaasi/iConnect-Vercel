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

  // Reject numeric aggregators against non-numeric fields up front. This
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
  if (timeBucket?.field) systemColumns.add(timeBucket.field);
  (config.filters || []).forEach(f => {
    if (f.fieldKind === 'system' && f.field) systemColumns.add(f.field);
  });

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
    q = applySystemFilters(q, systemFilters);
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
      return customFilters.every(f => matchFilter(prefs[f.fieldId], f));
    });
  }

  // Resolve a value for each row (used by sum/avg/min/max + as group key).
  const measureValueOf = row => valueFor(row, measure, prefMap);
  const groupKeyOf = groupBy
    ? row => normaliseKey(valueFor(row, groupBy, prefMap))
    : null;
  const timeKeyOf = timeBucket
    ? row => bucketTimestamp(row[timeBucket.field], timeBucket.granularity)
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
    return { aggregator: 'count', field: null, fieldKind: null, fieldId: null };
  }
  const aggregator = (raw.aggregator || 'count').toLowerCase();
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregator)) {
    throw new Error(`Unsupported aggregator: ${aggregator}`);
  }
  return {
    aggregator,
    field: raw.field || null,
    fieldKind: raw.fieldKind || null,
    fieldId: raw.fieldId || null,
  };
}

function applySystemFilters(query, filters) {
  for (const f of filters) {
    if (!f.field) continue;
    switch (f.operator) {
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
  if (config.groupBy?.kind === 'custom' && config.groupBy.fieldId) {
    ids.add(config.groupBy.fieldId);
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

function matchFilter(rawValue, filter) {
  const value = extractPrimitive(rawValue);
  switch (filter.operator) {
    case 'eq': return String(value ?? '') === String(filter.value ?? '');
    case 'neq': return String(value ?? '') !== String(filter.value ?? '');
    case 'gt': return Number(value) > Number(filter.value);
    case 'gte': return Number(value) >= Number(filter.value);
    case 'lt': return Number(value) < Number(filter.value);
    case 'lte': return Number(value) <= Number(filter.value);
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
