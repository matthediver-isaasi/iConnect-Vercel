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

function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  } catch {
    return '';
  }
}

function formatTransactionTypeLabel(type) {
  switch (type) {
    case 'booking_usage': return 'Booking';
    case 'cancellation_refund': return 'Cancellation Refund';
    case 'credit_adjustment': return 'Credit Adjustment';
    case 'debit_adjustment': return 'Debit Adjustment';
    case 'voucher_awarded': return 'Voucher awarded';
    case 'expiry': return 'Expiry';
    default: return type || '';
  }
}

const POSITIVE_TYPES = new Set(['cancellation_refund', 'credit_adjustment', 'voucher_awarded']);
const NEGATIVE_TYPES = new Set(['booking_usage', 'debit_adjustment', 'expiry']);

function formatSignedAmount(txn) {
  const amt = Math.abs(parseFloat(txn.amount || 0));
  let sign = '';
  if (NEGATIVE_TYPES.has(txn.type)) {
    sign = '-';
  } else if (POSITIVE_TYPES.has(txn.type)) {
    sign = '';
  } else {
    const raw = parseFloat(txn.amount || 0);
    sign = raw < 0 ? '-' : '';
  }
  return `${sign}${amt.toFixed(2)}`;
}

function signedAmountNumber(txn) {
  const amt = Math.abs(parseFloat(txn.amount || 0));
  if (isNaN(amt)) return 0;
  if (NEGATIVE_TYPES.has(txn.type)) return -amt;
  if (POSITIVE_TYPES.has(txn.type)) return amt;
  const raw = parseFloat(txn.amount || 0);
  return raw < 0 ? -amt : amt;
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
  { key: 'voucher_code', header: 'Voucher Code' },
  { key: 'voucher_description', header: 'Voucher Description' },
  { key: 'voucher_expiry_date', header: 'Voucher Expiry Date' },
  { key: 'date', header: 'Date' },
  { key: 'type', header: 'Type' },
  { key: 'balance_before', header: 'Balance Before' },
  { key: 'amount', header: 'Amount' },
  { key: 'balance_after', header: 'Balance After' },
  { key: 'booking_reference', header: 'Booking Reference' },
  { key: 'event_internal_reference', header: 'Event Internal Reference' },
  { key: 'event_date', header: 'Event Date' },
  { key: 'event_title', header: 'Event Title' },
  { key: 'member', header: 'Member' },
  { key: 'voucher_valid_from', header: 'Voucher Valid From' },
  { key: 'funding_source', header: 'Funding Source' },
  { key: 'created_by', header: 'Created By' },
  { key: 'voucher_notes', header: 'Voucher Notes' },
  { key: 'notes', header: 'Transaction Notes' },
];
const ALL_COLUMN_KEYS = COLUMN_DEFS.map(c => c.key);

const SORT_FIELD_TYPES = {
  organization: 'text',
  voucher_code: 'text',
  voucher_description: 'text',
  voucher_expiry_date: 'date',
  date: 'date',
  type: 'text',
  balance_before: 'number',
  amount: 'number',
  balance_after: 'number',
  booking_reference: 'text',
  event_internal_reference: 'text',
  event_date: 'date',
  event_title: 'text',
  member: 'text',
  voucher_valid_from: 'date',
  funding_source: 'text',
  created_by: 'text',
  voucher_notes: 'text',
  notes: 'text',
};
const SORT_FIELDS = new Set(Object.keys(SORT_FIELD_TYPES));
// Date-range filter fields for the export. These mirror the Voucher
// Management page filter (Issued / Expiry / Used at voucher level) plus
// Event date (row level, from the linked event's start date).
const EXPORT_DATE_FIELDS = new Set(['issued', 'expiry', 'used', 'event_date']);
// Legacy field keys from older saved reports / clients, mapped to the
// nearest new field. "date" (transaction date) maps to "used" because the
// Used-date filter is driven by redemption transaction dates;
// "voucher_expiry_date" maps directly to "expiry".
const LEGACY_DATE_FIELD_MAP = { date: 'used', voucher_expiry_date: 'expiry' };
const DEFAULT_DESC_SORT_FIELDS = new Set(['date', 'type', 'amount', 'balance_after']);

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

  const q = req.query || {};

  // Vouchers-only mode: one row per voucher with a fixed voucher-level
  // column set, no transaction rows and no synthetic "Voucher awarded"
  // rows. Columns/sort params are ignored in this mode.
  const vouchersOnlyRaw = q.vouchers_only;
  const vouchersOnly = vouchersOnlyRaw === 'true' || vouchersOnlyRaw === '1';
  if (vouchersOnlyRaw !== undefined && !vouchersOnly && vouchersOnlyRaw !== 'false' && vouchersOnlyRaw !== '0') {
    return res.status(400).json({ error: 'Invalid vouchers_only value' });
  }

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

  const rawDateField = q.date_field || 'issued';
  const dateField = LEGACY_DATE_FIELD_MAP[rawDateField] || rawDateField;
  if (!EXPORT_DATE_FIELDS.has(dateField)) {
    return res.status(400).json({ error: 'Invalid date_field' });
  }
  const rawFallback = q.date_fallback_field || null;
  let dateFallbackField = rawFallback
    ? (LEGACY_DATE_FIELD_MAP[rawFallback] || rawFallback)
    : null;
  if (dateFallbackField !== null) {
    if (!EXPORT_DATE_FIELDS.has(dateFallbackField)) {
      return res.status(400).json({ error: 'Invalid date_fallback_field' });
    }
    if (dateFallbackField === dateField) {
      // Two distinct legacy fields can collapse onto the same new field;
      // drop the fallback silently in that case instead of rejecting old
      // saved reports. Reject only when the caller sent duplicates outright.
      if (rawFallback === rawDateField) {
        return res.status(400).json({ error: 'date_fallback_field must differ from date_field' });
      }
      dateFallbackField = null;
    }
  }
  const dateFilterActive = !!(fromIso || toIso);

  const excludeExpiredRaw = q.exclude_expired_in_range;
  const excludeExpiredInRange = excludeExpiredRaw === 'true' || excludeExpiredRaw === '1';
  if (excludeExpiredRaw !== undefined && !excludeExpiredInRange && excludeExpiredRaw !== 'false' && excludeExpiredRaw !== '0') {
    return res.status(400).json({ error: 'Invalid exclude_expired_in_range value' });
  }
  if (excludeExpiredInRange && !dateFilterActive) {
    return res.status(400).json({ error: 'exclude_expired_in_range requires a "from" and/or "to" date' });
  }

  // Voucher-level date filter mirroring the Voucher Management list filter:
  // restricts the export to transactions of vouchers whose Issued / Expiry /
  // Used (redemption) date falls inside the given inclusive range.
  const voucherDateField = q.voucher_date_field ? String(q.voucher_date_field) : null;
  if (voucherDateField !== null && !['issued', 'expiry', 'used'].includes(voucherDateField)) {
    return res.status(400).json({ error: 'Invalid voucher_date_field' });
  }
  const voucherFromIso = parseDateBoundary(q.voucher_from, false);
  const voucherToIso = parseDateBoundary(q.voucher_to, true);
  if (q.voucher_from && !voucherFromIso) {
    return res.status(400).json({ error: 'Invalid "voucher_from" date' });
  }
  if (q.voucher_to && !voucherToIso) {
    return res.status(400).json({ error: 'Invalid "voucher_to" date' });
  }
  const voucherDateFilterActive = !!(voucherDateField && (voucherFromIso || voucherToIso));

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

  const sortFieldsReferenced = new Set();
  for (const r of sortRules) {
    sortFieldsReferenced.add(r.field);
    if (r.fallback) sortFieldsReferenced.add(r.fallback);
  }
  if (dateFilterActive) {
    // Event-date filtering needs the event lookup even when the column
    // itself isn't exported. Voucher-level fields (issued/expiry/used)
    // are resolved from the voucher map / redemption dates instead.
    if (dateField === 'event_date' || dateFallbackField === 'event_date') {
      sortFieldsReferenced.add('event_date');
    }
  }

  const referencesAny = (keys) =>
    keys.some(k => columnKeys.includes(k) || sortFieldsReferenced.has(k));

  const needVoucher = true;
  const needMember = referencesAny(['member']);
  const needEventRef = referencesAny(['event_internal_reference']);
  const needEventDate = referencesAny(['event_date']);
  const needEventLookup = needEventRef || needEventDate;

  // The voucher table's `issued_at` (migration 20260515_add_voucher_issued_at)
  // and even `created_at` columns may be absent in some environments. Track
  // each column independently; on a 42703 ("column does not exist") error we
  // disable only the column named in the error before retrying, so an
  // environment with `issued_at` but no `created_at` (or vice versa) keeps
  // whichever date column it does have.
  const voucherColFlags = {
    issued_at: true,
    created_at: true,
    // Task #3116 allocation metadata columns (migration
    // 20260726_add_voucher_expiry_ledger_fields); may be absent in
    // environments where that migration has not been applied yet.
    valid_from: true,
    funding_source: true,
    notes: true,
    created_by: true,
  };
  const applyVoucherColFallback = (error) => {
    if (!error || error.code !== '42703') return false;
    const msg = String(error.message || '');
    for (const col of Object.keys(voucherColFlags)) {
      if (voucherColFlags[col] && new RegExp(`\\b${col}\\b`).test(msg)) {
        voucherColFlags[col] = false;
        console.warn(`[VoucherExportCSV] voucher.${col} missing; retrying without it.`);
        return true;
      }
    }
    // 42703 that names no known column (unexpected): degrade conservatively,
    // one optional column at a time, rather than fail outright.
    for (const col of Object.keys(voucherColFlags)) {
      if (voucherColFlags[col]) { voucherColFlags[col] = false; return true; }
    }
    return false;
  };
  // Runs a voucher query builder, retrying (bounded: each retry permanently
  // disables one column) while the failure is a recoverable missing-column
  // error. Builders must call voucherSelectCols()/flag-aware selects so the
  // retry actually changes the query.
  const runVoucherQuery = async (build) => {
    let result = await build();
    while (result.error && applyVoucherColFallback(result.error)) {
      result = await build();
    }
    return result;
  };

  try {
    // Resolve which vouchers are eligible under the voucher-level date
    // filter (null = no restriction).
    let eligibleVoucherIds = null;
    if (voucherDateFilterActive) {
      eligibleVoucherIds = new Set();
      const inVoucherWindow = (dateStr) => {
        if (!dateStr) return false;
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return false;
        const iso = d.toISOString();
        if (voucherFromIso && iso < voucherFromIso) return false;
        if (voucherToIso && iso > voucherToIso) return false;
        return true;
      };
      const pageSize = 1000;
      if (voucherDateField === 'used') {
        let vFrom = 0;
        while (true) {
          let query = supabase
            .from('voucher_transaction')
            .select('voucher_id')
            .eq('tenant_id', tenantId)
            .eq('type', 'booking_usage');
          if (voucherFromIso) query = query.gte('created_at', voucherFromIso);
          if (voucherToIso) query = query.lte('created_at', voucherToIso);
          query = query.order('id', { ascending: true }).range(vFrom, vFrom + pageSize - 1);
          const { data, error } = await query;
          if (error) {
            console.error('[VoucherExportCSV] Used-date voucher filter query error:', error);
            return res.status(500).json({ error: 'Failed to resolve used-date voucher filter' });
          }
          (data || []).forEach(r => { if (r.voucher_id) eligibleVoucherIds.add(r.voucher_id); });
          if (!data || data.length < pageSize) break;
          vFrom += pageSize;
        }
      } else {
        let vFrom = 0;
        const buildQuery = () => {
          const cols = ['id', 'expires_at'];
          if (voucherColFlags.created_at) cols.push('created_at');
          if (voucherColFlags.issued_at) cols.push('issued_at');
          return supabase
            .from('voucher')
            .select(cols.join(', '))
            .eq('tenant_id', tenantId)
            .order('id', { ascending: true })
            .range(vFrom, vFrom + pageSize - 1);
        };
        while (true) {
          const { data, error } = await runVoucherQuery(buildQuery);
          if (error) {
            console.error('[VoucherExportCSV] Voucher date filter query error:', error);
            return res.status(500).json({ error: 'Failed to resolve voucher date filter' });
          }
          for (const v of (data || [])) {
            const d = voucherDateField === 'expiry' ? v.expires_at : (v.issued_at ?? v.created_at ?? null);
            if (inVoucherWindow(d)) eligibleVoucherIds.add(v.id);
          }
          if (!data || data.length < pageSize) break;
          vFrom += pageSize;
        }
      }
    }

    if (vouchersOnly) {
      // ---- Vouchers-only export: one row per voucher ----
      const vouchersAll = [];
      {
        const pageSize = 1000;
        let vFrom = 0;
        const buildQuery = () => {
          const cols = ['id', 'code', 'description', 'expires_at', 'value', 'organization_id'];
          if (voucherColFlags.created_at) cols.push('created_at');
          if (voucherColFlags.issued_at) cols.push('issued_at');
          let query = supabase
            .from('voucher')
            .select(cols.join(', '))
            .eq('tenant_id', tenantId);
          if (orgFilterActive) query = query.in('organization_id', requestedOrgIds);
          return query.order('id', { ascending: true }).range(vFrom, vFrom + pageSize - 1);
        };
        while (true) {
          const { data, error } = await runVoucherQuery(buildQuery);
          if (error) {
            console.error('[VoucherExportCSV] Vouchers-only voucher query error:', error);
            return res.status(500).json({ error: 'Failed to fetch vouchers' });
          }
          if (data && data.length > 0) vouchersAll.push(...data);
          if (!data || data.length < pageSize) break;
          vFrom += pageSize;
        }
      }

      let eligible = eligibleVoucherIds
        ? vouchersAll.filter(v => eligibleVoucherIds.has(v.id))
        : vouchersAll;

      // Dialog date-range filter, applied at voucher level. Used-date and
      // event-date need per-voucher lookups from the transaction table.
      if (dateFilterActive) {
        const inRange = (d) => {
          if (!d) return false;
          const t = new Date(d);
          if (isNaN(t.getTime())) return false;
          const iso = t.toISOString();
          if (fromIso && iso < fromIso) return false;
          if (toIso && iso > toIso) return false;
          return true;
        };

        const needsUsed = dateField === 'used' || dateFallbackField === 'used';
        const needsEventDate = dateField === 'event_date' || dateFallbackField === 'event_date';

        let redemptionDatesByVoucher = null;
        if (needsUsed) {
          redemptionDatesByVoucher = {};
          const pageSize = 1000;
          let rdFrom = 0;
          while (true) {
            const { data, error } = await supabase
              .from('voucher_transaction')
              .select('voucher_id, created_at')
              .eq('tenant_id', tenantId)
              .eq('type', 'booking_usage')
              .order('id', { ascending: true })
              .range(rdFrom, rdFrom + pageSize - 1);
            if (error) {
              console.error('[VoucherExportCSV] Vouchers-only redemption dates query error:', error);
              return res.status(500).json({ error: 'Failed to resolve used-date filter' });
            }
            for (const row of (data || [])) {
              if (!row.voucher_id || !row.created_at) continue;
              if (!redemptionDatesByVoucher[row.voucher_id]) redemptionDatesByVoucher[row.voucher_id] = [];
              redemptionDatesByVoucher[row.voucher_id].push(row.created_at);
            }
            if (!data || data.length < pageSize) break;
            rdFrom += pageSize;
          }
        }

        let eventDatesByVoucher = null;
        if (needsEventDate) {
          eventDatesByVoucher = {};
          const eventIdsByVoucher = {};
          const allEventIds = new Set();
          const pageSize = 1000;
          let tFrom = 0;
          while (true) {
            const { data, error } = await supabase
              .from('voucher_transaction')
              .select('voucher_id, event_id')
              .eq('tenant_id', tenantId)
              .order('id', { ascending: true })
              .range(tFrom, tFrom + pageSize - 1);
            if (error) {
              console.error('[VoucherExportCSV] Vouchers-only event lookup query error:', error);
              return res.status(500).json({ error: 'Failed to resolve event-date filter' });
            }
            for (const row of (data || [])) {
              if (!row.voucher_id || !row.event_id) continue;
              if (!eventIdsByVoucher[row.voucher_id]) eventIdsByVoucher[row.voucher_id] = new Set();
              eventIdsByVoucher[row.voucher_id].add(row.event_id);
              allEventIds.add(row.event_id);
            }
            if (!data || data.length < pageSize) break;
            tFrom += pageSize;
          }
          const startDateByEventId = {};
          const eventIdList = Array.from(allEventIds);
          const batchSize = 100;
          const resolvedAsEvent = new Set();
          for (let i = 0; i < eventIdList.length; i += batchSize) {
            const batch = eventIdList.slice(i, i + batchSize);
            const { data, error } = await supabase
              .from('event')
              .select('id, start_date, tenant_id')
              .in('id', batch);
            if (error) {
              console.warn('[VoucherExportCSV] Vouchers-only events lookup error (non-blocking):', error.message);
              continue;
            }
            (data || [])
              .filter(e => !e.tenant_id || e.tenant_id === tenantId)
              .forEach(e => {
                resolvedAsEvent.add(e.id);
                if (e.start_date) startDateByEventId[e.id] = e.start_date;
              });
          }
          const unresolvedIds = eventIdList.filter(id => !resolvedAsEvent.has(id));
          for (let i = 0; i < unresolvedIds.length; i += batchSize) {
            const batch = unresolvedIds.slice(i, i + batchSize);
            const { data, error } = await supabase
              .from('complex_event')
              .select('id, start_date, tenant_id')
              .in('id', batch);
            if (error) {
              if (error.code !== '42703') {
                console.warn('[VoucherExportCSV] Vouchers-only complex events lookup error (non-blocking):', error.message);
              }
              continue;
            }
            (data || [])
              .filter(e => !e.tenant_id || e.tenant_id === tenantId)
              .forEach(e => {
                if (e.start_date) startDateByEventId[e.id] = e.start_date;
              });
          }
          for (const [vid, ids] of Object.entries(eventIdsByVoucher)) {
            const dates = Array.from(ids).map(id => startDateByEventId[id]).filter(Boolean);
            if (dates.length > 0) eventDatesByVoucher[vid] = dates;
          }
        }

        const evalVoucherField = (v, field) => {
          if (field === 'issued') {
            const d = v.issued_at ?? v.created_at ?? null;
            return { has: !!d, match: d ? inRange(d) : false };
          }
          if (field === 'expiry') {
            const d = v.expires_at;
            return { has: !!d, match: d ? inRange(d) : false };
          }
          if (field === 'used') {
            const dates = (redemptionDatesByVoucher && redemptionDatesByVoucher[v.id]) || [];
            return { has: dates.length > 0, match: dates.some(inRange) };
          }
          if (field === 'event_date') {
            const dates = (eventDatesByVoucher && eventDatesByVoucher[v.id]) || [];
            return { has: dates.length > 0, match: dates.some(inRange) };
          }
          return { has: false, match: false };
        };

        eligible = eligible.filter((v) => {
          const primary = evalVoucherField(v, dateField);
          if (primary.has) return primary.match;
          if (dateFallbackField) {
            const fb = evalVoucherField(v, dateFallbackField);
            return fb.has && fb.match;
          }
          return false;
        });
      }

      if (excludeExpiredInRange && dateFilterActive) {
        const fromMs = fromIso ? new Date(fromIso).getTime() : null;
        const toMs = toIso ? new Date(toIso).getTime() : null;
        eligible = eligible.filter((v) => {
          if (!v.expires_at) return true;
          const ms = new Date(v.expires_at).getTime();
          if (isNaN(ms)) return true;
          if (fromMs !== null && ms < fromMs) return true;
          if (toMs !== null && ms > toMs) return true;
          return false;
        });
      }

      // Initial balance = current value minus the net effect of every
      // transaction on the voucher (mirrors the synthetic awarded-row math).
      const netByVoucher = {};
      {
        const voucherIdList = eligible.map(v => v.id);
        const batchSize = 200;
        const pageSize = 1000;
        for (let i = 0; i < voucherIdList.length; i += batchSize) {
          const batch = voucherIdList.slice(i, i + batchSize);
          let netFrom = 0;
          while (true) {
            const { data, error } = await supabase
              .from('voucher_transaction')
              .select('id, voucher_id, amount, type')
              .eq('tenant_id', tenantId)
              .in('voucher_id', batch)
              .order('id', { ascending: true })
              .range(netFrom, netFrom + pageSize - 1);
            if (error) {
              console.warn('[VoucherExportCSV] Vouchers-only net lookup error (non-blocking):', error.message);
              break;
            }
            for (const t of (data || [])) {
              if (!t.voucher_id) continue;
              const amt = Math.abs(parseFloat(t.amount || 0));
              if (isNaN(amt)) continue;
              let signed = 0;
              if (NEGATIVE_TYPES.has(t.type)) signed = -amt;
              else if (POSITIVE_TYPES.has(t.type)) signed = amt;
              else {
                const raw = parseFloat(t.amount || 0);
                signed = isNaN(raw) ? 0 : raw;
              }
              netByVoucher[t.voucher_id] = (netByVoucher[t.voucher_id] || 0) + signed;
            }
            if (!data || data.length < pageSize) break;
            netFrom += pageSize;
          }
        }
      }

      const { data: orgs, error: orgErr } = await supabase
        .from('organization')
        .select('id, name')
        .eq('tenant_id', tenantId);
      if (orgErr) {
        console.error('[VoucherExportCSV] Organizations query error:', orgErr);
        return res.status(500).json({ error: 'Failed to fetch organisations' });
      }
      const orgNameById = {};
      (orgs || []).forEach(o => { orgNameById[o.id] = o.name || ''; });

      eligible.sort((a, b) => {
        const an = (orgNameById[a.organization_id] || '').toLowerCase();
        const bn = (orgNameById[b.organization_id] || '').toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        const ac = (a.code || '').toLowerCase();
        const bc = (b.code || '').toLowerCase();
        if (ac !== bc) return ac < bc ? -1 : 1;
        const aId = String(a.id || '');
        const bId = String(b.id || '');
        if (aId === bId) return 0;
        return aId < bId ? -1 : 1;
      });

      const headerRow = [
        'Organisation',
        'Voucher Code',
        'Voucher Description',
        'Issued Date',
        'Expiry Date',
        'Initial Balance',
        'Current Balance',
      ].map(escapeCSV).join(',');
      const dataRows = eligible.map((v) => {
        const currentValue = parseFloat(v.value);
        const hasValue = !isNaN(currentValue);
        const initialValue = hasValue ? currentValue - (netByVoucher[v.id] || 0) : NaN;
        return [
          escapeCSV(orgNameById[v.organization_id] || ''),
          escapeCSV(v.code || ''),
          escapeCSV(v.description || ''),
          escapeCSV(formatDateOnly(v.issued_at ?? v.created_at ?? null)),
          escapeCSV(formatDateOnly(v.expires_at)),
          escapeCSV(hasValue ? initialValue.toFixed(2) : ''),
          escapeCSV(hasValue ? currentValue.toFixed(2) : ''),
        ].join(',');
      });
      const csv = [headerRow, ...dataRows].join('\n');

      const today = new Date().toISOString().split('T')[0];
      const filename = `training_vouchers_${today}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Export-Row-Count', String(eligible.length));
      return res.status(200).send(csv);
    }

    const allTransactions = [];
    const pageSize = 1000;
    let from = 0;
    // voucher_transaction.notes (Task #3116) may be absent in environments
    // where migration 20260726_add_voucher_expiry_ledger_fields has not been
    // applied; drop it on a 42703 and retry.
    let txnNotesCol = true;
    while (true) {
      const buildTxnQuery = () => {
        const cols = ['id', 'voucher_id', 'organization_id', 'booking_reference', 'event_id', 'event_title', 'member_id', 'member_email', 'amount', 'balance_before', 'balance_after', 'type', 'created_at'];
        if (txnNotesCol) cols.push('notes');
        let query = supabase
          .from('voucher_transaction')
          .select(cols.join(', '))
          .eq('tenant_id', tenantId);
        if (orgFilterActive) query = query.in('organization_id', requestedOrgIds);
        return query.order('id', { ascending: true }).range(from, from + pageSize - 1);
      };

      let { data, error } = await buildTxnQuery();
      if (error && error.code === '42703' && txnNotesCol && /\bnotes\b/.test(String(error.message || ''))) {
        txnNotesCol = false;
        console.warn('[VoucherExportCSV] voucher_transaction.notes missing; retrying without it.');
        ({ data, error } = await buildTxnQuery());
      }
      if (error) {
        console.error('[VoucherExportCSV] Transactions query error:', error);
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }
      if (data && data.length > 0) {
        allTransactions.push(...data);
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }

    if (eligibleVoucherIds) {
      // Keep only transactions belonging to vouchers that match the
      // voucher-level date filter. Rows without a linked voucher can't
      // match any voucher date, so they are dropped too.
      const kept = allTransactions.filter(t => t.voucher_id && eligibleVoucherIds.has(t.voucher_id));
      allTransactions.length = 0;
      allTransactions.push(...kept);
    }

    const { data: organizations, error: orgErr } = await supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (orgErr) {
      console.error('[VoucherExportCSV] Organizations query error:', orgErr);
      return res.status(500).json({ error: 'Failed to fetch organisations' });
    }
    const orgMap = {};
    (organizations || []).forEach(o => { orgMap[o.id] = o; });

    const voucherMap = {};
    // Column list driven by voucherColFlags (see applyVoucherColFallback
    // above): issued_at and/or created_at are dropped only after a 42703
    // error names them, so environments with either column keep it.
    const voucherSelectCols = () => {
      const cols = ['id', 'code', 'description', 'expires_at', 'value', 'organization_id'];
      if (voucherColFlags.created_at) cols.push('created_at');
      if (voucherColFlags.issued_at) cols.push('issued_at');
      if (voucherColFlags.valid_from) cols.push('valid_from');
      if (voucherColFlags.funding_source) cols.push('funding_source');
      if (voucherColFlags.notes) cols.push('notes');
      if (voucherColFlags.created_by) cols.push('created_by');
      return cols.join(', ');
    };
    if (needVoucher) {
      const voucherIds = Array.from(new Set(
        allTransactions.map(t => t.voucher_id).filter(Boolean)
      ));
      if (voucherIds.length > 0) {
        const batchSize = 200;
        for (let i = 0; i < voucherIds.length; i += batchSize) {
          const batch = voucherIds.slice(i, i + batchSize);
          const { data: vouchers, error: vErr } = await runVoucherQuery(() => supabase
            .from('voucher')
            .select(voucherSelectCols())
            .in('id', batch));
          if (vErr) {
            console.error('[VoucherExportCSV] Voucher lookup error:', vErr);
            return res.status(500).json({ error: 'Failed to fetch vouchers' });
          }
          // voucherMap is built from voucher_ids that already came from
          // tenant-scoped voucher_transaction rows, so tenant isolation
          // is enforced upstream. Don't further filter by orgMap because
          // a voucher's organisation may have been soft-deleted while
          // its transactions remain in the report.
          (vouchers || []).forEach(v => {
            voucherMap[v.id] = v;
          });
        }
      }
    }

    const memberMap = {};
    if (needMember) {
      const memberIds = Array.from(new Set(
        allTransactions.map(t => t.member_id).filter(Boolean)
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
            console.warn('[VoucherExportCSV] Members query error (non-blocking):', memberErr.message);
            continue;
          }
          (members || []).forEach(m => {
            if (m.tenant_id && m.tenant_id !== tenantId) return;
            memberMap[m.id] = m;
          });
        }
      }
    }

    const internalRefByEventId = {};
    const eventDateByEventId = {};
    if (needEventLookup) {
      const eventIds = Array.from(new Set(
        allTransactions.map(t => t.event_id).filter(Boolean)
      ));
      if (eventIds.length > 0) {
        const batchSize = 100;
        const resolvedAsEvent = new Set();

        for (let i = 0; i < eventIds.length; i += batchSize) {
          const batch = eventIds.slice(i, i + batchSize);
          const { data: eventsRaw, error: eErr } = await supabase
            .from('event')
            .select('id, internal_reference, start_date, tenant_id')
            .in('id', batch);
          if (eErr) {
            console.warn('[VoucherExportCSV] Events lookup error (non-blocking):', eErr.message);
            continue;
          }
          const events = (eventsRaw || []).filter(e => !e.tenant_id || e.tenant_id === tenantId);
          events.forEach(e => {
            resolvedAsEvent.add(e.id);
            if (e.internal_reference) internalRefByEventId[e.id] = e.internal_reference;
            if (e.start_date) eventDateByEventId[e.id] = e.start_date;
          });
        }

        const unresolvedIds = eventIds.filter(id => !resolvedAsEvent.has(id));
        for (let i = 0; i < unresolvedIds.length; i += batchSize) {
          const batch = unresolvedIds.slice(i, i + batchSize);
          const { data: ces, error: ceErr } = await supabase
            .from('complex_event')
            .select('id, internal_reference, start_date, tenant_id')
            .in('id', batch);
          if (ceErr) {
            if (ceErr.code !== '42703') {
              console.warn('[VoucherExportCSV] Complex events lookup error (non-blocking):', ceErr.message);
            }
            continue;
          }
          (ces || [])
            .filter(e => !e.tenant_id || e.tenant_id === tenantId)
            .forEach(e => {
              if (e.internal_reference) internalRefByEventId[e.id] = e.internal_reference;
              if (e.start_date) eventDateByEventId[e.id] = e.start_date;
            });
        }
      }
    }

    const rawValue = (t, field) => {
      switch (field) {
        case 'organization': {
          const v = orgMap[t.organization_id]?.name || '';
          return v ? v : null;
        }
        case 'voucher_code': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.code || '') : '';
          return v ? v : null;
        }
        case 'voucher_description': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.description || '') : '';
          return v ? v : null;
        }
        case 'voucher_expiry_date': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.expires_at || '') : '';
          return v ? v : null;
        }
        case 'date': return t.created_at || null;
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
        case 'voucher_valid_from': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.valid_from || '') : '';
          return v ? v : null;
        }
        case 'funding_source': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.funding_source || '') : '';
          return v ? v : null;
        }
        case 'created_by': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.created_by || '') : '';
          return v ? v : null;
        }
        case 'voucher_notes': {
          const v = t.voucher_id ? (voucherMap[t.voucher_id]?.notes || '') : '';
          return v ? v : null;
        }
        case 'notes': return t.notes ? t.notes : null;
        case 'booking_reference': return t.booking_reference ? t.booking_reference : null;
        case 'event_internal_reference': {
          if (!t.event_id) return null;
          const v = internalRefByEventId[t.event_id];
          return v ? v : null;
        }
        case 'event_date': {
          if (!t.event_id) return null;
          const v = eventDateByEventId[t.event_id];
          return v ? v : null;
        }
        case 'event_title': return t.event_title ? t.event_title : null;
        case 'member': {
          const v = memberDisplayName(t.member_id ? memberMap[t.member_id] : null) || t.member_email || '';
          return v ? v : null;
        }
        default: return null;
      }
    };

    const ruleValue = (t, rule) => {
      let v = rawValue(t, rule.field);
      if (v === null && rule.fallback) {
        v = rawValue(t, rule.fallback);
      }
      return v;
    };

    {
      const voucherIdsInReport = new Set();
      for (const t of allTransactions) {
        if (t.voucher_id) voucherIdsInReport.add(t.voucher_id);
      }

      // Fold in *every* voucher for the tenant (respecting the organisation
      // filter), not just those referenced by a transaction. A voucher that
      // has never been used has no transaction rows, so without this it would
      // be silently dropped from the export whenever no date filter is active.
      // This subsumes the previous "issued in the active window" lookup: all
      // vouchers are loaded here, and the awarded rows they produce are then
      // date-range / exclude-expired filtered downstream exactly like used
      // vouchers. The issued_at column may not exist yet in every environment
      // (migration 20260515_add_voucher_issued_at); voucherSelectCols() and
      // the 42703 fallback below degrade gracefully when it is missing.
      {
        const allVoucherPageSize = 1000;
        let allVoucherFrom = 0;
        const buildAllVoucherQuery = () => {
          let query = supabase
            .from('voucher')
            .select(voucherSelectCols())
            .eq('tenant_id', tenantId);
          if (orgFilterActive) query = query.in('organization_id', requestedOrgIds);
          return query
            .order('id', { ascending: true })
            .range(allVoucherFrom, allVoucherFrom + allVoucherPageSize - 1);
        };
        while (true) {
          const { data: tenantVouchers, error: allVoucherErr } = await runVoucherQuery(buildAllVoucherQuery);
          if (allVoucherErr) {
            console.warn('[VoucherExportCSV] Full tenant voucher lookup error (non-blocking):', allVoucherErr.message);
            break;
          }
          for (const v of (tenantVouchers || [])) {
            if (eligibleVoucherIds && !eligibleVoucherIds.has(v.id)) continue;
            voucherIdsInReport.add(v.id);
            if (!voucherMap[v.id]) voucherMap[v.id] = v;
          }
          if (!tenantVouchers || tenantVouchers.length < allVoucherPageSize) break;
          allVoucherFrom += allVoucherPageSize;
        }
      }

      const netByVoucher = {};
      const voucherIdList = Array.from(voucherIdsInReport);
      if (voucherIdList.length > 0) {
        const batchSize = 200;
        const netPageSize = 1000;
        for (let i = 0; i < voucherIdList.length; i += batchSize) {
          const batch = voucherIdList.slice(i, i + batchSize);
          let netFrom = 0;
          while (true) {
            const { data: allForVouchers, error: allErr } = await supabase
              .from('voucher_transaction')
              .select('id, voucher_id, amount, type')
              .eq('tenant_id', tenantId)
              .in('voucher_id', batch)
              .order('id', { ascending: true })
              .range(netFrom, netFrom + netPageSize - 1);
            if (allErr) {
              console.warn('[VoucherExportCSV] Full voucher history lookup error (non-blocking):', allErr.message);
              break;
            }
            for (const t of (allForVouchers || [])) {
              if (!t.voucher_id) continue;
              const amt = Math.abs(parseFloat(t.amount || 0));
              if (isNaN(amt)) continue;
              let signed = 0;
              if (NEGATIVE_TYPES.has(t.type)) signed = -amt;
              else if (POSITIVE_TYPES.has(t.type)) signed = amt;
              else {
                const raw = parseFloat(t.amount || 0);
                signed = isNaN(raw) ? 0 : raw;
              }
              netByVoucher[t.voucher_id] = (netByVoucher[t.voucher_id] || 0) + signed;
            }
            if (!allForVouchers || allForVouchers.length < netPageSize) break;
            netFrom += netPageSize;
          }
        }
      }
      const synthetic = [];
      for (const vid of voucherIdsInReport) {
        const v = voucherMap[vid];
        if (!v) continue;
        const currentValue = parseFloat(v.value);
        if (isNaN(currentValue)) continue;
        const originalValue = currentValue - (netByVoucher[vid] || 0);
        const sampleTxn = allTransactions.find(t => t.voucher_id === vid) || {};
        synthetic.push({
          id: `awarded-${vid}`,
          voucher_id: vid,
          organization_id: sampleTxn.organization_id || v.organization_id || null,
          booking_reference: null,
          event_id: null,
          event_title: null,
          member_id: null,
          member_email: null,
          amount: originalValue,
          balance_before: null,
          balance_after: originalValue,
          type: 'voucher_awarded',
          created_at: v.issued_at ?? v.created_at ?? null,
        });
      }
      // Emit all synthetic awarded rows; the voucher-level / row-level date
      // filter below applies to them exactly like real transaction rows.
      allTransactions.push(...synthetic);
    }

    if (dateFilterActive) {
      // Voucher-level date filtering mirroring the Voucher Management page
      // filter: Issued (issued_at falling back to created_at), Expiry
      // (expires_at) and Used (booking_usage redemption transaction dates)
      // decide which VOUCHERS are eligible; all transactions of an eligible
      // voucher are kept. Event date remains a row-level filter on the
      // linked event's start date.
      const normIso = (d) => {
        if (!d) return null;
        const t = new Date(d);
        return isNaN(t.getTime()) ? null : t.toISOString();
      };
      const inRange = (d) => {
        const iso = normIso(d);
        if (!iso) return false;
        if (fromIso && iso < fromIso) return false;
        if (toIso && iso > toIso) return false;
        return true;
      };

      // Redemption dates per voucher, needed for the Used-date field.
      let redemptionDatesByVoucher = null;
      if (dateField === 'used' || dateFallbackField === 'used') {
        redemptionDatesByVoucher = {};
        const rdPageSize = 1000;
        let rdFrom = 0;
        while (true) {
          const { data, error } = await supabase
            .from('voucher_transaction')
            .select('voucher_id, created_at')
            .eq('tenant_id', tenantId)
            .eq('type', 'booking_usage')
            .order('id', { ascending: true })
            .range(rdFrom, rdFrom + rdPageSize - 1);
          if (error) {
            console.error('[VoucherExportCSV] Redemption dates query error:', error);
            return res.status(500).json({ error: 'Failed to resolve used-date filter' });
          }
          for (const row of (data || [])) {
            if (!row.voucher_id || !row.created_at) continue;
            if (!redemptionDatesByVoucher[row.voucher_id]) redemptionDatesByVoucher[row.voucher_id] = [];
            redemptionDatesByVoucher[row.voucher_id].push(row.created_at);
          }
          if (!data || data.length < rdPageSize) break;
          rdFrom += rdPageSize;
        }
      }

      // Evaluate a field for a transaction row. Returns whether the row /
      // its voucher HAS the date at all, and whether it matches the range.
      const evalField = (t, field) => {
        if (field === 'event_date') {
          const d = t.event_id ? eventDateByEventId[t.event_id] : null;
          return { has: !!d, match: d ? inRange(d) : false };
        }
        const v = t.voucher_id ? voucherMap[t.voucher_id] : null;
        if (!v) return { has: false, match: false };
        if (field === 'issued') {
          const d = v.issued_at ?? v.created_at ?? null;
          return { has: !!d, match: d ? inRange(d) : false };
        }
        if (field === 'expiry') {
          const d = v.expires_at;
          return { has: !!d, match: d ? inRange(d) : false };
        }
        if (field === 'used') {
          const dates = (redemptionDatesByVoucher && redemptionDatesByVoucher[t.voucher_id]) || [];
          return { has: dates.length > 0, match: dates.some(inRange) };
        }
        return { has: false, match: false };
      };

      const filtered = allTransactions.filter((t) => {
        const primary = evalField(t, dateField);
        if (primary.has) return primary.match;
        if (dateFallbackField) {
          const fb = evalField(t, dateFallbackField);
          return fb.has && fb.match;
        }
        return false;
      });
      allTransactions.length = 0;
      allTransactions.push(...filtered);
    }

    if (excludeExpiredInRange && dateFilterActive) {
      // Drop every row (transaction AND synthetic awarded rows) whose linked
      // voucher's expiry date falls inside the selected From/To window.
      // Boundary dates count as inside the range. Rows with no linked
      // voucher, no expiry date, or an unparseable/out-of-range expiry are
      // kept.
      const fromMs = fromIso ? new Date(fromIso).getTime() : null;
      const toMs = toIso ? new Date(toIso).getTime() : null;
      const filtered = allTransactions.filter((t) => {
        if (!t.voucher_id) return true;
        const exp = voucherMap[t.voucher_id]?.expires_at;
        if (!exp) return true;
        const ms = new Date(exp).getTime();
        if (isNaN(ms)) return true;
        if (fromMs !== null && ms < fromMs) return true;
        if (toMs !== null && ms > toMs) return true;
        return false;
      });
      allTransactions.length = 0;
      allTransactions.push(...filtered);
    }

    const compareTyped = (av, bv, type) => {
      const aEmpty = av === null;
      const bEmpty = bv === null;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (type === 'number') {
        return av - bv;
      }
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
      const adRaw = a.created_at || '';
      const bdRaw = b.created_at || '';
      if (adRaw !== bdRaw) return adRaw < bdRaw ? 1 : -1;
      const aId = String(a.id || '');
      const bId = String(b.id || '');
      if (aId === bId) return 0;
      return aId < bId ? -1 : 1;
    });

    const cellFor = (t, key) => {
      switch (key) {
        case 'organization': return escapeCSV(orgMap[t.organization_id]?.name || '');
        case 'voucher_code': return escapeCSV(t.voucher_id ? (voucherMap[t.voucher_id]?.code || '') : '');
        case 'voucher_description': return escapeCSV(t.voucher_id ? (voucherMap[t.voucher_id]?.description || '') : '');
        case 'voucher_expiry_date': return escapeCSV(formatDateOnly(t.voucher_id ? voucherMap[t.voucher_id]?.expires_at : ''));
        case 'date': return escapeCSV(formatDate(t.created_at));
        case 'type': return escapeCSV(formatTransactionTypeLabel(t.type));
        case 'balance_before': return escapeCSV(formatBalance(t.balance_before));
        case 'amount': return formatSignedAmount(t);
        case 'balance_after': return escapeCSV(formatBalance(t.balance_after));
        case 'booking_reference': return escapeCSV(t.booking_reference || '');
        case 'event_internal_reference': {
          const v = t.event_id ? (internalRefByEventId[t.event_id] || '') : '';
          return escapeCSV(v);
        }
        case 'event_date': {
          const v = t.event_id ? formatDate(eventDateByEventId[t.event_id]) : '';
          return escapeCSV(v);
        }
        case 'event_title': return escapeCSV(t.event_title || '');
        case 'member': {
          const memberName = memberDisplayName(t.member_id ? memberMap[t.member_id] : null) || t.member_email || '';
          return escapeCSV(memberName);
        }
        case 'voucher_valid_from': return escapeCSV(formatDateOnly(t.voucher_id ? voucherMap[t.voucher_id]?.valid_from : ''));
        case 'funding_source': return escapeCSV(t.voucher_id ? (voucherMap[t.voucher_id]?.funding_source || '') : '');
        case 'created_by': return escapeCSV(t.voucher_id ? (voucherMap[t.voucher_id]?.created_by || '') : '');
        case 'voucher_notes': return escapeCSV(t.voucher_id ? (voucherMap[t.voucher_id]?.notes || '') : '');
        case 'notes': return escapeCSV(t.notes || '');
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
    const filename = `training_voucher_transactions_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Row-Count', String(allTransactions.length));
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[VoucherExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
