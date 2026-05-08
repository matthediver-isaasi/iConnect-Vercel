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
    default: return type || '';
  }
}

const POSITIVE_TYPES = new Set(['cancellation_refund', 'credit_adjustment']);
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
        .from('voucher_transaction')
        .select('id, voucher_id, organization_id, booking_reference, event_id, event_title, member_id, member_email, amount, balance_before, balance_after, type, created_at')
        .eq('tenant_id', tenantId)
        .range(from, from + pageSize - 1);
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

    const voucherIds = Array.from(new Set(
      allTransactions.map(t => t.voucher_id).filter(Boolean)
    ));
    const voucherMap = {};
    if (voucherIds.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < voucherIds.length; i += batchSize) {
        const batch = voucherIds.slice(i, i + batchSize);
        const { data: vouchers, error: vErr } = await supabase
          .from('voucher')
          .select('id, code, description, expires_at, tenant_id')
          .in('id', batch);
        if (vErr) {
          console.warn('[VoucherExportCSV] Voucher lookup error (non-blocking):', vErr.message);
          continue;
        }
        (vouchers || []).forEach(v => {
          if (v.tenant_id && v.tenant_id !== tenantId) return;
          voucherMap[v.id] = v;
        });
      }
    }

    const memberIds = Array.from(new Set(
      allTransactions.map(t => t.member_id).filter(Boolean)
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
          console.warn('[VoucherExportCSV] Members query error (non-blocking):', memberErr.message);
          continue;
        }
        (members || []).forEach(m => {
          if (m.tenant_id && m.tenant_id !== tenantId) return;
          memberMap[m.id] = m;
        });
      }
    }

    const eventIds = Array.from(new Set(
      allTransactions.map(t => t.event_id).filter(Boolean)
    ));

    const internalRefByEventId = {};
    const eventDateByEventId = {};
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

    allTransactions.sort((a, b) => {
      const aOrgName = (orgMap[a.organization_id]?.name || '').toLowerCase();
      const bOrgName = (orgMap[b.organization_id]?.name || '').toLowerCase();
      if (aOrgName !== bOrgName) return aOrgName.localeCompare(bOrgName);
      const aDate = a.created_at || '';
      const bDate = b.created_at || '';
      if (aDate === bDate) return 0;
      return aDate < bDate ? 1 : -1;
    });

    const headers = [
      'Organisation',
      'Voucher Code',
      'Voucher Description',
      'Voucher Expiry Date',
      'Date',
      'Type',
      'Balance Before',
      'Amount',
      'Balance After',
      'Booking Reference',
      'Event Internal Reference',
      'Event Date',
      'Event Title',
      'Member'
    ];

    const headerRow = headers.map(escapeCSV).join(',');
    const dataRows = allTransactions.map(t => {
      const orgName = orgMap[t.organization_id]?.name || '';
      const voucher = t.voucher_id ? voucherMap[t.voucher_id] : null;
      const member = t.member_id ? memberMap[t.member_id] : null;
      const memberName = memberDisplayName(member) || t.member_email || '';
      const internalRef = t.event_id ? (internalRefByEventId[t.event_id] || '') : '';
      const eventDate = t.event_id ? formatDate(eventDateByEventId[t.event_id]) : '';
      const cells = [
        escapeCSV(orgName),
        escapeCSV(voucher?.code || ''),
        escapeCSV(voucher?.description || ''),
        escapeCSV(formatDateOnly(voucher?.expires_at)),
        escapeCSV(formatDate(t.created_at)),
        escapeCSV(formatTransactionTypeLabel(t.type)),
        escapeCSV(formatBalance(t.balance_before)),
        formatSignedAmount(t),
        escapeCSV(formatBalance(t.balance_after)),
        escapeCSV(t.booking_reference || ''),
        escapeCSV(internalRef),
        escapeCSV(eventDate),
        escapeCSV(t.event_title || ''),
        escapeCSV(memberName)
      ];
      return cells.join(',');
    });

    const csv = [headerRow, ...dataRows].join('\n');

    const today = new Date().toISOString().split('T')[0];
    const filename = `training_voucher_transactions_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[VoucherExportCSV] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
