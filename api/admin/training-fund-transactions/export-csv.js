import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

function sanitizeForCSV(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  return str;
}

function escapeCSV(value) {
  const str = sanitizeForCSV(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '';
  }
}

function formatTransactionTypeLabel(type) {
  switch (type) {
    case 'add': return 'Added';
    case 'deduct': return 'Deducted';
    case 'booking_usage': return 'Booking';
    case 'resync': return 'Balance resync';
    default: return type || '';
  }
}

function formatSignedAmount(txn) {
  const amt = Math.abs(parseFloat(txn.amount || 0));
  // Zero-amount rows (e.g. 'resync' reconciliation records) carry no sign.
  const sign = txn.type === 'add' || !(amt > 0) ? '' : '-';
  return `${sign}${amt.toFixed(2)}`;
}

function signedAmountNumber(txn) {
  const amt = Math.abs(parseFloat(txn.amount || 0));
  if (isNaN(amt)) return 0;
  return txn.type === 'add' ? amt : -amt;
}

function formatBalance(value) {
  const n = parseFloat(value);
  if (isNaN(n)) return '';
  return n.toFixed(2);
}

function memberDisplayName(member) {
  if (!member) return '';
  const composed = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
  if (composed) return composed;
  return member.email || '';
}

const COLUMN_DEFS = [
  { key: 'organization', header: 'Organisation' },
  { key: 'date', header: 'Date' },
  { key: 'type', header: 'Type' },
  { key: 'balance_before', header: 'Balance Before' },
  { key: 'amount', header: 'Amount' },
  { key: 'balance_after', header: 'Balance After' },
  { key: 'reason', header: 'Reason' },
  { key: 'created_by', header: 'Created By' },
  { key: 'event_internal_reference', header: 'Event Internal Reference' },
  { key: 'event_date', header: 'Event Date' },
];
const ALL_COLUMN_KEYS = COLUMN_DEFS.map(c => c.key);

const SORT_FIELD_TYPES = {
  organization: 'text',
  date: 'date',
  type: 'text',
  balance_before: 'number',
  amount: 'number',
  balance_after: 'number',
  reason: 'text',
  created_by: 'text',
  event_internal_reference: 'text',
  event_date: 'date',
};
const SORT_FIELDS = new Set(Object.keys(SORT_FIELD_TYPES));
// Fields that hold a date and can therefore be used as the source for the
// from/to date-range filter. Mirrors entries with type === 'date' in
// SORT_FIELD_TYPES so the two stay in sync.
const DATE_FILTER_FIELDS = new Set(
  Object.keys(SORT_FIELD_TYPES).filter(k => SORT_FIELD_TYPES[k] === 'date')
);
// Fields whose default sort direction is desc when no explicit direction is
// supplied. All other allowed fields default to asc.
const DEFAULT_DESC_SORT_FIELDS = new Set(['date', 'type', 'amount', 'balance_after']);

// Parse the `sort` query parameter into an array of rules. Accepts either a
// repeated `sort=field:dir[:fallback]` form or a comma-separated single
// string. Returns { rules, error }.
function parseSortRules(rawSort) {
  if (rawSort === undefined || rawSort === null) return { rules: null, error: null };
  let entries = [];
  if (Array.isArray(rawSort)) {
    entries = rawSort.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  } else {
    entries = String(rawSort).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (entries.length === 0) return { rules: null, error: null };
  const rules = [];
  const seen = new Set();
  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length < 2 || parts.length > 3) {
      return { rules: null, error: `Malformed sort rule: ${entry}` };
    }
    const field = parts[0];
    const dirRaw = (parts[1] || '').toLowerCase();
    const fallback = parts[2] || '';
    if (!SORT_FIELDS.has(field)) {
      return { rules: null, error: `Invalid sort field: ${field}` };
    }
    if (seen.has(field)) {
      return { rules: null, error: `Duplicate sort field: ${field}` };
    }
    seen.add(field);
    if (dirRaw !== 'asc' && dirRaw !== 'desc') {
      return { rules: null, error: `Invalid sort direction for ${field}: must be asc or desc` };
    }
    const dir = dirRaw;
    let fallbackField = null;
    if (parts.length === 3) {
      if (!fallback) {
        return { rules: null, error: `Empty fallback field for ${field}` };
      }
      if (!SORT_FIELDS.has(fallback)) {
        return { rules: null, error: `Invalid fallback field: ${fallback}` };
      }
      if (fallback === field) {
        return { rules: null, error: `Fallback field must differ from primary field: ${field}` };
      }
      if (SORT_FIELD_TYPES[fallback] !== SORT_FIELD_TYPES[field]) {
        return { rules: null, error: `Fallback field type does not match primary field for ${field}` };
      }
      fallbackField = fallback;
    }
    rules.push({ field, dir, fallback: fallbackField });
  }
  return { rules, error: null };
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseDateBoundary(value, endOfDay) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  // Accept YYYY-MM-DD or full ISO timestamps.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(n => parseInt(n, 10));
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== m - 1 ||
      probe.getUTCDate() !== d
    ) {
      return null;
    }
    return endOfDay ? `${str}T23:59:59.999Z` : `${str}T00:00:00.000Z`;
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx || !ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = ctx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }

  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // ---- Parse + validate config params ----
  const q = req.query || {};

  const columnsParamProvided = Object.prototype.hasOwnProperty.call(q, 'columns');
  const requestedColumns = parseList(q.columns);
  let columnKeys;
  if (!columnsParamProvided) {
    columnKeys = ALL_COLUMN_KEYS.slice();
  } else {
    if (requestedColumns.length === 0) {
      return res.status(400).json({ error: 'At least one column must be selected' });
    }
    columnKeys = ALL_COLUMN_KEYS.filter(k => requestedColumns.includes(k));
    if (columnKeys.length === 0) {
      return res.status(400).json({ error: 'At least one valid column must be selected' });
    }
  }

  const requestedOrgIds = parseList(q.organization_ids);
  const orgFilterActive = requestedOrgIds.length > 0;

  const fromIso = parseDateBoundary(q.from, false);
  const toIso = parseDateBoundary(q.to, true);
  if (q.from && !fromIso) {
    return res.status(400).json({ error: 'Invalid "from" date' });
  }
  if (q.to && !toIso) {
    return res.status(400).json({ error: 'Invalid "to" date' });
  }

  // Which date column the from/to range applies to, plus an optional fallback
  // date column used when the primary value is empty for a row. Defaults to
  // the legacy behaviour: filter on `date` (created_date), no fallback.
  const dateField = q.date_field || 'date';
  if (!DATE_FILTER_FIELDS.has(dateField)) {
    return res.status(400).json({ error: 'Invalid date_field' });
  }
  const dateFallbackField = q.date_fallback_field || null;
  if (dateFallbackField !== null) {
    if (!DATE_FILTER_FIELDS.has(dateFallbackField)) {
      return res.status(400).json({ error: 'Invalid date_fallback_field' });
    }
    if (dateFallbackField === dateField) {
      return res.status(400).json({ error: 'date_fallback_field must differ from date_field' });
    }
  }
  const dateFilterActive = !!(fromIso || toIso);
  // Only the legacy default (filter on created_date with no fallback) can be
  // pushed into the SQL query. Any other configuration needs the auxiliary
  // booking/event lookups to populate event_date before filtering, so we do
  // it in JS after the fetch.
  const canUseDbDateFilter =
    dateField === 'date' && !dateFallbackField;

  // Build the ordered list of sort rules. Prefer the new `sort` param; fall
  // back to legacy `sort_field` / `sort_dir`; if nothing is supplied, default
  // to the legacy single-rule "Organisation asc".
  let sortRules;
  if (Object.prototype.hasOwnProperty.call(q, 'sort')) {
    const { rules, error } = parseSortRules(q.sort);
    if (error) {
      return res.status(400).json({ error });
    }
    sortRules = rules && rules.length > 0 ? rules : [{ field: 'organization', dir: 'asc', fallback: null }];
  } else if (q.sort_field || q.sort_dir) {
    const legacyField = SORT_FIELDS.has(q.sort_field) ? q.sort_field : 'organization';
    const legacyDirRaw = q.sort_dir === 'desc' ? 'desc' : (q.sort_dir === 'asc' ? 'asc' : null);
    const legacyDir = legacyDirRaw || (DEFAULT_DESC_SORT_FIELDS.has(legacyField) ? 'desc' : 'asc');
    sortRules = [{ field: legacyField, dir: legacyDir, fallback: null }];
  } else {
    sortRules = [{ field: 'organization', dir: 'asc', fallback: null }];
  }

  // Determine which auxiliary lookups are needed based on selected columns,
  // every sort/fallback field referenced by the rules, *and* the date-range
  // filter's primary/fallback date field (so e.g. filtering by event_date
  // still triggers the booking/event lookup).
  const sortFieldsReferenced = new Set();
  for (const r of sortRules) {
    sortFieldsReferenced.add(r.field);
    if (r.fallback) sortFieldsReferenced.add(r.fallback);
  }
  if (dateFilterActive) {
    sortFieldsReferenced.add(dateField);
    if (dateFallbackField) sortFieldsReferenced.add(dateFallbackField);
  }

  try {
    // ---- Fetch transactions with filters applied at DB level ----
    const allTransactions = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      let query = supabase
        .from('training_fund_transaction')
        .select('id, organization_id, type, amount, balance_before, balance_after, reason, booking_id, created_by, created_date')
        .eq('tenant_id', tenantId);
      if (canUseDbDateFilter && fromIso) query = query.gte('created_date', fromIso);
      if (canUseDbDateFilter && toIso) query = query.lte('created_date', toIso);
      if (orgFilterActive) query = query.in('organization_id', requestedOrgIds);
      query = query.range(from, from + pageSize - 1);

      const { data, error } = await query;
      if (error) {
        console.error('[TrainingFundExportCSV] Transactions query error:', error);
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }
      if (data && data.length > 0) {
        allTransactions.push(...data);
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }

    // ---- Look up organisation names (always — needed for sort + Organisation column) ----
    const { data: organizations, error: orgErr } = await supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (orgErr) {
      console.error('[TrainingFundExportCSV] Organizations query error:', orgErr);
      return res.status(500).json({ error: 'Failed to fetch organisations' });
    }
    const orgMap = {};
    (organizations || []).forEach(o => { orgMap[o.id] = o; });

    // ---- Look up creators (when 'created_by' column is included or sorted by) ----
    const memberMap = {};
    if (columnKeys.includes('created_by') || sortFieldsReferenced.has('created_by')) {
      const memberIds = Array.from(new Set(
        allTransactions.map(t => t.created_by).filter(Boolean)
      ));
      if (memberIds.length > 0) {
        const batchSize = 200;
        for (let i = 0; i < memberIds.length; i += batchSize) {
          const batch = memberIds.slice(i, i + batchSize);
          const { data: members, error: memberErr } = await supabase
            .from('member')
            .select('id, first_name, last_name, email, tenant_id')
            .in('id', batch);
          if (memberErr) {
            console.warn('[TrainingFundExportCSV] Members query error (non-blocking):', memberErr.message);
            continue;
          }
          (members || []).forEach(m => {
            if (m.tenant_id && m.tenant_id !== tenantId) return;
            memberMap[m.id] = m;
          });
        }
      }
    }

    // ---- Look up booking → event details (only when those columns are included) ----
    const internalRefByBookingId = {};
    const eventDateByBookingId = {};
    const needRef = columnKeys.includes('event_internal_reference') || sortFieldsReferenced.has('event_internal_reference');
    const needEventDate = columnKeys.includes('event_date') || sortFieldsReferenced.has('event_date');
    if (needRef || needEventDate) {
      const bookingIds = Array.from(new Set(
        allTransactions
          .filter(t => t.type === 'booking_usage' && t.booking_id)
          .map(t => t.booking_id)
      ));
      if (bookingIds.length > 0) {
        const batchSize = 100;
        const resolvedAsBooking = new Set();

        for (let i = 0; i < bookingIds.length; i += batchSize) {
          const batch = bookingIds.slice(i, i + batchSize);
          const { data: bookingsRaw, error: bErr } = await supabase
            .from('booking')
            .select('id, event_id, tenant_id')
            .in('id', batch);
          if (bErr) {
            console.warn('[TrainingFundExportCSV] Bookings lookup error (non-blocking):', bErr.message);
            continue;
          }
          const bookings = (bookingsRaw || []).filter(b => !b.tenant_id || b.tenant_id === tenantId);
          if (bookings.length === 0) continue;

          bookings.forEach(b => resolvedAsBooking.add(b.id));

          const eventIds = Array.from(new Set(bookings.map(b => b.event_id).filter(Boolean)));
          if (eventIds.length === 0) continue;

          const { data: eventsRaw, error: eErr } = await supabase
            .from('event')
            .select('id, internal_reference, start_date, tenant_id')
            .in('id', eventIds);
          if (eErr) {
            console.warn('[TrainingFundExportCSV] Events lookup error (non-blocking):', eErr.message);
            continue;
          }
          const events = (eventsRaw || []).filter(e => !e.tenant_id || e.tenant_id === tenantId);
          const eventRefMap = {};
          const eventDateMap = {};
          events.forEach(e => {
            if (e.internal_reference) eventRefMap[e.id] = e.internal_reference;
            if (e.start_date) eventDateMap[e.id] = e.start_date;
          });
          bookings.forEach(b => {
            const ref = eventRefMap[b.event_id];
            if (ref) internalRefByBookingId[b.id] = ref;
            const sd = eventDateMap[b.event_id];
            if (sd) eventDateByBookingId[b.id] = sd;
          });
        }

        const unresolvedIds = bookingIds.filter(id => !resolvedAsBooking.has(id));
        for (let i = 0; i < unresolvedIds.length; i += batchSize) {
          const batch = unresolvedIds.slice(i, i + batchSize);
          const { data: complexBookingsRaw, error: cbErr } = await supabase
            .from('complex_event_booking')
            .select('id, event_id, tenant_id')
            .in('id', batch);
          if (cbErr) {
            console.warn('[TrainingFundExportCSV] Complex bookings lookup error (non-blocking):', cbErr.message);
            continue;
          }
          const complexBookings = (complexBookingsRaw || []).filter(b => !b.tenant_id || b.tenant_id === tenantId);
          if (complexBookings.length === 0) continue;

          const ceIds = Array.from(new Set(complexBookings.map(b => b.event_id).filter(Boolean)));
          if (ceIds.length === 0) continue;

          const ceRefMap = {};
          const ceDateMap = {};
          const { data: ces, error: ceErr } = await supabase
            .from('complex_event')
            .select('id, internal_reference, start_date, tenant_id')
            .in('id', ceIds);
          if (ceErr) {
            if (ceErr.code !== '42703') {
              console.warn('[TrainingFundExportCSV] Complex events lookup error (non-blocking):', ceErr.message);
            }
          } else {
            (ces || [])
              .filter(e => !e.tenant_id || e.tenant_id === tenantId)
              .forEach(e => {
                if (e.internal_reference) ceRefMap[e.id] = e.internal_reference;
                if (e.start_date) ceDateMap[e.id] = e.start_date;
              });
          }
          complexBookings.forEach(b => {
            const ref = ceRefMap[b.event_id];
            if (ref) internalRefByBookingId[b.id] = ref;
            const sd = ceDateMap[b.event_id];
            if (sd) eventDateByBookingId[b.id] = sd;
          });
        }
      }
    }

    // ---- Sort ----
    // Returns the raw value for a given field on a transaction, or null when
    // the field is empty/absent for that row (so fallback handling can kick in).
    const rawValue = (t, field) => {
      switch (field) {
        case 'organization': {
          const v = orgMap[t.organization_id]?.name || '';
          return v ? v : null;
        }
        case 'date': return t.created_date || null;
        case 'type': {
          const v = formatTransactionTypeLabel(t.type);
          return v ? v : null;
        }
        case 'amount': {
          if (t.amount === null || t.amount === undefined || t.amount === '') return null;
          const n = signedAmountNumber(t);
          return isNaN(n) ? null : n;
        }
        case 'balance_before': {
          if (t.balance_before === null || t.balance_before === undefined || t.balance_before === '') return null;
          const n = parseFloat(t.balance_before);
          return isNaN(n) ? null : n;
        }
        case 'balance_after': {
          if (t.balance_after === null || t.balance_after === undefined || t.balance_after === '') return null;
          const n = parseFloat(t.balance_after);
          return isNaN(n) ? null : n;
        }
        case 'reason': return t.reason ? t.reason : null;
        case 'created_by': {
          const v = memberDisplayName(t.created_by ? memberMap[t.created_by] : null);
          return v ? v : null;
        }
        case 'event_internal_reference': {
          if (t.type !== 'booking_usage' || !t.booking_id) return null;
          const v = internalRefByBookingId[t.booking_id];
          return v ? v : null;
        }
        case 'event_date': {
          if (t.type !== 'booking_usage' || !t.booking_id) return null;
          const v = eventDateByBookingId[t.booking_id];
          return v ? v : null;
        }
        default: return null;
      }
    };

    // Resolve a rule's effective value for a row, applying the fallback when
    // the primary value is empty/null. Returns the value and its declared type
    // so the comparator can decide how to compare.
    const ruleValue = (t, rule) => {
      let v = rawValue(t, rule.field);
      if (v === null && rule.fallback) {
        v = rawValue(t, rule.fallback);
      }
      return v;
    };

    // ---- In-memory date filter (when not using the DB-level fast path) ----
    // The DB query already enforced the from/to bounds when we were filtering
    // on `date` (created_date) with no fallback. For any other configuration
    // (e.g. filter on event_date, or with a fallback) we couldn't push the
    // filter into the query because the value isn't on the row, so we apply
    // it here using the same primary-then-fallback resolution as sort rules.
    if (!canUseDbDateFilter && dateFilterActive) {
      const filtered = allTransactions.filter((t) => {
        let v = rawValue(t, dateField);
        if (v === null && dateFallbackField) {
          v = rawValue(t, dateFallbackField);
        }
        if (v === null) return false; // rows with no date value can't match a range
        const iso = String(v);
        if (fromIso && iso < fromIso) return false;
        if (toIso && iso > toIso) return false;
        return true;
      });
      allTransactions.length = 0;
      allTransactions.push(...filtered);
    }

    const compareTyped = (av, bv, type) => {
      // Empty values sort *after* non-empty values in ascending order so they
      // don't pollute the top of an ascending list. Because the outer sort
      // negates the result for descending rules, empties will conversely come
      // first when the rule's direction is `desc` — that's intentional and
      // mirrors common spreadsheet behaviour.
      const aEmpty = av === null;
      const bEmpty = bv === null;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (type === 'number') {
        return av - bv;
      }
      // For text and date, compare case-insensitive strings (ISO date strings
      // sort correctly lexicographically).
      const as = type === 'text' ? String(av).toLowerCase() : String(av);
      const bs = type === 'text' ? String(bv).toLowerCase() : String(bv);
      if (as === bs) return 0;
      return as < bs ? -1 : 1;
    };

    allTransactions.sort((a, b) => {
      for (const rule of sortRules) {
        const av = ruleValue(a, rule);
        const bv = ruleValue(b, rule);
        const type = SORT_FIELD_TYPES[rule.field];
        const cmp = compareTyped(av, bv, type);
        if (cmp !== 0) {
          return rule.dir === 'asc' ? cmp : -cmp;
        }
      }
      // Stable final tiebreaker: created_date desc, then id, so equal keys
      // keep a deterministic order regardless of primary direction.
      const adRaw = a.created_date || '';
      const bdRaw = b.created_date || '';
      if (adRaw !== bdRaw) return adRaw < bdRaw ? 1 : -1;
      const aId = String(a.id || '');
      const bId = String(b.id || '');
      if (aId === bId) return 0;
      return aId < bId ? -1 : 1;
    });

    // ---- Build CSV ----
    const cellFor = (t, key) => {
      switch (key) {
        case 'organization': return escapeCSV(orgMap[t.organization_id]?.name || '');
        case 'date': return escapeCSV(formatDate(t.created_date));
        case 'type': return escapeCSV(formatTransactionTypeLabel(t.type));
        case 'balance_before': return escapeCSV(formatBalance(t.balance_before));
        case 'amount': return formatSignedAmount(t);
        case 'balance_after': return escapeCSV(formatBalance(t.balance_after));
        case 'reason': return escapeCSV(t.reason || '');
        case 'created_by': return escapeCSV(memberDisplayName(t.created_by ? memberMap[t.created_by] : null));
        case 'event_internal_reference': {
          const v = (t.type === 'booking_usage' && t.booking_id)
            ? (internalRefByBookingId[t.booking_id] || '')
            : '';
          return escapeCSV(v);
        }
        case 'event_date': {
          const v = (t.type === 'booking_usage' && t.booking_id)
            ? formatDate(eventDateByBookingId[t.booking_id])
            : '';
          return escapeCSV(v);
        }
        default: return '';
      }
    };

    const headerRow = columnKeys
      .map(k => COLUMN_DEFS.find(c => c.key === k).header)
      .map(escapeCSV)
      .join(',');
    const dataRows = allTransactions.map(t => columnKeys.map(k => cellFor(t, k)).join(','));
    const csv = [headerRow, ...dataRows].join('\n');

    const today = new Date().toISOString().split('T')[0];
    const filename = `training_fund_transactions_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Row-Count', String(allTransactions.length));
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[TrainingFundExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
