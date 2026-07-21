import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

const GENERIC_EVENT_TITLES = new Set([
  'complex event',
  'cancellation refund',
  'event',
]);

function isGenericTitle(title) {
  if (!title) return true;
  return GENERIC_EVENT_TITLES.has(String(title).trim().toLowerCase());
}

function memberDisplayName(member) {
  if (!member) return '';
  const composed = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
  if (composed) return composed;
  return member.email || '';
}

function buildUsageDescription(txn) {
  const eventTitle = txn.event_title && !isGenericTitle(txn.event_title) ? txn.event_title : null;
  const bookingRef = txn.booking_reference || null;
  switch (txn.type) {
    case 'booking_usage': {
      if (eventTitle) return `Used for booking: ${eventTitle}`;
      if (bookingRef) return `Used for booking ${bookingRef}`;
      return 'Used for an event booking (details unavailable)';
    }
    case 'cancellation_refund': {
      if (eventTitle) return `Refund from cancelled booking: ${eventTitle}`;
      if (bookingRef) return `Refund from cancelled booking ${bookingRef}`;
      return 'Refund from a cancelled booking (details unavailable)';
    }
    case 'credit_adjustment':
      return eventTitle ? `Balance adjustment: ${eventTitle}` : 'Manual balance adjustment (credit)';
    case 'debit_adjustment':
      return eventTitle ? `Balance adjustment: ${eventTitle}` : 'Manual balance adjustment (debit)';
    case 'voucher_awarded':
      return 'Voucher awarded to organisation';
    default:
      return eventTitle ? `Voucher activity: ${eventTitle}` : 'Voucher balance change';
  }
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

  const voucherId = req.query?.voucher_id;
  if (!voucherId) {
    return res.status(400).json({ error: 'voucher_id is required' });
  }

  try {
    const { data: voucher, error: vErr } = await supabase
      .from('voucher')
      .select('id, tenant_id')
      .eq('id', voucherId)
      .maybeSingle();
    if (vErr) {
      console.error('[VoucherTransactions] Voucher lookup error:', vErr);
      return res.status(500).json({ error: 'Failed to fetch voucher' });
    }
    if (!voucher || (voucher.tenant_id && voucher.tenant_id !== tenantId)) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    const { data: transactions, error: txErr } = await supabase
      .from('voucher_transaction')
      .select('id, voucher_id, organization_id, booking_reference, event_id, event_title, member_id, member_email, amount, balance_before, balance_after, type, created_at')
      .eq('voucher_id', voucherId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (txErr) {
      console.error('[VoucherTransactions] Transactions query error:', txErr);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }
    const txns = transactions || [];

    const eventIds = Array.from(new Set(txns.map(t => t.event_id).filter(Boolean)));
    const eventById = {};
    if (eventIds.length > 0) {
      const batchSize = 100;
      const resolved = new Set();
      for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const { data: events, error: eErr } = await supabase
          .from('event')
          .select('id, title, start_date, internal_reference, tenant_id')
          .in('id', batch);
        if (eErr) {
          console.warn('[VoucherTransactions] Event lookup error (non-blocking):', eErr.message);
          continue;
        }
        (events || [])
          .filter(e => !e.tenant_id || e.tenant_id === tenantId)
          .forEach(e => {
            resolved.add(e.id);
            eventById[e.id] = e;
          });
      }
      const unresolved = eventIds.filter(id => !resolved.has(id));
      for (let i = 0; i < unresolved.length; i += batchSize) {
        const batch = unresolved.slice(i, i + batchSize);
        const { data: ces, error: ceErr } = await supabase
          .from('complex_event')
          .select('id, title, start_date, internal_reference, tenant_id')
          .in('id', batch);
        if (ceErr) {
          if (ceErr.code !== '42703') {
            console.warn('[VoucherTransactions] Complex event lookup error (non-blocking):', ceErr.message);
          }
          continue;
        }
        (ces || [])
          .filter(e => !e.tenant_id || e.tenant_id === tenantId)
          .forEach(e => { eventById[e.id] = e; });
      }
    }

    const memberIds = Array.from(new Set(txns.map(t => t.member_id).filter(Boolean)));
    const memberById = {};
    if (memberIds.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < memberIds.length; i += batchSize) {
        const batch = memberIds.slice(i, i + batchSize);
        const { data: members, error: mErr } = await supabase
          .from('member')
          .select('id, first_name, last_name, email, tenant_id')
          .in('id', batch);
        if (mErr) {
          console.warn('[VoucherTransactions] Member lookup error (non-blocking):', mErr.message);
          continue;
        }
        (members || [])
          .filter(m => !m.tenant_id || m.tenant_id === tenantId)
          .forEach(m => { memberById[m.id] = m; });
      }
    }

    const enriched = txns.map(txn => {
      const ev = txn.event_id ? eventById[txn.event_id] : null;
      const eventTitle = (ev && ev.title) || (!isGenericTitle(txn.event_title) ? txn.event_title : null);
      const member = txn.member_id ? memberById[txn.member_id] : null;
      const memberName = memberDisplayName(member) || null;
      const enrichedTxn = {
        ...txn,
        event_title: eventTitle,
        event_date: ev?.start_date || null,
        event_internal_reference: ev?.internal_reference || null,
        member_name: memberName,
      };
      return {
        ...enrichedTxn,
        usage_description: buildUsageDescription(enrichedTxn),
      };
    });

    return res.status(200).json({ transactions: enriched });
  } catch (err) {
    console.error('[VoucherTransactions] Unexpected error:', err);
    return res.status(500).json({ error: 'Failed to fetch voucher transactions' });
  }
}
