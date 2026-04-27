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
  const sign = txn.type === 'add' ? '+' : '-';
  return `${sign}${amt.toFixed(2)}`;
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

  try {
    const allTransactions = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('training_fund_transaction')
        .select('id, organization_id, type, amount, balance_before, balance_after, reason, booking_id, created_by, created_date')
        .eq('tenant_id', tenantId)
        .range(from, from + pageSize - 1);
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

    const memberIds = Array.from(new Set(
      allTransactions.map(t => t.created_by).filter(Boolean)
    ));
    const memberMap = {};
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

    const bookingIds = Array.from(new Set(
      allTransactions
        .filter(t => t.type === 'booking_usage' && t.booking_id)
        .map(t => t.booking_id)
    ));

    const internalRefByBookingId = {};
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
          .select('id, internal_reference, tenant_id')
          .in('id', eventIds);
        if (eErr) {
          console.warn('[TrainingFundExportCSV] Events lookup error (non-blocking):', eErr.message);
          continue;
        }
        const events = (eventsRaw || []).filter(e => !e.tenant_id || e.tenant_id === tenantId);
        const eventRefMap = {};
        events.forEach(e => {
          if (e.internal_reference) eventRefMap[e.id] = e.internal_reference;
        });
        bookings.forEach(b => {
          const ref = eventRefMap[b.event_id];
          if (ref) internalRefByBookingId[b.id] = ref;
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
        const { data: ces, error: ceErr } = await supabase
          .from('complex_event')
          .select('id, internal_reference, tenant_id')
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
            });
        }
        complexBookings.forEach(b => {
          const ref = ceRefMap[b.event_id];
          if (ref) internalRefByBookingId[b.id] = ref;
        });
      }
    }

    allTransactions.sort((a, b) => {
      const aOrgName = (orgMap[a.organization_id]?.name || '').toLowerCase();
      const bOrgName = (orgMap[b.organization_id]?.name || '').toLowerCase();
      if (aOrgName !== bOrgName) return aOrgName.localeCompare(bOrgName);
      const aDate = a.created_date || '';
      const bDate = b.created_date || '';
      if (aDate === bDate) return 0;
      return aDate < bDate ? 1 : -1;
    });

    const headers = [
      'Organisation',
      'Date',
      'Type',
      'Amount',
      'Balance Before',
      'Balance After',
      'Reason',
      'Created By',
      'Event Internal Reference'
    ];

    const headerRow = headers.map(escapeCSV).join(',');
    const dataRows = allTransactions.map(t => {
      const orgName = orgMap[t.organization_id]?.name || '';
      const member = t.created_by ? memberMap[t.created_by] : null;
      const internalRef = (t.type === 'booking_usage' && t.booking_id)
        ? (internalRefByBookingId[t.booking_id] || '')
        : '';
      return [
        orgName,
        formatDate(t.created_date),
        formatTransactionTypeLabel(t.type),
        formatSignedAmount(t),
        formatBalance(t.balance_before),
        formatBalance(t.balance_after),
        t.reason || '',
        memberDisplayName(member),
        internalRef
      ].map(escapeCSV).join(',');
    });

    const csv = [headerRow, ...dataRows].join('\n');

    const today = new Date().toISOString().split('T')[0];
    const filename = `training_fund_transactions_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[TrainingFundExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
