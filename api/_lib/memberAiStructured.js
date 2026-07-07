// Task #2419: Member AI structured data Q&A (counts from the database).
//
// Lets the member AI assistant answer numerical/aggregate questions
// ("how many schools are in South Africa?", "how many events this year?")
// from live records instead of indexed text. The LLM NEVER writes SQL —
// it only fills a small, whitelisted query spec (entity + approved filter
// fields + count / count-by aggregation + optional date range) which is
// validated here and executed by a tenant-scoped executor with the member's
// visibility baked in, mirroring the existing member-facing surfaces:
//
//   - organizations/members : what active dynamic directories expose
//     (show_in_directory / login_enabled rules, directory filter fields,
//     org excluded ids) — api/public/dynamic-directory.js
//   - events/complex events : published/tbc, never draft, group-visible for
//     the asking member — api/public/events.js + memberContentVisibility.js
//   - resources             : status active, allowed_role_ids, member groups
//     — api/public/resources.js
//   - bookings              : AGGREGATE counts only, and only on events the
//     member can see. Never other members' individual booking details.
//
// PostgREST caps responses at 1000 rows, so the executor always paginates —
// it never counts a truncated page.
//
// Pure pieces (spec validation, visibility predicates, filter matching) are
// exported for unit tests (memberAiStructured.test.mjs); DB access lives only
// in executeQuerySpec / the fetch helpers.

// ---------------------------------------------------------------------------
// Whitelisted entity catalog
// ---------------------------------------------------------------------------

export const MAX_FILTERS = 4;
export const MAX_FILTER_VALUE_LEN = 200;
export const MAX_GROUPS = 25;
const PAGE_SIZE = 1000;
const MAX_PAGES = 25; // hard cap: 25k rows scanned per fetch

export const STRUCTURED_ENTITIES = {
  organization: {
    table: 'organization',
    label: 'organizations / companies / institutions',
    featureKey: 'membership.organisation-directory',
    prefScope: 'organization',
    directoryEntityType: 'organization',
    nativeFields: {
      name: { type: 'text', groupable: false },
      address: { type: 'text', groupable: false },
      tags: { type: 'array', groupable: true },
    },
    dateFields: {},
  },
  member: {
    table: 'member',
    label: 'members / people',
    featureKey: 'membership.member-directory',
    prefScope: 'member',
    directoryEntityType: 'member',
    nativeFields: {
      job_title: { type: 'text', groupable: true },
      tags: { type: 'array', groupable: true },
    },
    dateFields: {},
  },
  event: {
    table: 'event',
    label: 'events (simple)',
    featureKey: 'events.browse-events',
    prefScope: null,
    nativeFields: {
      title: { type: 'text', groupable: false },
      event_type: { type: 'text', groupable: true },
      location: { type: 'text', groupable: true },
    },
    dateFields: { start_date: true },
  },
  complex_event: {
    table: 'complex_event',
    label: 'complex / multi-session events (conferences)',
    featureKey: 'events.browse-events',
    prefScope: null,
    nativeFields: {
      title: { type: 'text', groupable: false },
      event_type: { type: 'text', groupable: true },
      location: { type: 'text', groupable: true },
    },
    dateFields: { start_date: true },
  },
  resource: {
    table: 'resource',
    label: 'resources / documents / library items',
    featureKey: 'content.resources',
    prefScope: null,
    nativeFields: {
      title: { type: 'text', groupable: false },
      resource_type: { type: 'text', groupable: true },
      subcategories: { type: 'array', groupable: true },
      tags: { type: 'array', groupable: true },
    },
    dateFields: { release_date: true },
  },
  booking: {
    table: 'booking',
    label: 'event bookings / registrations (simple events) — aggregate counts only',
    featureKey: 'events.browse-events',
    prefScope: null,
    aggregateOnly: true,
    nativeFields: {
      event_title: { type: 'text', groupable: true },
    },
    dateFields: { event_start_date: true },
  },
  complex_event_booking: {
    table: 'complex_event_booking',
    label:
      'bookings / registrations for complex events (conferences) — aggregate counts only',
    featureKey: 'events.browse-events',
    prefScope: null,
    aggregateOnly: true,
    nativeFields: {
      event_title: { type: 'text', groupable: true },
    },
    dateFields: { event_start_date: true },
  },
};

const FILTER_OPS = new Set(['eq', 'contains']);

// ---------------------------------------------------------------------------
// Query spec validation (pure)
// ---------------------------------------------------------------------------

// Resolve a spec field reference against the whitelist. Returns
// { kind: 'column', field } | { kind: 'preference', fieldId, label } | null.
// Preference fields may be referenced as `pref:<id>`, by raw id, or by
// case-insensitive label.
function resolveField(ref, catalogEntry, prefFields) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const raw = ref.trim();
  if (catalogEntry.nativeFields[raw]) {
    return { kind: 'column', field: raw };
  }
  if (!catalogEntry.prefScope) return null;
  const scoped = (prefFields || []).filter(
    (f) => f.entity_scope === catalogEntry.prefScope && f.is_active !== false
  );
  const idRef = raw.startsWith('pref:') ? raw.slice(5) : raw;
  const byId = scoped.find((f) => f.id === idRef);
  if (byId) return { kind: 'preference', fieldId: byId.id, label: byId.label };
  const lower = raw.toLowerCase();
  const byLabel = scoped.find(
    (f) => typeof f.label === 'string' && f.label.toLowerCase() === lower
  );
  if (byLabel) {
    return { kind: 'preference', fieldId: byLabel.id, label: byLabel.label };
  }
  return null;
}

function parseIsoDate(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validate + normalize a raw LLM-produced query spec against the whitelist.
 *
 * @param {object} raw        spec from the planner LLM
 * @param {object} opts
 *   - prefFields {Array}     tenant preference fields (id, label, entity_scope, is_active)
 * @returns {{ok:true, spec:object} | {ok:false, reason:string}}
 */
export function validateQuerySpec(raw, { prefFields = [] } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'Spec must be an object' };
  }
  const catalogEntry = STRUCTURED_ENTITIES[raw.entity];
  if (!catalogEntry) {
    return { ok: false, reason: `Unknown entity: ${String(raw.entity)}` };
  }

  const aggregation = raw.aggregation;
  if (aggregation !== 'count' && aggregation !== 'count_by') {
    return { ok: false, reason: `Unsupported aggregation: ${String(aggregation)}` };
  }

  // groupBy (only for count_by)
  let groupBy = null;
  if (aggregation === 'count_by') {
    const resolved = resolveField(raw.groupBy, catalogEntry, prefFields);
    if (!resolved) {
      return { ok: false, reason: `Unknown group-by field: ${String(raw.groupBy)}` };
    }
    if (
      resolved.kind === 'column' &&
      !catalogEntry.nativeFields[resolved.field].groupable
    ) {
      return { ok: false, reason: `Field not groupable: ${resolved.field}` };
    }
    groupBy = resolved;
  } else if (raw.groupBy) {
    return { ok: false, reason: 'groupBy is only allowed with count_by' };
  }

  // filters
  const rawFilters = Array.isArray(raw.filters) ? raw.filters : [];
  if (rawFilters.length > MAX_FILTERS) {
    return { ok: false, reason: `Too many filters (max ${MAX_FILTERS})` };
  }
  const filters = [];
  for (const f of rawFilters) {
    if (!f || typeof f !== 'object') {
      return { ok: false, reason: 'Invalid filter' };
    }
    const resolved = resolveField(f.field, catalogEntry, prefFields);
    if (!resolved) {
      return { ok: false, reason: `Unknown filter field: ${String(f.field)}` };
    }
    const op = f.op || 'eq';
    if (!FILTER_OPS.has(op)) {
      return { ok: false, reason: `Unsupported filter op: ${String(f.op)}` };
    }
    const value = f.value;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return { ok: false, reason: 'Filter value must be a string or number' };
    }
    const strValue = String(value).trim();
    if (!strValue || strValue.length > MAX_FILTER_VALUE_LEN) {
      return { ok: false, reason: 'Filter value empty or too long' };
    }
    filters.push({ ...resolved, op, value: strValue });
  }

  // dateRange
  let dateRange = null;
  if (raw.dateRange && typeof raw.dateRange === 'object') {
    const field = raw.dateRange.field;
    if (!catalogEntry.dateFields[field]) {
      return { ok: false, reason: `Unknown date field: ${String(field)}` };
    }
    const from = raw.dateRange.from ? parseIsoDate(raw.dateRange.from) : null;
    const to = raw.dateRange.to ? parseIsoDate(raw.dateRange.to) : null;
    if (raw.dateRange.from && !from) {
      return { ok: false, reason: 'Invalid dateRange.from' };
    }
    if (raw.dateRange.to && !to) {
      return { ok: false, reason: 'Invalid dateRange.to' };
    }
    if (!from && !to) {
      return { ok: false, reason: 'dateRange requires from and/or to' };
    }
    dateRange = { field, from, to };
  }

  return {
    ok: true,
    spec: { entity: raw.entity, aggregation, groupBy, filters, dateRange },
  };
}

// ---------------------------------------------------------------------------
// Visibility predicates (pure) — mirror the member-facing browse surfaces
// ---------------------------------------------------------------------------

const DELETED_EMAIL_RE = /^deleted_.*@deleted\.local$/i;

// Mirrors api/public/dynamic-directory.js renderMembers base filter.
export function isMemberRowVisible(row) {
  if (!row) return false;
  if (row.show_in_directory === false) return false;
  if (row.login_enabled === false) return false;
  if (typeof row.email === 'string' && DELETED_EMAIL_RE.test(row.email)) {
    return false;
  }
  return true;
}

// Mirrors the org directory surface: all tenant orgs except explicitly
// excluded ones (org display settings excludedOrgIds).
export function isOrgRowVisible(row, { excludedOrgIds } = {}) {
  if (!row) return false;
  if (excludedOrgIds && excludedOrgIds.has(row.id)) return false;
  return true;
}

// Mirrors api/public/events.js + memberContentVisibility.js: published/tbc,
// never draft, group events only for members of the group (or when public).
export function isEventRowVisible(row, { isAdmin = false, groupIds = new Set() } = {}) {
  if (!row) return false;
  if (!['published', 'tbc'].includes(row.status)) return false;
  if (row.event_state === 'draft') return false;
  if (!isAdmin && row.member_group_id) {
    if (row.group_event_public !== true && !groupIds.has(row.member_group_id)) {
      return false;
    }
  }
  return true;
}

// Complex events additionally restrict event_state to null/active/closed
// (mirrors api/public/complex-events.js).
export function isComplexEventRowVisible(row, ctx) {
  if (!row) return false;
  const state = row.event_state;
  if (state != null && state !== 'active' && state !== 'closed') return false;
  return isEventRowVisible(row, ctx);
}

// Mirrors api/public/resources.js + memberContentVisibility.js: active only,
// group-gated, role-gated (admins bypass member gating).
export function isResourceRowVisible(
  row,
  { isAdmin = false, roleId = null, groupIds = new Set() } = {}
) {
  if (!row) return false;
  if (row.status !== 'active') return false;
  if (isAdmin) return true;
  if (row.member_group_id && !groupIds.has(row.member_group_id)) return false;
  const allowed = row.allowed_role_ids;
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (!roleId || !allowed.includes(roleId)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Filter matching (pure)
// ---------------------------------------------------------------------------

function normStr(v) {
  return String(v ?? '').trim().toLowerCase();
}

// Preference values are stored as TEXT: plain strings or JSON-stringified
// arrays (multi-selects). Same semantics as the public directory's
// matchesValue, extended with a `contains` op.
export function prefValueEntries(stored) {
  if (stored == null) return [];
  if (Array.isArray(stored)) return stored.map((v) => String(v));
  if (typeof stored === 'string') {
    const t = stored.trim();
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) return arr.map((v) => String(v));
      } catch {
        /* fall through — treat as scalar */
      }
    }
    return t === '' ? [] : [t];
  }
  return [String(stored)];
}

export function matchesPrefValue(stored, op, filterValue) {
  const entries = prefValueEntries(stored);
  const needle = normStr(filterValue);
  if (op === 'contains') {
    return entries.some((e) => normStr(e).includes(needle));
  }
  return entries.some((e) => normStr(e) === needle);
}

export function matchesColumnFilter(row, filter, catalogEntry) {
  const def = catalogEntry.nativeFields[filter.field];
  const rawVal = row[filter.field];
  const needle = normStr(filter.value);
  if (def?.type === 'array') {
    const arr = Array.isArray(rawVal) ? rawVal : prefValueEntries(rawVal);
    if (filter.op === 'contains') {
      return arr.some((e) => normStr(e).includes(needle));
    }
    return arr.some((e) => normStr(e) === needle);
  }
  const s = normStr(rawVal);
  if (filter.op === 'contains') return s.includes(needle);
  return s === needle;
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

// Group rows by a value-extractor that may return a scalar or an array of
// values (multi-select preference fields count once per selected value).
export function groupAndCount(rows, getValues) {
  const buckets = new Map();
  for (const row of rows) {
    let values = getValues(row);
    if (!Array.isArray(values)) values = [values];
    const cleaned = values
      .map((v) => (v == null || String(v).trim() === '' ? null : String(v).trim()))
      .filter((v, i, a) => a.indexOf(v) === i);
    const finalValues = cleaned.length > 0 ? cleaned : [null];
    for (const v of finalValues) {
      const key = v == null ? '(not set)' : v;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  const groups = [...buckets.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  let truncated = false;
  let shown = groups;
  if (groups.length > MAX_GROUPS) {
    truncated = true;
    const head = groups.slice(0, MAX_GROUPS);
    const rest = groups.slice(MAX_GROUPS).reduce((s, g) => s + g.count, 0);
    head.push({ value: '(other)', count: rest });
    shown = head;
  }
  return { groups: shown, truncated };
}

// ---------------------------------------------------------------------------
// DB helpers (paginated — never trust a single PostgREST page as a full set)
// ---------------------------------------------------------------------------

async function fetchAllRows(makeQuery) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await makeQuery().range(
      page * PAGE_SIZE,
      (page + 1) * PAGE_SIZE - 1
    );
    if (error) throw new Error(error.message || 'Query failed');
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new Error('Dataset too large to aggregate safely');
}

// Fetch preference values for a set of field ids, returning
// Map<fieldId, Map<entityId, storedValue>>.
async function fetchPrefValueMaps(supabase, scope, fieldIds) {
  const table =
    scope === 'organization' ? 'organization_preference_value' : 'member_preference_value';
  const idCol = scope === 'organization' ? 'organization_id' : 'member_id';
  const maps = new Map();
  for (const id of fieldIds) maps.set(id, new Map());
  if (fieldIds.length === 0) return maps;
  const rows = await fetchAllRows(() =>
    supabase
      .from(table)
      .select(`${idCol}, field_id, value`)
      .in('field_id', fieldIds)
  );
  for (const r of rows) {
    const m = maps.get(r.field_id);
    if (m) m.set(r[idCol], r.value);
  }
  return maps;
}

// Mirrors the directory pages' visibility parsing (parseVisibility /
// isVisibleInMain): a pref field is member-visible when its
// directory_visibility JSON includes 'main', falling back to the
// show_in_directory_card / show_in_member_directory flags.
export function isPrefFieldDirectoryVisible(field) {
  if (!field || field.is_active === false) return false;
  let vis = field.directory_visibility;
  if (typeof vis === 'string') {
    try {
      vis = JSON.parse(vis);
    } catch {
      vis = null;
    }
  }
  let ids = null;
  if (Array.isArray(vis)) ids = vis;
  else if (vis && typeof vis === 'object' && Array.isArray(vis.ids)) ids = vis.ids;
  if (ids) return ids.includes('main');
  if (field.entity_scope === 'organization') {
    return field.show_in_directory_card !== false;
  }
  return field.show_in_member_directory !== false;
}

export async function fetchStructuredPrefFields(supabase, tenantId) {
  const { data } = await supabase
    .from('preference_field')
    .select(
      'id, label, entity_scope, field_type, options, is_active, directory_visibility, show_in_directory_card, show_in_member_directory'
    )
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('entity_scope', ['member', 'organization']);
  return (data || []).filter(isPrefFieldDirectoryVisible);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function describeFilters(spec) {
  const parts = [];
  for (const f of spec.filters) {
    const name = f.kind === 'preference' ? f.label : f.field;
    parts.push(`${name} ${f.op === 'contains' ? 'contains' : '='} "${f.value}"`);
  }
  if (spec.dateRange) {
    const { field, from, to } = spec.dateRange;
    if (from && to) {
      parts.push(
        `${field} between ${from.toISOString().slice(0, 10)} and ${to
          .toISOString()
          .slice(0, 10)}`
      );
    } else if (from) parts.push(`${field} on/after ${from.toISOString().slice(0, 10)}`);
    else if (to) parts.push(`${field} on/before ${to.toISOString().slice(0, 10)}`);
  }
  return parts;
}

function applyNativeAndDateFilters(rows, spec, catalogEntry) {
  let out = rows;
  for (const f of spec.filters) {
    if (f.kind !== 'column') continue;
    out = out.filter((r) => matchesColumnFilter(r, f, catalogEntry));
  }
  if (spec.dateRange) {
    const { field, from, to } = spec.dateRange;
    out = out.filter((r) => {
      const raw = r[field];
      if (!raw) return false;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  return out;
}

function applyPrefFilters(rows, spec, prefMaps, idKey = 'id') {
  let out = rows;
  for (const f of spec.filters) {
    if (f.kind !== 'preference') continue;
    const m = prefMaps.get(f.fieldId) || new Map();
    out = out.filter((r) => matchesPrefValue(m.get(r[idKey]), f.op, f.value));
  }
  return out;
}

function buildResult(spec, rows, catalogEntry, prefMaps) {
  const appliedFilters = describeFilters(spec);
  if (spec.aggregation === 'count') {
    return { total: rows.length, groups: null, truncated: false, appliedFilters };
  }
  const gb = spec.groupBy;
  const getValues =
    gb.kind === 'preference'
      ? (r) => prefValueEntries((prefMaps.get(gb.fieldId) || new Map()).get(r.id))
      : (r) => {
          const def = catalogEntry.nativeFields[gb.field];
          const v = r[gb.field];
          return def?.type === 'array'
            ? Array.isArray(v)
              ? v
              : prefValueEntries(v)
            : v;
        };
  const { groups, truncated } = groupAndCount(rows, getValues);
  return {
    total: rows.length,
    groupByLabel: gb.kind === 'preference' ? gb.label : gb.field,
    groups,
    truncated,
    appliedFilters,
  };
}

function prefFieldIdsInSpec(spec) {
  const ids = new Set();
  for (const f of spec.filters) if (f.kind === 'preference') ids.add(f.fieldId);
  if (spec.groupBy?.kind === 'preference') ids.add(spec.groupBy.fieldId);
  return [...ids];
}

// Resolve the set of directory-restricted entity ids for a directory entity
// (member/organization). Tenants without ANY dynamic_directory rows use the
// legacy directory pages, which expose all rows (subject to the base
// predicates + the feature gate) — so zero rows means unrestricted (null).
// If directories exist but none is active, the tenant has deliberately
// unpublished them and we refuse ({code:'no_directory'}). Otherwise the
// visible set is the union of what the active directories expose.
async function resolveDirectoryRestriction(supabase, tenantId, entityType, prefScope) {
  const { data: dirs, error } = await supabase
    .from('dynamic_directory')
    .select('id, filter_field_id, filter_value, is_active')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType);
  if (error) throw new Error(error.message);
  if (!dirs || dirs.length === 0) return null; // legacy directory: unrestricted
  const active = dirs.filter((d) => d.is_active === true);
  if (active.length === 0) {
    const e = new Error('No active directory exposes this data');
    e.code = 'no_directory';
    throw e;
  }
  const filtered = active.filter((d) => d.filter_field_id && d.filter_value);
  if (filtered.length < active.length) return null; // an unfiltered active directory exists
  const fieldIds = [...new Set(filtered.map((d) => d.filter_field_id))];
  const maps = await fetchPrefValueMaps(supabase, prefScope, fieldIds);
  const allowed = new Set();
  for (const d of filtered) {
    const m = maps.get(d.filter_field_id) || new Map();
    for (const [entityId, stored] of m.entries()) {
      if (matchesPrefValue(stored, 'eq', d.filter_value)) allowed.add(entityId);
    }
  }
  return allowed;
}

async function fetchExcludedOrgIds(supabase, tenantId) {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'org_directory_excluded_orgs');
  const raw = data?.[0]?.setting_value;
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function execDirectoryEntity({ supabase, tenantId, spec, viewer, catalogEntry }) {
  const entityType = catalogEntry.directoryEntityType;

  let restriction = null;
  let excludedOrgIds = null;
  if (!viewer.isAdmin) {
    restriction = await resolveDirectoryRestriction(
      supabase,
      tenantId,
      entityType,
      catalogEntry.prefScope
    );
    if (entityType === 'organization') {
      excludedOrgIds = await fetchExcludedOrgIds(supabase, tenantId);
    }
  }

  const columns =
    entityType === 'member'
      ? 'id, job_title, tags, show_in_directory, login_enabled, email'
      : 'id, name, address, tags';
  let rows = await fetchAllRows(() =>
    supabase.from(catalogEntry.table).select(columns).eq('tenant_id', tenantId)
  );

  if (!viewer.isAdmin) {
    rows =
      entityType === 'member'
        ? rows.filter((r) => isMemberRowVisible(r))
        : rows.filter((r) => isOrgRowVisible(r, { excludedOrgIds }));
    if (restriction) rows = rows.filter((r) => restriction.has(r.id));
  } else if (entityType === 'member') {
    // Even admins shouldn't count soft-deleted placeholder accounts.
    rows = rows.filter(
      (r) => !(typeof r.email === 'string' && DELETED_EMAIL_RE.test(r.email))
    );
  }

  const prefMaps = await fetchPrefValueMaps(
    supabase,
    catalogEntry.prefScope,
    prefFieldIdsInSpec(spec)
  );
  rows = applyNativeAndDateFilters(rows, spec, catalogEntry);
  rows = applyPrefFilters(rows, spec, prefMaps);
  return buildResult(spec, rows, catalogEntry, prefMaps);
}

async function fetchVisibleEvents({ supabase, tenantId, viewer, complex }) {
  const table = complex ? 'complex_event' : 'event';
  const rows = await fetchAllRows(() =>
    supabase
      .from(table)
      .select(
        'id, title, status, event_state, member_group_id, group_event_public, event_type, location, start_date, end_date'
      )
      .eq('tenant_id', tenantId)
      .in('status', ['published', 'tbc'])
  );
  const ctx = { isAdmin: viewer.isAdmin, groupIds: viewer.groupIds };
  return rows.filter((r) =>
    complex ? isComplexEventRowVisible(r, ctx) : isEventRowVisible(r, ctx)
  );
}

async function execEvents({ supabase, tenantId, spec, viewer, catalogEntry }) {
  let rows = await fetchVisibleEvents({
    supabase,
    tenantId,
    viewer,
    complex: spec.entity === 'complex_event',
  });
  rows = applyNativeAndDateFilters(rows, spec, catalogEntry);
  return buildResult(spec, rows, catalogEntry, new Map());
}

async function execResources({ supabase, tenantId, spec, viewer, catalogEntry }) {
  let rows = await fetchAllRows(() =>
    supabase
      .from('resource')
      .select(
        'id, title, status, member_group_id, allowed_role_ids, resource_type, subcategories, tags, release_date'
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
  );
  rows = rows.filter((r) =>
    isResourceRowVisible(r, {
      isAdmin: viewer.isAdmin,
      roleId: viewer.roleId,
      groupIds: viewer.groupIds,
    })
  );
  rows = applyNativeAndDateFilters(rows, spec, catalogEntry);
  return buildResult(spec, rows, catalogEntry, new Map());
}

// Bookings are AGGREGATE-ONLY: counts of confirmed bookings on events the
// member can see. No attendee identities are ever fetched or returned.
async function execBookings({ supabase, tenantId, spec, viewer, catalogEntry }) {
  const complex = spec.entity === 'complex_event_booking';
  let events = await fetchVisibleEvents({ supabase, tenantId, viewer, complex });

  // Event-level filters (title / event start date) narrow the visible events.
  for (const f of spec.filters) {
    if (f.kind !== 'column' || f.field !== 'event_title') continue;
    const needle = normStr(f.value);
    events = events.filter((e) => {
      const t = normStr(e.title);
      return f.op === 'contains' ? t.includes(needle) : t === needle;
    });
  }
  if (spec.dateRange && spec.dateRange.field === 'event_start_date') {
    const { from, to } = spec.dateRange;
    events = events.filter((e) => {
      if (!e.start_date) return false;
      const d = new Date(e.start_date);
      if (Number.isNaN(d.getTime())) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  const visibleIds = new Set(events.map((e) => e.id));
  const titleById = new Map(events.map((e) => [e.id, e.title]));
  const appliedFilters = describeFilters(spec);
  if (visibleIds.size === 0) {
    return spec.aggregation === 'count'
      ? { total: 0, groups: null, truncated: false, appliedFilters }
      : {
          total: 0,
          groupByLabel: 'event',
          groups: [],
          truncated: false,
          appliedFilters,
        };
  }

  const table = complex ? 'complex_event_booking' : 'booking';
  const bookingRows = await fetchAllRows(() =>
    supabase
      .from(table)
      .select('event_id, status')
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .in('event_id', [...visibleIds])
  );

  if (spec.aggregation === 'count') {
    return {
      total: bookingRows.length,
      groups: null,
      truncated: false,
      appliedFilters,
    };
  }
  const { groups, truncated } = groupAndCount(bookingRows, (b) =>
    titleById.get(b.event_id) || '(unknown event)'
  );
  return {
    total: bookingRows.length,
    groupByLabel: 'event',
    groups,
    truncated,
    appliedFilters,
  };
}

/**
 * Execute a validated query spec, with visibility baked in.
 *
 * @param {object} args
 *   - supabase   service-role client
 *   - tenantId   asking member's tenant (hard scope)
 *   - spec       normalized spec from validateQuerySpec
 *   - viewer     { isAdmin, roleId, groupIds:Set, canAccessFeature(key) }
 * @returns {{ok:true, result:object} | {ok:false, reason:string}}
 */
export async function executeQuerySpec({ supabase, tenantId, spec, viewer }) {
  const catalogEntry = STRUCTURED_ENTITIES[spec.entity];
  if (!catalogEntry) return { ok: false, reason: 'Unknown entity' };
  if (!tenantId) return { ok: false, reason: 'Tenant required' };

  // Feature gate: mirror the RBAC exclusions used by the browse surfaces.
  if (
    catalogEntry.featureKey &&
    typeof viewer?.canAccessFeature === 'function' &&
    !viewer.canAccessFeature(catalogEntry.featureKey)
  ) {
    return { ok: false, reason: 'This data is not available to you' };
  }

  const args = { supabase, tenantId, spec, viewer, catalogEntry };
  try {
    let result;
    if (spec.entity === 'organization' || spec.entity === 'member') {
      result = await execDirectoryEntity(args);
    } else if (spec.entity === 'event' || spec.entity === 'complex_event') {
      result = await execEvents(args);
    } else if (spec.entity === 'resource') {
      result = await execResources(args);
    } else if (spec.entity === 'booking' || spec.entity === 'complex_event_booking') {
      result = await execBookings(args);
    } else {
      return { ok: false, reason: 'Unsupported entity' };
    }
    return { ok: true, result: { entity: spec.entity, ...result } };
  } catch (err) {
    if (err?.code === 'no_directory') {
      return { ok: false, reason: 'This data is not exposed in any directory' };
    }
    console.error('[Member AI Structured] execution error:', err?.message || err);
    return { ok: false, reason: 'Query failed' };
  }
}

// ---------------------------------------------------------------------------
// Intent pre-gate + planner prompt helpers
// ---------------------------------------------------------------------------

// Cheap heuristic: only run the (LLM) planner for questions that look like
// count/aggregate/breakdown questions. Content questions skip straight to RAG.
const STRUCTURED_HINT_RE =
  /\b(how many|number of|count of|count the|total (number|count)|breakdown|break down|per (country|city|region|category|type|role|group|year|month|location|tier)|by (country|city|region|category|type|year|month|location)|(most|fewest) (bookings|registrations|attendees|members|organi[sz]ations))\b/i;

export function looksLikeStructuredQuestion(question) {
  return STRUCTURED_HINT_RE.test(String(question || ''));
}

function safeParseOptions(options) {
  if (Array.isArray(options)) return options;
  if (typeof options === 'string') {
    try {
      const p = JSON.parse(options);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Human-readable whitelist catalog embedded in the planner prompt so the LLM
// can resolve tenant vocabulary ("schools" -> a custom field value etc.).
export function buildPlannerCatalog(prefFields = []) {
  const lines = [];
  for (const [entity, cfg] of Object.entries(STRUCTURED_ENTITIES)) {
    const fieldBits = Object.entries(cfg.nativeFields).map(
      ([name, def]) =>
        `${name} (${def.type}${def.groupable ? ', groupable' : ''})`
    );
    const dateBits = Object.keys(cfg.dateFields);
    let line = `- entity "${entity}" — ${cfg.label}. Fields: ${fieldBits.join(', ') || 'none'}.`;
    if (dateBits.length) line += ` Date-range fields: ${dateBits.join(', ')}.`;
    if (cfg.prefScope) {
      const scoped = prefFields.filter(
        (f) => f.entity_scope === cfg.prefScope && f.is_active !== false
      );
      if (scoped.length) {
        const custom = scoped
          .slice(0, 40)
          .map((f) => {
            const opts = safeParseOptions(f.options)
              .map((o) => (o && typeof o === 'object' ? o.label || o.value : o))
              .filter(Boolean)
              .slice(0, 20);
            return `"pref:${f.id}" = "${f.label}"${opts.length ? ` (options: ${opts.join(' | ')})` : ''}`;
          })
          .join('; ');
        line += ` Custom fields (usable as filter field or groupBy, all groupable): ${custom}.`;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function buildPlannerMessages(question, prefFields) {
  const catalog = buildPlannerCatalog(prefFields);
  const system =
    'You classify a member-portal question and, if it is a structured-data ' +
    'question (a count, total, or breakdown over database records), translate ' +
    'it into a constrained query spec. You may ONLY use the entities and ' +
    'fields listed below — never invent fields.\n\n' +
    'Available entities and fields:\n' +
    catalog +
    '\n\nSpec format: {"entity": "...", "aggregation": "count"|"count_by", ' +
    '"groupBy": "<field>" (only for count_by), ' +
    '"filters": [{"field": "<field or pref:id>", "op": "eq"|"contains", "value": "..."}], ' +
    '"dateRange": {"field": "<date field>", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} (optional)}\n\n' +
    'Rules:\n' +
    '- Respond with JSON only: {"structured": true, "spec": {...}} or {"structured": false}.\n' +
    '- Map tenant vocabulary to custom fields where they clearly match (e.g. ' +
    '"schools" may correspond to a custom field value or simply mean the ' +
    'organization entity — prefer a filter only when a listed field/option matches).\n' +
    '- Use "eq" for exact category/option/country matches, "contains" for partial text.\n' +
    '- Questions about what content SAYS (summaries, explanations, newsletters, ' +
    'advice) are NOT structured — answer {"structured": false}.\n' +
    '- If the question is a count/breakdown but cannot be expressed with the ' +
    'listed entities/fields, answer {"structured": true, "spec": null}.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
}
