// Event Budget Report: budgeted vs actual financials per event (simple + complex).
// Admin-gated (getTenantContext + hasAdminAccess). Per event within an optional
// event start-date range it aggregates:
//   - actual income from non-cancelled booking rows (booking.total_cost /
//     complex_event_booking.total_paid)
//   - training voucher totals (booking voucher_amount; voucher_transaction
//     type=booking_usage ledger total returned as a cross-check)
//   - training fund amounts
//   - actual costs from itemised event_cost_line rows
//   - budgeted income/costs from the event rows, computed differences and
//     profit/loss (actual and budgeted)
//   - seats (ticket-class capacity), attendee counts, distinct organisations
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';

export const REPORT_FEATURE_KEY = 'events.event-budget-report';

// Shared guard: admin access AND (for role-based members) the report's own
// RBAC feature key. Tenant users (admin dashboard sessions) have no role and
// always pass, matching hasAdminAccess policy.
export async function checkBudgetReportAccess(req, res) {
  const tenantCtx = await getTenantContext(req);
  if (tenantCtx.tenantMismatch) {
    res.status(409).json({
      error: 'Your browser session has switched to a different organisation. Reload this tab to continue.',
      code: 'TENANT_CONTEXT_CHANGED',
    });
    return null;
  }
  if (!tenantCtx.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!(await hasAdminAccess(tenantCtx))) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  // Feature-level RBAC: a member whose role excludes the report key must not
  // reach the data even if they otherwise have admin access.
  if (tenantCtx.roleId && !(await hasFeatureAccess(tenantCtx.roleId, REPORT_FEATURE_KEY))) {
    res.status(403).json({ error: 'You do not have access to the Event Budget Report' });
    return null;
  }
  if (!tenantCtx.tenantId) {
    res.status(403).json({ error: 'No tenant context' });
    return null;
  }
  return tenantCtx;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Paginate defensively past PostgREST's 1000-row cap (ordered by id).
async function fetchAllPaged(buildQuery) {
  const pageSize = 1000;
  let offset = 0;
  const all = [];
  for (;;) {
    const { data, error } = await buildQuery().order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  return all;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantCtx = await checkBudgetReportAccess(req, res);
  if (!tenantCtx) return;
  const tenantId = tenantCtx.tenantId;

  const { eventDateFrom, eventDateTo } = req.query;

  try {
    // ---- Events (simple) — budgeted columns may not exist yet in some DBs.
    let { data: regularEvents, error: eventsError } = await supabase
      .from('event')
      .select('id, title, start_date, status, internal_reference, is_complex, pricing_config, is_unlimited_tickets, budgeted_income, budgeted_costs')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });
    if (eventsError && /budgeted|is_unlimited_tickets/i.test(eventsError.message || '')) {
      console.warn('[Event Budget Report] event budget columns unavailable, retrying without them');
      const fallback = await supabase
        .from('event')
        .select('id, title, start_date, status, internal_reference, is_complex, pricing_config')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false });
      regularEvents = fallback.data;
      eventsError = fallback.error;
    }
    if (eventsError) {
      console.error('[Event Budget Report] Error fetching events:', eventsError);
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    // ---- Complex events — internal_reference / budgeted columns drop-and-retry.
    let { data: complexEvents, error: complexError } = await supabase
      .from('complex_event')
      .select('id, title, start_date, status, internal_reference, budgeted_income, budgeted_costs')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });
    if (complexError && /budgeted|internal_reference/i.test(complexError.message || '')) {
      console.warn('[Event Budget Report] complex_event columns unavailable, retrying reduced select');
      const fallback = await supabase
        .from('complex_event')
        .select('id, title, start_date, status')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false });
      complexEvents = fallback.data;
      complexError = fallback.error;
    }
    if (complexError) {
      console.error('[Event Budget Report] Error fetching complex events:', complexError);
      complexEvents = [];
    }

    // Exclude "To be confirmed" events (interest gatherers), mirroring the
    // Event Registration Report.
    regularEvents = (regularEvents || []).filter((e) => e.status !== 'tbc');
    complexEvents = (complexEvents || []).filter((e) => e.status !== 'tbc');

    // ---- Event start-date range filter (whole days, inclusive).
    // Simple events use event.start_date; complex events use the earliest
    // complex_event_session start_time, falling back to complex_event.start_date.
    if (eventDateFrom || eventDateTo) {
      const fromMs = eventDateFrom ? new Date(eventDateFrom + 'T00:00:00.000Z').getTime() : null;
      let toMs = null;
      if (eventDateTo) {
        const toDate = new Date(eventDateTo + 'T00:00:00.000Z');
        toDate.setUTCDate(toDate.getUTCDate() + 1);
        toMs = toDate.getTime();
      }
      const inRange = (dateValue) => {
        if (!dateValue) return false;
        const ms = new Date(dateValue).getTime();
        if (Number.isNaN(ms)) return false;
        if (fromMs !== null && ms < fromMs) return false;
        if (toMs !== null && ms >= toMs) return false;
        return true;
      };

      regularEvents = regularEvents.filter((e) => inRange(e.start_date));

      if (complexEvents.length > 0) {
        const earliestSessionByEvent = new Map();
        const { data: sessionRows, error: sessionsError } = await supabase
          .from('complex_event_session')
          .select('complex_event_id, start_time')
          .in('complex_event_id', complexEvents.map((e) => e.id))
          .eq('tenant_id', tenantId);
        if (sessionsError) {
          console.error('[Event Budget Report] Error fetching complex event sessions:', sessionsError);
        } else {
          for (const s of sessionRows || []) {
            if (!s.start_time) continue;
            const ms = new Date(s.start_time).getTime();
            if (Number.isNaN(ms)) continue;
            const existing = earliestSessionByEvent.get(s.complex_event_id);
            if (existing === undefined || ms < existing) earliestSessionByEvent.set(s.complex_event_id, ms);
          }
        }
        complexEvents = complexEvents.filter((e) => {
          const sessionMs = earliestSessionByEvent.get(e.id);
          if (sessionMs !== undefined) {
            if (fromMs !== null && sessionMs < fromMs) return false;
            if (toMs !== null && sessionMs >= toMs) return false;
            return true;
          }
          return inRange(e.start_date);
        });
      }
    }

    const simpleIds = regularEvents.map((e) => e.id);
    const complexIds = complexEvents.map((e) => e.id);
    const allIds = [...simpleIds, ...complexIds];

    // ---- Per-event aggregation buckets.
    const makeAgg = () => ({
      actual_income: 0,
      voucher_total: 0,
      training_fund_total: 0,
      attendees: 0,
      orgIds: new Set(),
    });
    const aggByEvent = new Map();
    for (const id of allIds) aggByEvent.set(id, makeAgg());

    // ---- Bookings (non-cancelled), paginated + chunked by event ids.
    for (const ids of chunk(simpleIds, 100)) {
      const rows = await fetchAllPaged(() =>
        supabase
          .from('booking')
          .select('id, event_id, total_cost, voucher_amount, training_fund_amount, organization_id, status')
          .in('event_id', ids)
          .eq('tenant_id', tenantId)
          .neq('status', 'cancelled')
      );
      for (const b of rows) {
        const agg = aggByEvent.get(b.event_id);
        if (!agg) continue;
        agg.actual_income += Number(b.total_cost) || 0;
        agg.voucher_total += Number(b.voucher_amount) || 0;
        agg.training_fund_total += Number(b.training_fund_amount) || 0;
        agg.attendees += 1;
        if (b.organization_id) agg.orgIds.add(b.organization_id);
      }
    }
    for (const ids of chunk(complexIds, 100)) {
      const rows = await fetchAllPaged(() =>
        supabase
          .from('complex_event_booking')
          .select('id, event_id, total_paid, voucher_amount, training_fund_amount, organization_id, status')
          .in('event_id', ids)
          .eq('tenant_id', tenantId)
          .neq('status', 'cancelled')
      );
      for (const b of rows) {
        const agg = aggByEvent.get(b.event_id);
        if (!agg) continue;
        agg.actual_income += Number(b.total_paid) || 0;
        agg.voucher_total += Number(b.voucher_amount) || 0;
        agg.training_fund_total += Number(b.training_fund_amount) || 0;
        agg.attendees += 1;
        if (b.organization_id) agg.orgIds.add(b.organization_id);
      }
    }

    // ---- Voucher ledger cross-check (best-effort, never blocks the report).
    const ledgerByEvent = new Map();
    if (allIds.length > 0) {
      try {
        for (const ids of chunk(allIds, 100)) {
          const rows = await fetchAllPaged(() =>
            supabase
              .from('voucher_transaction')
              .select('id, event_id, amount, type')
              .in('event_id', ids)
              .eq('tenant_id', tenantId)
              .eq('type', 'booking_usage')
          );
          for (const t of rows) {
            ledgerByEvent.set(t.event_id, (ledgerByEvent.get(t.event_id) || 0) + Math.abs(Number(t.amount) || 0));
          }
        }
      } catch (err) {
        console.warn('[Event Budget Report] Voucher ledger cross-check unavailable:', err.message);
      }
    }

    // ---- Actual costs from itemised cost lines.
    const costsByEvent = new Map();
    if (allIds.length > 0) {
      for (const ids of chunk(allIds, 100)) {
        const rows = await fetchAllPaged(() =>
          supabase
            .from('event_cost_line')
            .select('id, event_id, quantity, unit_cost')
            .in('event_id', ids)
            .eq('tenant_id', tenantId)
        );
        for (const l of rows) {
          const line = (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0);
          costsByEvent.set(l.event_id, (costsByEvent.get(l.event_id) || 0) + line);
        }
      }
    }

    // ---- Seats (ticket-class capacity).
    // Simple: pricing_config.ticket_classes[*].available_count.
    // Complex: complex_event_ticket_class.available_count.
    const seatsByEvent = new Map(); // id -> { seats: number, unlimited: boolean }
    for (const e of regularEvents) {
      let seats = 0;
      let unlimited = e.is_unlimited_tickets === true;
      const classes = Array.isArray(e.pricing_config?.ticket_classes) ? e.pricing_config.ticket_classes : [];
      for (const tc of classes) {
        const cap = Number(tc?.available_count);
        if (tc?.is_unlimited_tickets === true || tc?.available_count == null || !Number.isFinite(cap)) {
          unlimited = true;
        } else {
          seats += cap;
        }
      }
      seatsByEvent.set(e.id, { seats, unlimited });
    }
    if (complexIds.length > 0) {
      const { data: ticketClasses, error: tcError } = await supabase
        .from('complex_event_ticket_class')
        .select('id, complex_event_id, available_count, is_unlimited_tickets')
        .in('complex_event_id', complexIds)
        .eq('tenant_id', tenantId);
      if (tcError) {
        console.error('[Event Budget Report] Error fetching complex ticket classes:', tcError);
      }
      for (const id of complexIds) seatsByEvent.set(id, { seats: 0, unlimited: false });
      for (const tc of ticketClasses || []) {
        const entry = seatsByEvent.get(tc.complex_event_id);
        if (!entry) continue;
        const cap = Number(tc.available_count);
        if (tc.is_unlimited_tickets === true || tc.available_count == null || !Number.isFinite(cap)) {
          entry.unlimited = true;
        } else {
          entry.seats += cap;
        }
      }
    }

    // ---- Build rows + totals.
    const buildRow = (e, kind) => {
      const agg = aggByEvent.get(e.id) || makeAgg();
      const actualIncome = round2(agg.actual_income);
      const budgetedIncome = e.budgeted_income == null ? null : round2(e.budgeted_income);
      const actualCosts = round2(costsByEvent.get(e.id) || 0);
      const budgetedCosts = e.budgeted_costs == null ? null : round2(e.budgeted_costs);
      const actualProfit = round2(actualIncome - actualCosts);
      const budgetedProfit = round2((budgetedIncome || 0) - (budgetedCosts || 0));
      const seatInfo = seatsByEvent.get(e.id) || { seats: 0, unlimited: false };
      return {
        event_id: e.id,
        event_kind: kind,
        project_code: e.internal_reference || null,
        event_name: e.title || null,
        start_date: e.start_date || null,
        actual_income: actualIncome,
        budgeted_income: budgetedIncome,
        income_difference: round2(actualIncome - (budgetedIncome || 0)),
        vouchers_redeemed: round2(agg.voucher_total),
        vouchers_ledger_total: round2(ledgerByEvent.get(e.id) || 0),
        training_fund_total: round2(agg.training_fund_total),
        actual_costs: actualCosts,
        budgeted_costs: budgetedCosts,
        costs_difference: round2(actualCosts - (budgetedCosts || 0)),
        actual_profit: actualProfit,
        budgeted_profit: budgetedProfit,
        profit_difference: round2(actualProfit - budgetedProfit),
        seats: seatInfo.seats,
        seats_unlimited: seatInfo.unlimited,
        attendees: agg.attendees,
        organisations: agg.orgIds.size,
      };
    };

    const rows = [
      ...regularEvents.map((e) => buildRow(e, 'simple')),
      ...complexEvents.map((e) => buildRow(e, 'complex')),
    ].sort((a, b) => {
      const aDate = a.start_date ? new Date(a.start_date).getTime() : 0;
      const bDate = b.start_date ? new Date(b.start_date).getTime() : 0;
      return bDate - aDate;
    });

    const totals = rows.reduce(
      (t, r) => {
        t.actual_income += r.actual_income;
        t.budgeted_income += r.budgeted_income || 0;
        t.vouchers_redeemed += r.vouchers_redeemed;
        t.training_fund_total += r.training_fund_total;
        t.actual_costs += r.actual_costs;
        t.budgeted_costs += r.budgeted_costs || 0;
        t.actual_profit += r.actual_profit;
        t.budgeted_profit += r.budgeted_profit;
        t.seats += r.seats;
        t.seats_unlimited = t.seats_unlimited || r.seats_unlimited;
        t.attendees += r.attendees;
        return t;
      },
      {
        actual_income: 0,
        budgeted_income: 0,
        vouchers_redeemed: 0,
        training_fund_total: 0,
        actual_costs: 0,
        budgeted_costs: 0,
        actual_profit: 0,
        budgeted_profit: 0,
        seats: 0,
        seats_unlimited: false,
        attendees: 0,
      }
    );
    // Distinct organisations across the whole report (not the sum of per-event counts).
    const allOrgIds = new Set();
    for (const agg of aggByEvent.values()) for (const id of agg.orgIds) allOrgIds.add(id);
    totals.organisations = allOrgIds.size;
    totals.income_difference = round2(totals.actual_income - totals.budgeted_income);
    totals.costs_difference = round2(totals.actual_costs - totals.budgeted_costs);
    totals.profit_difference = round2(totals.actual_profit - totals.budgeted_profit);
    for (const k of ['actual_income', 'budgeted_income', 'vouchers_redeemed', 'training_fund_total', 'actual_costs', 'budgeted_costs', 'actual_profit', 'budgeted_profit']) {
      totals[k] = round2(totals[k]);
    }

    return res.json({ rows, totals, eventCount: rows.length });
  } catch (err) {
    console.error('[Event Budget Report] error:', err);
    return res.status(500).json({ error: 'Failed to generate event budget report' });
  }
}
