const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;
const EVENT_COLUMNS = 'id, start_date, status';
const SESSION_COLUMNS = 'id, complex_event_id, start_time';

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hasNoSchedule(status) {
  return status === 'tbc' || status === 'immediate';
}

/**
 * Produce the common dashboard event shape. A kind prefix prevents equal ids
 * in event and complex_event from colliding in count-distinct calculations.
 */
export function normaliseEventRow(row, eventKind, earliestSession = null) {
  const parentStart = validDate(row?.start_date);
  const effectiveStart = eventKind === 'complex'
    ? (validDate(earliestSession) || parentStart)
    : parentStart;
  return {
    id: `${eventKind}:${row.id}`,
    event_kind: eventKind,
    status: row.status ?? null,
    // TBC and immediate-access records intentionally have no schedule. Older
    // rows can retain a stale start_date, which must not leak into trends.
    event_start_date: hasNoSchedule(row.status) ? null : effectiveStart?.toISOString() || null,
  };
}

function nextUtcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/**
 * Event-only date matching. An lte value entered as YYYY-MM-DD means the whole
 * final UTC day, unlike the legacy generic-source timestamp comparison.
 */
export function matchEventFilter(row, filter, matchFilter) {
  const raw = row[filter.field];
  if (filter.field === 'event_start_date' && filter.operator === 'lte') {
    const exclusiveEnd = nextUtcDay(filter.value);
    if (exclusiveEnd) {
      const actual = validDate(raw);
      return !!actual && actual < exclusiveEnd;
    }
  }
  return matchFilter(raw, filter, null, false);
}

export async function fetchPaged(client, table, columns, tenantId, maxRows = MAX_ROWS) {
  const rows = [];
  let cursor = null;
  // Do not infer exhaustion from a short page: PostgREST installations may
  // enforce a server-side cap below our requested PAGE_SIZE. Continue from the
  // last unique id until an explicit empty page; keyset pagination also avoids
  // offset skips when rows are inserted/deleted during a scan.
  while (rows.length < maxRows) {
    const requested = Math.min(PAGE_SIZE, maxRows - rows.length);
    let query = client.from(table).select(columns);
    query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
    if (cursor !== null) query = query.gt('id', cursor);
    const { data, error } = await query
      .order('id', { ascending: true })
      .range(0, requested - 1);
    if (error) throw new Error(`Event source query failed (${table}): ${error.message}`);
    if (!Array.isArray(data)) {
      throw new Error(`Event source query failed (${table}): malformed or missing row data`);
    }
    const page = data;
    if (page.length > requested) {
      throw new Error(`Event source query failed (${table}): returned too many rows`);
    }
    if (page.length === 0) return rows;
    let previousId = cursor;
    for (const row of page) {
      const id = row?.id;
      if (id === null || id === undefined || id === ''
          || (previousId !== null && String(id) <= String(previousId))) {
        throw new Error(`Event source query failed (${table}): malformed or unstable row ordering`);
      }
      previousId = id;
    }
    cursor = previousId;
    rows.push(...page);
    if (rows.length >= maxRows) {
      throw new Error(
        `Event widget would scan more than ${maxRows} ${table} rows. Add filters to narrow the dataset.`,
      );
    }
  }
  throw new Error(
    `Event widget would scan more than ${maxRows} ${table} rows. Add filters to narrow the dataset.`,
  );
}

export async function loadEventRows(client, tenantId, maxRows = MAX_ROWS) {
  const [simple, complex] = await Promise.all([
    fetchPaged(client, 'event', EVENT_COLUMNS, tenantId, maxRows),
    fetchPaged(client, 'complex_event', EVENT_COLUMNS, tenantId, maxRows),
  ]);
  if (simple.length + complex.length > maxRows) {
    throw new Error(
      `Event widget would scan more than ${maxRows} events. Add filters to narrow the dataset.`,
    );
  }

  // Sessions are loaded tenant-wide rather than through an unbounded IN-list.
  // Parent membership is checked below, so orphan/cross-parent rows cannot
  // affect an event. Errors fail closed: silently falling back to parent dates
  // would put complex events into the wrong period.
  const sessions = complex.length > 0
    ? await fetchPaged(client, 'complex_event_session', SESSION_COLUMNS, tenantId, maxRows)
    : [];
  const complexIds = new Set(complex.map(row => String(row.id)));
  const earliestByEvent = new Map();
  for (const session of sessions) {
    const parentId = String(session.complex_event_id || '');
    if (!complexIds.has(parentId)) continue;
    const date = validDate(session.start_time);
    if (!date) continue;
    const current = earliestByEvent.get(parentId);
    if (!current || date < current) earliestByEvent.set(parentId, date);
  }

  return [
    ...simple.map(row => normaliseEventRow(row, 'simple')),
    ...complex.map(row =>
      normaliseEventRow(row, 'complex', earliestByEvent.get(String(row.id)) || null)),
  ];
}

/**
 * Bespoke event inventory aggregation. It deliberately includes group-scoped
 * events: dashboard reporting is tenant-wide and must not vary with the
 * viewing member's group memberships.
 */
export async function runEventWidgetConfig(
  config,
  tenantId,
  source,
  maxGroups,
  options = {},
  helpers,
) {
  const { validateEventsConfig } = await import('../../../shared/eventsWidgetContract.js');
  validateEventsConfig(config);

  const {
    aggregate,
    bucketTimestamp,
    finalizeTimeRows,
    matchFilter,
  } = helpers;
  const client = options.client;
  if (!client) throw new Error('Database not configured');

  const rows = await loadEventRows(client, tenantId);
  const filters = config.filters || [];
  let workingRows = rows.filter(row =>
    filters.every(filter => matchEventFilter(row, filter, matchFilter)));
  const measure = config.measure || { aggregator: 'count' };
  const groupBy = config.groupBy || null;
  const timeBucket = config.timeBucket || null;
  if (groupBy && timeBucket) {
    throw new Error('Choose either group-by or time-bucket, not both');
  }
  const valueOf = row => measure.field ? row[measure.field] : row.id;

  if (!groupBy && !timeBucket) {
    const value = aggregate(workingRows.map(valueOf), measure.aggregator);
    return {
      type: 'scalar',
      total: workingRows.length,
      value,
      rows: [{ key: 'total', value }],
    };
  }

  if (groupBy) {
    const buckets = new Map();
    for (const row of workingRows) {
      const rawKey = row[groupBy.field];
      const key = rawKey === null || rawKey === undefined || rawKey === ''
        ? 'Unspecified'
        : String(rawKey);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(valueOf(row));
    }
    const grouped = Array.from(buckets, ([key, values]) => ({
      key,
      value: aggregate(values, measure.aggregator),
    })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    if (grouped.length > maxGroups) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${maxGroups}). Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories: ['value'],
      rows: grouped,
    };
  }

  const buckets = new Map();
  for (const row of workingRows) {
    const key = bucketTimestamp(row[timeBucket.field], timeBucket.granularity);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(valueOf(row));
  }
  return {
    type: 'time',
    total: workingRows.length,
    categories: ['value'],
    rows: finalizeTimeRows(buckets, timeBucket, measure.aggregator, config.cumulative),
    granularity: timeBucket.granularity,
  };
}