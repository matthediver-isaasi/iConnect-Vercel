import { tenantFilter } from './permissions.js';
import { GROUP_CUSTOM_TYPES, validateMemberGroupConfig } from './memberGroupContract.js';
import { matchWidgetDateFilter } from './widgetFilterDates.js';

const PAGE = 1000;
export const MEMBER_GROUP_ROW_CAP = 50000;
const MEMBER_FIELDS = ['role_id', 'organization_id', 'login_enabled'];

// Always probe beyond a full final page. Never return a silently truncated metric.
export async function readMemberGroupPages(makeQuery, cap = MEMBER_GROUP_ROW_CAP) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await makeQuery().range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Member Groups query failed: ${error.message || error}`);
    if (!Array.isArray(data)) throw new Error('Member Groups query returned no data');
    rows.push(...data);
    if (rows.length > cap) throw new Error(`Member Groups exceeds the ${cap} row safety limit; narrow the dataset`);
    if (data.length < PAGE) return rows;
  }
}

export async function loadMemberGroupCustomFields(client, tenantId) {
  const fields = await readMemberGroupPages(() => tenantFilter(client.from('preference_field')
    .select('id,name,label,field_type,options').eq('entity_scope', 'member')
    .eq('is_active', true), tenantId).order('id'));
  return fields.filter(f => GROUP_CUSTOM_TYPES.has(f.field_type));
}

export async function validateMemberGroupTenantConfig(config, tenantId, client) {
  if (config?.source !== 'member_group') return;
  validateMemberGroupConfig(config);
  const fields = await loadMemberGroupCustomFields(client, tenantId);
  validateMemberGroupConfig(config, fields);
  return fields;
}

function parseValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function values(value) { return Array.isArray(value) ? value : [value]; }
function matches(value, f) {
  if (f.valueType === 'date') return matchWidgetDateFilter(value, f);
  const list = values(value);
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  switch (f.operator) {
    case 'is_null': return value == null || value === '' || list.length === 0;
    case 'is_not_null': return value != null && value !== '' && list.length > 0;
    case 'eq': return list.some(v => same(v, f.value));
    case 'neq': return !list.some(v => same(v, f.value));
    case 'in': return list.some(v => f.value.some(x => same(v, x)));
    case 'contains': return list.some(v => String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase()));
    case 'gt': return list.some(v => v != null && v > f.value);
    case 'gte': return list.some(v => v != null && v >= f.value);
    case 'lt': return list.some(v => v != null && v < f.value);
    case 'lte': return list.some(v => v != null && v <= f.value);
    default: throw new Error('Unsupported Member Groups filter');
  }
}

export function periodStart(raw, unit) {
  const d = new Date(raw);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (unit) {
    case 'day': return new Date(Date.UTC(y, m, day));
    case 'week': return new Date(Date.UTC(y, m, day - (d.getUTCDay() + 6) % 7));
    case 'month': return new Date(Date.UTC(y, m, 1));
    case 'quarter': return new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
    case 'year': return new Date(Date.UTC(y, 0, 1));
    default: throw new Error('Unsupported Member Groups time granularity');
  }
}
export function advancePeriod(raw, unit, amount = 1) {
  const d = new Date(raw);
  if (unit === 'day' || unit === 'week') d.setUTCDate(d.getUTCDate() + amount * (unit === 'week' ? 7 : 1));
  else d.setUTCMonth(d.getUTCMonth() + amount * ({ month: 1, quarter: 3, year: 12 }[unit]));
  return d;
}
function periodKey(d, unit) {
  if (unit === 'year') return String(d.getUTCFullYear());
  if (unit === 'quarter') return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return d.toISOString().slice(0, unit === 'month' ? 7 : 10);
}

// Union before filtering: editing a role, duplicate assignments and expiry
// extensions cannot manufacture new joins. Keep the actual starting rows so
// role/member filters describe the join, not a later segment.
export function unionMembershipIntervals(history) {
  const pairs = new Map();
  for (const row of history) {
    const start = Date.parse(row.valid_from);
    const end = row.valid_until ? Date.parse(row.valid_until) : Infinity;
    if (!Number.isFinite(start) || !(end > start)) continue;
    const key = JSON.stringify([row.group_id, row.member_id]);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push({ start, end, row });
  }
  const result = [];
  for (const intervals of pairs.values()) {
    intervals.sort((a, b) => a.start - b.start || b.end - a.end);
    let current;
    for (const item of intervals) {
      if (!current || item.start > current.end) {
        current = { ...item, starts: [item.row], baseline: !!item.row.is_baseline };
        result.push(current);
      } else {
        if (item.start === current.start) {
          current.starts.push(item.row);
          current.baseline ||= !!item.row.is_baseline;
        }
        current.end = Math.max(current.end, item.end);
      }
    }
  }
  return result;
}

export async function runMemberGroupWidgetConfig(config, tenantId, client, options = {}) {
  if (!tenantId && ['joins', 'period_end_members'].includes(config?.measure?.field)) {
    throw new Error('Member Groups: history is unavailable for a null tenant; the authoritative baseline excludes null-tenant records');
  }
  await validateMemberGroupTenantConfig(config, tenantId, client);
  const metric = config.measure.field;
  const temporal = metric === 'joins' || metric === 'period_end_members';
  const read = (table, columns, order = 'id') => readMemberGroupPages(() =>
    tenantFilter(client.from(table).select(columns), tenantId).order(order));
  const groups = await read(temporal ? 'member_group_history_group' : 'member_group',
    temporal ? 'group_id,name,is_active,deleted_at' : 'id,name,is_active', temporal ? 'group_id' : 'id');
  let baseline = null, history = [], assignments = [], members = [], preferences = [];
  if (temporal) {
    const { data, error } = await client.from('member_group_history_baseline').select('started_at').eq('singleton', true).single();
    if (error || !data?.started_at || !Number.isFinite(Date.parse(data.started_at))) {
      throw new Error('Member Groups history baseline is unavailable; install the authoritative history migration');
    }
    baseline = data.started_at;
    history = await read('member_group_membership_history',
      'id,group_id,member_id,role,valid_from,valid_until,is_baseline');
  } else if (metric !== 'groups') {
    assignments = await read('member_group_assignment', 'id,group_id,member_id,guest_id,group_role,expires_at');
  }
  const refs = [...(config.filters || []), ...(config.groupBy ? [{ ...config.groupBy, fieldKind: config.groupBy.kind }] : [])];
  const customIds = [...new Set(refs.filter(r => r.fieldKind === 'custom').map(r => r.fieldId))];
  const needsMembers = ['current_members', 'current_organizations'].includes(metric) || refs.some(r => r.fieldKind === 'custom' || MEMBER_FIELDS.includes(r.field));
  if (needsMembers) members = await read('member', 'id,role_id,organization_id,login_enabled');
  if (customIds.length) {
    // This value table has no tenant column. Both sides of the lookup are
    // independently validated tenant-owned IDs, never caller supplied IDs.
    for (let i = 0; i < members.length; i += 200) {
      preferences.push(...await readMemberGroupPages(() => client.from('member_preference_value')
        .select('member_id,field_id,value').in('field_id', customIds)
        .in('member_id', members.slice(i, i + 200).map(m => m.id))
        .order('member_id').order('field_id')));
      if (preferences.length > MEMBER_GROUP_ROW_CAP) throw new Error('Member Groups custom values exceed the row safety limit');
    }
  }
  return aggregateMemberGroups(config, { groups, history, assignments, members, preferences, baseline }, options);
}

export function aggregateMemberGroups(config, dataset, options = {}) {
  validateMemberGroupConfig(config);
  const now = new Date(options.now || Date.now());
  const nowMs = +now, metric = config.measure.field;
  const temporal = metric === 'joins' || metric === 'period_end_members';
  const groups = new Map(dataset.groups.map(g => [g.group_id || g.id, g]));
  const members = new Map((dataset.members || []).map(m => [m.id, m]));
  const preferences = new Map();
  for (const p of dataset.preferences || []) preferences.set(`${p.member_id}:${p.field_id}`, parseValue(p.value));
  const fieldValue = (row, ref, kind) => {
    if (kind === 'custom') return preferences.get(`${row.member_id}:${ref.fieldId}`);
    const group = groups.get(row.group_id);
    if (ref.field === 'group_id') return row.group_id;
    if (ref.field === 'group_name') return group?.name;
    if (ref.field === 'is_active') return group?.is_active;
    if (ref.field === 'group_role') return row.role ?? row.group_role;
    return members.get(row.member_id)?.[ref.field];
  };
  const accepts = row => groups.has(row.group_id) && (config.filters || []).every(f => matches(fieldValue(row, f, f.fieldKind), f));
  const label = id => {
    const g = groups.get(id);
    // Include IDs only when necessary to disambiguate duplicate names.
    const duplicate = [...groups.values()].filter(other => other.name === g?.name).length > 1;
    return `${g?.name || '(Unnamed group)'}${duplicate ? ` (${id})` : ''}`;
  };
  const keyOf = row => {
    if (!config.groupBy) return ['total'];
    const ref = config.groupBy;
    if (ref.kind === 'system' && ref.field === 'group_id') return [label(row.group_id)];
    return values(fieldValue(row, ref, ref.kind)).map(v => v == null || v === '' ? '(Not set)' : String(v));
  };
  const count = rows => {
    if (metric === 'current_organizations') {
      // Each bucket and the overall total have independent identity sets.
      return new Set(rows.map(r => members.get(r.member_id)?.organization_id)
        .filter(id => id != null && String(id).trim() !== '')).size;
    }
    return new Set(rows.map(r => metric === 'groups' ? r.group_id : metric === 'joins' ? r.joinId : r.member_id)).size;
  };
  const joinRows = unionMembershipIntervals(dataset.history || []).filter(x => !x.baseline && x.start <= nowMs)
    .flatMap((x, index) => x.starts.map(row => ({ ...row, joinId: index, joinedAt: x.start })));
  const historyRows = dataset.history || [];
  const currentRows = metric === 'groups'
    ? [...groups.keys()].map(group_id => ({ group_id }))
    : (dataset.assignments || []).filter(a => a.member_id && !a.guest_id && members.has(a.member_id)
      && (!a.expires_at || Date.parse(a.expires_at) > nowMs));
  const meta = {
    clickThroughAvailable: false,
    ...(temporal ? { historyBaseline: dataset.baseline, currentPeriodProvisional: true } : {}),
  };
  if (!config.timeBucket) {
    const sourceRows = (metric === 'joins' ? joinRows : currentRows).filter(accepts);
    const buckets = new Map();
    // Empty named groups remain visible, unless a member-level filter excludes them.
    if (config.groupBy?.kind === 'system' && ['group_id', 'group_name'].includes(config.groupBy.field)) {
      for (const group_id of groups.keys()) {
        const row = { group_id };
        if (accepts(row)) for (const key of keyOf(row)) buckets.set(key, []);
      }
    }
    for (const row of sourceRows) for (const key of keyOf(row)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    if (!config.groupBy) return { type: 'scalar', value: count(sourceRows), categories: ['value'], rows: [{ key: 'total', value: count(sourceRows) }], total: count(sourceRows), ...meta };
    if (buckets.size > (options.maxGroups || 30)) throw new Error('Member Groups breakdown exceeds the group limit; add filters');
    return { type: 'group', categories: ['value'], rows: [...buckets].map(([key, rows]) => ({ key, value: count(rows) })), total: count(sourceRows), ...meta };
  }
  if (!dataset.baseline) throw new Error('Member Groups history baseline is unavailable');
  const baseline = Date.parse(dataset.baseline), tb = config.timeBucket;
  const start = tb.window
    ? periodStart(advancePeriod(periodStart(now, tb.window.unit), tb.window.unit, -(tb.window.amount - 1)), tb.granularity)
    : periodStart(baseline, tb.granularity);
  const seriesGroups = [...groups.keys()].filter(group_id => (config.filters || [])
    .filter(f => f.fieldKind === 'system' && ['group_id', 'group_name', 'is_active'].includes(f.field))
    .every(f => matches(fieldValue({ group_id }, f, f.fieldKind), f)));
  if (config.seriesBy && seriesGroups.length > (options.maxGroups || 30)) throw new Error('Member Groups time series exceeds the group limit; add filters');
  const categories = config.seriesBy ? seriesGroups.map(id => `group:${id}`) : ['value'];
  const seriesLabels = config.seriesBy ? Object.fromEntries(seriesGroups.map((id, i) => [categories[i], label(id)])) : undefined;
  const rows = [], running = Object.fromEntries(categories.map(c => [c, 0]));
  for (let cursor = start; +cursor <= nowMs; cursor = advancePeriod(cursor, tb.granularity)) {
    if (rows.length >= 500) throw new Error('Member Groups time series exceeds 500 buckets; choose a shorter window');
    const end = +advancePeriod(cursor, tb.granularity), provisional = end > nowMs;
    const boundary = provisional ? nowMs : end;
    const available = metric === 'joins' ? +cursor >= baseline : (provisional ? boundary >= baseline : boundary > baseline);
    const eligible = (metric === 'joins'
      ? joinRows.filter(r => r.joinedAt >= +cursor && r.joinedAt < end)
      : historyRows.filter(r => {
        const from = Date.parse(r.valid_from), until = r.valid_until ? Date.parse(r.valid_until) : Infinity;
        return until > from && (provisional ? from <= boundary && until > boundary : from < boundary && until >= boundary);
      })).filter(accepts);
    const row = { key: periodKey(cursor, tb.granularity), provisional, available };
    categories.forEach((category, index) => {
      let value = available ? count(config.seriesBy ? eligible.filter(r => r.group_id === seriesGroups[index]) : eligible) : null;
      if (config.cumulative) {
        running[category] = value === null || running[category] === null ? null : running[category] + value;
        value = running[category];
      }
      row[category] = value;
    });
    rows.push(row);
  }
  return { type: 'time', granularity: tb.granularity, categories, seriesLabels, rows, ...meta };
}