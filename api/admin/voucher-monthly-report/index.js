// Task #3118 Phase 3: Monthly voucher finance report (tenant-admin only).
//
//   GET ?month=YYYY-MM                       -> summary: one row per org.
//       Closed months come straight from voucher_monthly_snapshot (marked
//       closed:true); open/unclosed months are computed live from the ledger
//       via the Phase 2 engine. Optional summary filters:
//         &organization_id=<uuid>
//         &balance=positive|zero|negative    (on closing_balance)
//   GET ?month=YYYY-MM&view=detail           -> supporting transaction rows
//       for the reporting month, attributed by the same recognition rules
//       as the rollup. Filters:
//         &organization_id, &voucher_status=active|expired|exhausted,
//         &allocation_from/&allocation_to (YYYY-MM-DD),
//         &expiry_from/&expiry_to (YYYY-MM-DD),
//         &event_id, &type (txn type incl. voucher_awarded),
//         &funding_source
//
// Admin RBAC via getTenantContext + hasAdminAccess (never
// getTenantIdFromSession — membership alone is not enough).

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  isValidMonth,
  monthStartDate,
  computeTenantMonthRollup,
} from '../../_lib/voucherMonthlyRollup.js';
import {
  loadReportData,
  buildDetailRows,
  filterDetailRows,
  sortDetailRows,
} from '../../_lib/voucherMonthlyReport.js';

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getSummary(tenantId, month) {
  const { data: stored, error: sErr } = await supabase
    .from('voucher_monthly_snapshot')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('month', monthStartDate(month));
  if (sErr && sErr.code !== '42P01') {
    throw new Error('Snapshot read failed: ' + sErr.message);
  }

  const closed = !!(stored && stored.length > 0);
  let rows;
  let generatedAt = null;
  if (closed) {
    rows = stored.map((s) => ({
      organization_id: s.organization_id,
      opening_balance: num(s.opening_balance),
      allocated: num(s.allocated),
      used: num(s.used),
      expired: num(s.expired),
      adjustments_positive: num(s.adjustments_positive),
      adjustments_negative: num(s.adjustments_negative),
      reinstated: num(s.reinstated),
      closing_balance: num(s.closing_balance),
      reserved_future: num(s.reserved_future),
      available_balance: num(s.available_balance),
    }));
    generatedAt = stored.reduce((m, s) => (s.generated_at && (!m || s.generated_at > m) ? s.generated_at : m), null);
  } else {
    const { rows: computed } = await computeTenantMonthRollup(tenantId, month);
    rows = Object.entries(computed).map(([orgId, r]) => ({ organization_id: orgId, ...r }));
  }

  const { data: orgs, error: orgErr } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);
  if (orgErr) throw new Error('Organisation lookup failed: ' + orgErr.message);
  const orgNameById = {};
  (orgs || []).forEach((o) => { orgNameById[o.id] = o.name || ''; });

  rows = rows.map((r) => ({ ...r, organization_name: orgNameById[r.organization_id] || '' }));
  rows.sort((a, b) => {
    const an = a.organization_name.toLowerCase();
    const bn = b.organization_name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.organization_id < b.organization_id ? -1 : 1;
  });

  return { closed, generatedAt, rows };
}

export function applySummaryFilters(rows, { organizationId, balance }) {
  let out = rows;
  if (organizationId) out = out.filter((r) => r.organization_id === organizationId);
  if (balance === 'positive') out = out.filter((r) => r.closing_balance > 0.005);
  else if (balance === 'zero') out = out.filter((r) => Math.abs(r.closing_balance) <= 0.005);
  else if (balance === 'negative') out = out.filter((r) => r.closing_balance < -0.005);
  return out;
}

export function detailFiltersFromQuery(q = {}) {
  const s = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const d = (v) => {
    const val = s(v);
    return val && DATE_RE.test(val) ? val : null;
  };
  const vStatus = s(q.voucher_status);
  return {
    organizationId: s(q.organization_id),
    voucherStatus: ['active', 'expired', 'exhausted'].includes(vStatus) ? vStatus : null,
    allocationFrom: d(q.allocation_from),
    allocationTo: d(q.allocation_to),
    expiryFrom: d(q.expiry_from),
    expiryTo: d(q.expiry_to),
    eventId: s(q.event_id),
    type: s(q.type),
    fundingSource: s(q.funding_source),
  };
}

export async function getDetail(tenantId, month, filters) {
  const data = await loadReportData(tenantId);
  const all = buildDetailRows(data);
  const rows = sortDetailRows(filterDetailRows(all, { ...filters, month })).map((r) => ({
    ...r,
    organization_name: data.orgNameById[r.organization_id] || '',
  }));

  // Distinct filter option values, scoped to the reporting month (pre-filter)
  // so the UI can offer real choices.
  const monthRows = all.filter((r) => r.reporting_month === month);
  const options = {
    types: Array.from(new Set(monthRows.map((r) => r.type))).sort(),
    fundingSources: Array.from(new Set(monthRows.map((r) => r.funding_source).filter(Boolean))).sort(),
    events: Object.values(
      monthRows.reduce((acc, r) => {
        if (r.event_id && !acc[r.event_id]) {
          acc[r.event_id] = { id: r.event_id, title: r.event_title || r.event_id, date: r.event_date || null };
        }
        return acc;
      }, {})
    ).sort((a, b) => (a.title || '').localeCompare(b.title || '')),
  };

  return { rows, options };
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

  const month = req.query?.month;
  if (!isValidMonth(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (month > currentMonth) {
    return res.status(400).json({ error: 'month cannot be in the future' });
  }

  try {
    if (req.query?.view === 'detail') {
      const filters = detailFiltersFromQuery(req.query);
      const { rows, options } = await getDetail(tenantId, month, filters);
      return res.status(200).json({ month, rows, options, rowCount: rows.length });
    }

    const summary = await getSummary(tenantId, month);
    const rows = applySummaryFilters(summary.rows, {
      organizationId: typeof req.query?.organization_id === 'string' ? req.query.organization_id : null,
      balance: req.query?.balance,
    });
    return res.status(200).json({
      month,
      closed: summary.closed,
      snapshotGeneratedAt: summary.generatedAt,
      rows,
    });
  } catch (err) {
    console.error('[VoucherMonthlyReport] Error:', err);
    return res.status(500).json({ error: 'Monthly finance report failed', details: err.message });
  }
}
