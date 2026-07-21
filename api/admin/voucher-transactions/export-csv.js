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
    default: return type || '';
  }
}

const POSITIVE_TYPES = new Set(['cancellation_refund', 'credit_adjustment', 'voucher_awarded']);
const NEGATIVE_TYPES = new Set(['booking_usage', 'debit_adjustment']);

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
};
const SORT_FIELDS = new Set(Object.keys(SORT_FIELD_TYPES));
const DATE_FILTER_FIELDS = new Set(
  Object.keys(SORT_FIELD_TYPES).filter(k => SORT_FIELD_TYPES[k] === 'date')
);
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
  const canUseDbDateFilter = dateField === 'date' && !dateFallbackField;

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
    sortFieldsReferenced.add(dateField);
    if (dateFallbackField) sortFieldsReferenced.add(dateFallbackField);
  }

  const referencesAny = (keys) =>
    keys.some(k => columnKeys.includes(k) || sortFieldsReferenced.has(k));

  const needVoucher = true;
  const needMember = referencesAny(['member']);
  const needEventRef = referencesAny(['event_internal_reference']);
  const needEventDate = referencesAny(['event_date']);
  const needEventLookup = needEventRef || needEventDate;

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
        let hasIssuedAt = true;
        let vFrom = 0;
        const buildQuery = () => supabase
          .from('voucher')
          .select(hasIssuedAt ? 'id, created_at, expires_at, issued_at' : 'id, created_at, expires_at')
          .eq('tenant_id', tenantId)
          .order('id', { ascending: true })
          .range(vFrom, vFrom + pageSize - 1);
        while (true) {
          let { data, error } = await buildQuery();
          if (error && error.code === '42703' && hasIssuedAt) {
            hasIssuedAt = false;
            ({ data, error } = await buildQuery());
          }
          if (error) {
            console.error('[VoucherExportCSV] Voucher date filter query error:', error);
            return res.status(500).json({ error: 'Failed to resolve voucher date filter' });
          }
          for (const v of (data || [])) {
            const d = voucherDateField === 'expiry' ? v.expires_at : (v.issued_at || v.created_at);
            if (inVoucherWindow(d)) eligibleVoucherIds.add(v.id);
          }
          if (!data || data.length < pageSize) break;
          vFrom += pageSize;
        }
      }
    }

    const allTransactions = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      let query = supabase
        .from('voucher_transaction')
        .select('id, voucher_id, organization_id, booking_reference, event_id, event_title, member_id, member_email, amount, balance_before, balance_after, type, created_at')
        .eq('tenant_id', tenantId);
      if (canUseDbDateFilter && fromIso) query = query.gte('created_at', fromIso);
      if (canUseDbDateFilter && toIso) query = query.lte('created_at', toIso);
      if (orgFilterActive) query = query.in('organization_id', requestedOrgIds);
      query = query.order('id', { ascending: true }).range(from, from + pageSize - 1);

      const { data, error } = await query;
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
    // Tracks whether the `voucher.issued_at` column exists in this
    // environment. The migration adding it (20260515_add_voucher_issued_at)
    // may not yet be applied. If a query fails with 42703 ("column does not
    // exist") we retry without `issued_at` and disable it for subsequent
    // queries in this request.
    let voucherHasIssuedAt = true;
    const voucherSelectCols = () =>
      voucherHasIssuedAt
        ? 'id, code, description, expires_at, value, organization_id, issued_at'
        : 'id, code, description, expires_at, value, organization_id';
    if (needVoucher) {
      const voucherIds = Array.from(new Set(
        allTransactions.map(t => t.voucher_id).filter(Boolean)
      ));
      if (voucherIds.length > 0) {
        const batchSize = 200;
        for (let i = 0; i < voucherIds.length; i += batchSize) {
          const batch = voucherIds.slice(i, i + batchSize);
          let { data: vouchers, error: vErr } = await supabase
            .from('voucher')
            .select(voucherSelectCols())
            .in('id', batch);
          if (vErr && vErr.code === '42703' && voucherHasIssuedAt) {
            voucherHasIssuedAt = false;
            console.warn('[VoucherExportCSV] voucher.issued_at missing; retrying without it. Apply migration 20260515_add_voucher_issued_at to enable date-filtered awarded rows.');
            ({ data: vouchers, error: vErr } = await supabase
              .from('voucher')
              .select(voucherSelectCols())
              .in('id', batch));
          }
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
          let { data: tenantVouchers, error: allVoucherErr } = await buildAllVoucherQuery();
          if (allVoucherErr && allVoucherErr.code === '42703' && voucherHasIssuedAt) {
            voucherHasIssuedAt = false;
            ({ data: tenantVouchers, error: allVoucherErr } = await buildAllVoucherQuery());
          }
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
          created_at: v.issued_at || null,
        });
      }
      if (dateFilterActive && canUseDbDateFilter) {
        // Per-row date filtering: include awarded rows whose voucher
        // issue date (voucher.issued_at, surfaced as the synthetic row's
        // created_at) falls inside the active window; omit rows with
        // missing or out-of-range dates.
        const fromMs = fromIso ? new Date(fromIso).getTime() : null;
        const toMs = toIso ? new Date(toIso).getTime() : null;
        for (const s of synthetic) {
          if (!s.created_at) continue;
          const ms = new Date(s.created_at).getTime();
          if (isNaN(ms)) continue;
          if (fromMs !== null && ms < fromMs) continue;
          if (toMs !== null && ms > toMs) continue;
          allTransactions.push(s);
        }
      } else {
        // No date filter (or JS-side date filtering further down handles
        // the window): emit all synthetic rows. The downstream JS date
        // filter at line ~597 will drop any with a null/out-of-range
        // creation date when a non-DB date filter is active.
        allTransactions.push(...synthetic);
      }
    }

    if (!canUseDbDateFilter && dateFilterActive) {
      const filtered = allTransactions.filter((t) => {
        let v = rawValue(t, dateField);
        if (v === null && dateFallbackField) {
          v = rawValue(t, dateFallbackField);
        }
        if (v === null) return false;
        const iso = String(v);
        if (fromIso && iso < fromIso) return false;
        if (toIso && iso > toIso) return false;
        return true;
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
