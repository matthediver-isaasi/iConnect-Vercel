// Event Budget: actual ticket revenue for a given event.
// Admin-gated. Sums booking totals for non-cancelled bookings:
//   simple events  -> booking.total_cost
//   complex events -> complex_event_booking.total_paid
// Those totals already reflect discounts, voucher and training-fund usage,
// so the figure represents income the event actually earned.
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (tenantCtx.tenantMismatch) {
    return res.status(409).json({
      error: 'Your browser session has switched to a different organisation. Reload this tab to continue.',
      code: 'TENANT_CONTEXT_CHANGED',
    });
  }
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const isAdmin = await hasAdminAccess(tenantCtx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'No tenant context' });
  }

  const eventId = req.query.event_id;
  const kind = req.query.kind === 'complex' ? 'complex' : 'simple';
  if (!eventId) {
    return res.status(400).json({ error: 'event_id is required' });
  }

  try {
    const table = kind === 'complex' ? 'complex_event_booking' : 'booking';
    const amountCol = kind === 'complex' ? 'total_paid' : 'total_cost';

    let total = 0;
    let count = 0;
    const pageSize = 1000;
    let offset = 0;
    // Paginate defensively past PostgREST's 1000-row cap (ordered by id).
    for (;;) {
      const { data, error } = await supabase
        .from(table)
        .select(`id, status, ${amountCol}`)
        .eq('event_id', eventId)
        .eq('tenant_id', tenantCtx.tenantId)
        .neq('status', 'cancelled')
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      const rows = data || [];
      for (const row of rows) {
        total += Number(row[amountCol]) || 0;
        count += 1;
      }
      if (rows.length < pageSize) break;
      offset += rows.length;
    }

    return res.json({
      event_id: eventId,
      kind,
      actual_revenue: Math.round(total * 100) / 100,
      booking_count: count,
    });
  } catch (err) {
    console.error('[BudgetRevenue] error:', err.message);
    return res.status(500).json({ error: 'Failed to compute actual revenue' });
  }
}
