const DAY = 86400000;
export const PAYMENT_REPORT_EXPIRY_FILTERS = ['all', 'not_expired', 'expired_within_90', 'expired_over_90', 'unknown'];

function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

// Date-based reporting only: never infer grace entitlement or payment authority.
export function paymentReportExpiry(row, today) {
  const end = dateMs(row.currentExpiryDate);
  const now = dateMs(today);
  if (now === null) throw new Error('Invalid report date');
  if (end === null) return { expiryCategory: 'unknown', daysPastExpiry: null };
  const days = Math.max(0, Math.floor((now - end) / DAY));
  return {
    expiryCategory: days > 90 ? 'expired_over_90' : days > 0 ? 'expired_within_90' : 'not_expired',
    daysPastExpiry: days,
  };
}
