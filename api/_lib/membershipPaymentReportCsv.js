import { CSV_BOM, CSV_ROW_SEPARATOR, escapeCsvCell } from './csvCell.js';
import { PAYMENT_REPORT_METHODS } from './membershipPaymentReport.js';

const humanise = value => value
  ? String(value).replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
  : 'Unknown';

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : 'Unknown';
}

// Build the complete response before setting attachment headers: failures must
// return an error, never a partially successful download.
export function membershipPaymentReportCsv(rows) {
  const cells = [
    ['Member', 'Email', 'Tier', 'Status', 'Payment method', 'Next payment', 'Schedule'],
    ...rows.map(row => [
      row.name || 'Unknown', row.email || 'Unknown', row.tier || 'Unknown',
      humanise(row.status),
      PAYMENT_REPORT_METHODS.find(method => method.value === row.paymentMethod)?.label || humanise(row.paymentMethod),
      formatDate(row.nextPaymentDate), humanise(row.scheduleState),
    ]),
  ];
  return CSV_BOM + cells.map(row => row.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR;
}