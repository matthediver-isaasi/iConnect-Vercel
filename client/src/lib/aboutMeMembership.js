import { formatMembershipDate } from './canvasMembershipData.js';

// Only confirmed personal, current-term evidence belongs in My Information.
// Term dates are calendar dates, inclusive of the final day (as in Canvas).
export function currentPersonalMembershipExpiry(summary, now = new Date()) {
  if (summary?.status !== 'ready' || summary.isSample) return null;
  const membership = summary.data?.membership;
  if (membership?.source !== 'personal'
    || !['active', 'paused'].includes(membership.state)
    || membership.grace?.inGrace) return null;

  const termEnd = membership.termEndDate || membership.expiryDate;
  const expiry = formatMembershipDate(termEnd);
  if (!expiry || !Number.isFinite(now.getTime())) return null;
  const today = now.toISOString().slice(0, 10);
  if (termEnd.slice(0, 10) < today) return null;
  if (membership.termStartDate && (!formatMembershipDate(membership.termStartDate)
    || membership.termStartDate.slice(0, 10) > today)) return null;
  return expiry;
}
