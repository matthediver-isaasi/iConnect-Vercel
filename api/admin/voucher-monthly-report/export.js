// Task #3118 Phase 3: Monthly voucher finance report export.
//
//   GET ?month=YYYY-MM [+ the same filters as the report endpoint]
//     -> .xlsx workbook with two tabs:
//        "Summary"      — one row per organisation (snapshot-backed when the
//                         month is closed, live computed otherwise)
//        "Transactions" — the supporting detail rows
//     Both tabs are stamped with the generation date/time and whether the
//     figures came from a closed snapshot or a live computation.
//
// Cell values are neutralised against formula injection with the same
// convention as the shared CSV escaping (leading apostrophe on =, +, -, @,
// tab) — xlsx quoting is handled by the library itself.

import * as XLSX from 'xlsx';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { isValidMonth } from '../../_lib/voucherMonthlyRollup.js';
import {
  getSummary,
  applySummaryFilters,
  detailFiltersFromQuery,
  getDetail,
} from './index.js';

// Mirror escapeCsvCell's injection neutralisation (api/_lib/csvCell.js):
// flatten line breaks and prefix formula-leading characters with an
// apostrophe. Numbers pass through untouched so Excel can sum them.
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  let str = String(value).replace(/\r\n|[\r\n]/g, ' ');
  if (/^[=+\-@\t]/.test(str)) str = "'" + str;
  return str;
}

const SUMMARY_HEADERS = [
  'Organisation', 'Month', 'Opening Balance', 'Allocated', 'Used', 'Expired',
  'Adjustments (+)', 'Adjustments (-)', 'Reinstated', 'Closing Balance',
  'Reserved (Future Events)', 'Available Balance',
];

const DETAIL_HEADERS = [
  'Organisation', 'Reporting Month', 'Transaction Date', 'Type',
  'Voucher Reference', 'Voucher Status', 'Voucher Expiry', 'Allocation Date',
  'Funding Source', 'Event', 'Event Date', 'Booking Reference', 'Delegate',
  'Amount', 'Created By', 'Notes', 'Adjustment Reference',
];

function dateOnly(v) {
  return v ? String(v).slice(0, 10) : '';
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
    const summary = await getSummary(tenantId, month);
    const summaryRows = applySummaryFilters(summary.rows, {
      organizationId: typeof req.query?.organization_id === 'string' ? req.query.organization_id : null,
      balance: req.query?.balance,
    });
    const filters = detailFiltersFromQuery(req.query);
    const { rows: detailRows } = await getDetail(tenantId, month, filters);

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const sourceLabel = summary.closed
      ? `Closed month (snapshot${summary.generatedAt ? ` generated ${String(summary.generatedAt).replace('T', ' ').slice(0, 19)} UTC` : ''})`
      : 'Open month (live figures — not yet closed)';
    const stamp = [
      ['Voucher Monthly Finance Report'],
      [`Month: ${month}`],
      [`Source: ${sourceLabel}`],
      [`Generated: ${generatedAt}`],
      [],
    ];

    const summaryAoa = [
      ...stamp,
      SUMMARY_HEADERS,
      ...summaryRows.map((r) => [
        cell(r.organization_name),
        cell(month),
        r.opening_balance, r.allocated, r.used, r.expired,
        r.adjustments_positive, r.adjustments_negative, r.reinstated,
        r.closing_balance, r.reserved_future, r.available_balance,
      ]),
    ];

    const detailAoa = [
      ...stamp,
      DETAIL_HEADERS,
      ...detailRows.map((r) => [
        cell(r.organization_name),
        cell(r.reporting_month),
        cell(dateOnly(r.transaction_date)),
        cell(r.type),
        cell(r.voucher_code),
        cell(r.voucher_status),
        cell(dateOnly(r.voucher_expires_at)),
        cell(dateOnly(r.allocation_date)),
        cell(r.funding_source),
        cell(r.event_title),
        cell(dateOnly(r.event_date)),
        cell(r.booking_reference),
        cell(r.delegate),
        r.amount,
        cell(r.created_by),
        cell(r.notes),
        cell(r.adjustment_reference),
      ]),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryAoa), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailAoa), 'Transactions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `voucher_finance_report_${month}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Summary-Rows', String(summaryRows.length));
    res.setHeader('X-Export-Detail-Rows', String(detailRows.length));
    return res.status(200).send(buf);
  } catch (err) {
    console.error('[VoucherMonthlyReportExport] Error:', err);
    return res.status(500).json({ error: 'Monthly finance report export failed', details: err.message });
  }
}
