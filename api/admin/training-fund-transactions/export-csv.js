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
    default: return type || '';
  }
}

function formatSignedAmount(txn) {
  const amt = Math.abs(parseFloat(txn.amount || 0));
  const sign = txn.type === 'add' ? '' : '-';
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

const SORT_FIELDS = new Set(['organization', 'date', 'type', 'amount', 'balance_after']);

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

  const sortField = SORT_FIELDS.has(q.sort_field) ? q.sort_field : 'organization';
  const sortDir = q.sort_dir === 'desc' ? 'desc' : (q.sort_dir === 'asc' ? 'asc' : null);
  // Default direction differs by field to match the legacy behaviour
  // (Organisation asc, then Date desc).
  const effectiveSortDir = sortDir || (sortField === 'organization' ? 'asc' : 'desc');

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
      if (fromIso) query = query.gte('created_date', fromIso);
      if (toIso) query = query.lte('created_date', toIso);
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

    // ---- Look up creators (only when 'created_by' column is included) ----
    const memberMap = {};
    if (columnKeys.includes('created_by')) {
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
    const needRef = columnKeys.includes('event_internal_reference');
    const needEventDate = columnKeys.includes('event_date');
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
    const dirMul = effectiveSortDir === 'asc' ? 1 : -1;
    const sortValue = (t) => {
      switch (sortField) {
        case 'organization': return (orgMap[t.organization_id]?.name || '').toLowerCase();
        case 'date': return t.created_date || '';
        case 'type': return formatTransactionTypeLabel(t.type).toLowerCase();
        case 'amount': return signedAmountNumber(t);
        case 'balance_after': {
          const n = parseFloat(t.balance_after);
          return isNaN(n) ? 0 : n;
        }
        default: return '';
      }
    };
    allTransactions.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      let cmp;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        if (av === bv) cmp = 0;
        else cmp = av < bv ? -1 : 1;
      }
      if (cmp !== 0) return cmp * dirMul;
      // Stable secondary sort: created_date desc, then id, so equal keys
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
