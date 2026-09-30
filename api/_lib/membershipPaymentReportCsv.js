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
export function membershipPaymentReportCsv(rows, method = 'all') {
  if (method === 'upfront') {
    const cells = [
      ['Member', 'Email', 'Tier', 'Status', 'Payment method', 'Membership renewal', 'Next structure', 'Next renewal amount (projected, incl. VAT)', 'Currency'],
      ...rows.map(row => [
        row.name || 'Unknown', row.email || 'Unknown', row.tier || 'Unknown',
        humanise(row.status),
        PAYMENT_REPORT_METHODS.find(option => option.value === row.paymentMethod)?.label || humanise(row.paymentMethod),
        row.renewalDate ? formatDate(row.renewalDate) : row.renewalLabel || 'Renewal date missing',
        row.nextStructureState?.startsWith('Review required')
          ? row.nextStructureState : row.nextStructureName || 'Review required — no uniquely named applicable structure',
        Number.isFinite(row.nextRenewalAmount) ? row.nextRenewalAmount.toFixed(2) : row.nextRenewalAmountState || 'Review required',
        row.nextRenewalCurrency || '',
      ]),
    ];
    return CSV_BOM + cells.map(row => row.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR;
  }
  const dd = ['all', 'direct_debit', 'monthly_direct_debit'].includes(method);
  const ddOnly = ['direct_debit', 'monthly_direct_debit'].includes(method);
  const cells = [
    ['Member', 'Email', 'Tier', 'Status', 'Payment method', 'Next payment', 'Schedule',
      ...(!ddOnly ? ['Current expiry', 'Renewal date', 'Renewal basis'] : []),
      'Payment arrangement', ddOnly ? 'Collection structure' : 'Next structure', 'Structure review',
      ...(dd ? ['Next payment amount', 'Currency', 'Payment amount basis'] : [])],
    ...rows.map(row => [
      row.name || 'Unknown', row.email || 'Unknown', row.tier || 'Unknown',
      row.statusLabel || humanise(row.status),
      PAYMENT_REPORT_METHODS.find(method => method.value === row.paymentMethod)?.label || humanise(row.paymentMethod),
      formatDate(row.nextPaymentDate), humanise(row.scheduleState),
      ...(!ddOnly ? [row.renewalLabel ? formatDate(row.currentExpiryDate) : '',
        row.renewalLabel ? formatDate(row.renewalDate) : '', row.renewalLabel || ''] : []),
      row.paymentArrangement || '', row.nextStructureName || '', row.nextStructureState || '',
      ...(dd ? [Number.isFinite(row.nextPaymentAmount) ? row.nextPaymentAmount.toFixed(2) : '',
        row.nextPaymentCurrency || '', row.nextPaymentAmountState || ''] : []),
    ]),
  ];
  return CSV_BOM + cells.map(row => row.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR;
}