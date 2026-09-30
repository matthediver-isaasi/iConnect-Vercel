import { supabase } from '../../_lib/database.js';
import { authorizeCommunicationPreferencesAdmin } from '../../_lib/adminCommunicationPreferences.js';
import { loadAllCommunicationStatusRows } from '../../_lib/memberCommunicationStatusReport.js';
import { CSV_BOM, CSV_ROW_SEPARATOR, escapeCsvCell } from '../../_lib/csvCell.js';

function statusText(status) {
  if (status.available) return status.optedIn ? 'Opted in' : 'Not opted in';
  const reason = {
    inactive: 'inactive category',
    public_only: 'public-only category',
    role_ineligible: 'not eligible for member role',
  }[status.unavailableReason] || 'unavailable';
  return `${status.optedIn ? 'Opted in' : 'Not opted in'} — unavailable (${reason})`;
}

export function buildCommunicationStatusCsv(categories, rows) {
  const categoryHeaders = categories.map((category) => {
    const annotations = [
      category.active === false ? 'inactive' : '',
      category.publicOnly === true ? 'public only' : '',
    ].filter(Boolean);
    return `${category.name || 'Unnamed category'} [${category.id}]${
      annotations.length ? ` (${annotations.join(', ')})` : ''
    }`;
  });
  const headers = [
    'member_id', 'first_name', 'last_name', 'email', 'organisation',
    ...categoryHeaders, 'global_opt_out',
  ];
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.memberId,
      row.firstName,
      row.lastName,
      row.email,
      row.organizationName,
      ...categories.map((category) => statusText(row.categoryStatuses[category.id])),
      row.globalOptOut ? 'Yes' : 'No',
    ].map(escapeCsvCell).join(','));
  }
  return CSV_BOM + lines.join(CSV_ROW_SEPARATOR);
}

export async function handleCommunicationStatusReportExport(req, res, dependencies = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const database = dependencies.database || supabase;
  if (!database) return res.status(503).json({ error: 'Database not configured' });
  const authorization = await authorizeCommunicationPreferencesAdmin(req, dependencies);
  if (authorization.error) {
    return res.status(authorization.status).json({ error: authorization.error });
  }
  try {
    // Fully prepare and verify the file before sending headers: failures can
    // never appear to the browser as a successful truncated CSV.
    const loadRows = dependencies.loadAllCommunicationStatusRows
      || loadAllCommunicationStatusRows;
    const report = await loadRows(database, {
      tenantId: authorization.context.tenantId,
      query: req.body?.filters || {},
    });
    const expectedCount = Number(req.body?.expectedCount);
    if (
      Number.isInteger(expectedCount)
      && expectedCount >= 0
      && expectedCount !== report.rows.length
    ) {
      return res.status(409).json({
        error: `Export found ${report.rows.length} members, but the report contains ${expectedCount}. Refresh the report and try again.`,
        expectedCount,
        actualCount: report.rows.length,
      });
    }
    const csv = buildCommunicationStatusCsv(report.categories, report.rows);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="member_communication_status_${date}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Row-Count', String(report.rows.length));
    return res.status(200).send(csv);
  } catch (error) {
    console.error('[Communication Status Report Export] Error:', error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Failed to export communication status report',
    });
  }
}

export default function handler(req, res) {
  return handleCommunicationStatusReportExport(req, res);
}