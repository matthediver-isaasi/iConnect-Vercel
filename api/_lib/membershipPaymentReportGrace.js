import { resolveAnnualRenewal } from './annualRenewalPolicy.js';
import { loadExpiryOnlyRenewalPolicy } from './expiryOnlyRenewalPolicy.js';

export function paymentReportCountdown(row, today, graceEndDate = null) {
  const days = row.currentExpiryDate
    ? Math.round((Date.parse(row.currentExpiryDate) - Date.parse(today)) / 86400000) : null;
  const remaining = graceEndDate ? Math.round((Date.parse(graceEndDate) - Date.parse(today)) / 86400000) : null;
  return {
    expiryTiming: days == null ? 'Expiry unknown' : days >= 0 ? `${days} days until expiry`
      : remaining == null ? `${-days} days past expiry — grace policy unknown`
      : remaining >= 0 ? `${remaining} grace days remaining` : `Grace exceeded by ${-remaining} days`,
    expiryTone: days < 0 && remaining != null ? remaining >= 0 ? 'grace' : 'expired' : null,
  };
}

export async function paymentReportGrace(db, { row, history, configs, tenantId, today }) {
  if (!row.currentExpiryDate || row.currentExpiryDate >= today) {
    return { ...row, ...paymentReportCountdown(row, today) };
  }
  const record = history.find(h => h.id === row.historyId && h.member_id === row.memberId && h.tenant_id === tenantId);
  let graceEndDate = null;
  if (record && !record.billing_agreement_id && ['upfront', 'manual', 'card', 'stripe', 'invoice', 'bank_transfer'].includes(record.payment_method)) {
    const assigned = await loadExpiryOnlyRenewalPolicy(db, { tenantId, history: record });
    if (assigned) graceEndDate = assigned.graceEndDate;
    else {
      const config = record.commitment_snapshot?.config || configs.find(c => c.id === record.config_id && c.tenant_id === tenantId);
      // No fallback to today's matching schedule or to a default grace duration.
      const duration = config?.renewal_grace_days;
      if (duration != null && duration !== '' && Number.isInteger(Number(duration))
        && Number(duration) >= 0 && Number(duration) <= 366) {
        const result = await resolveAnnualRenewal(db, { tenantId, history: record, config, now: new Date(`${today}T00:00:00Z`) });
        if (result.applicable && result.graceCutoff) graceEndDate = result.graceCutoff.toISOString().slice(0, 10);
      }
    }
  }
  return { ...row, graceEndDate, ...paymentReportCountdown(row, today, graceEndDate) };
}
