import { loadCanvasRenewalEligibility } from './canvasRenewalEligibility.js';

const DAY = 86400000;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export function annualGraceWarning(eligibility, today) {
  const end = dateOnly(eligibility?.paidThroughDate);
  const closes = dateOnly(eligibility?.graceEndDate);
  if (!end || !closes || !dateOnly(today) || today <= end) return null;
  return {
    expired: today > closes,
    days: Math.floor((Date.parse(today) - Date.parse(end)) / DAY),
    endsOn: closes,
    reason: 'Upfront membership has not yet been renewed.',
  };
}

export function recurringGraceWarning(plan, agreement, now) {
  if (!['payment_grace_period', 'payment_overdue', 'payment_plan_cancelled', 'expired', 'cancelled', 'canceled'].includes(plan?.status)) return null;
  const expiry = Date.parse(plan.grace_expires_at);
  if (!Number.isFinite(expiry)) return null;
  const dd = agreement.provider === 'gocardless';
  const cancelled = ['payment_plan_cancelled', 'cancelled', 'canceled'].includes(plan.status)
    || ['cancelled', 'canceled'].includes(agreement.status);
  // Mirror the collection engine's snapshotted DD policy, including its
  // legacy default and cap. Never use today's tier settings.
  const rawDays = Number(agreement.metadata?.[dd ? 'dd' : 'card']?.grace_days);
  const duration = (Number.isFinite(rawDays) && rawDays >= 0
    ? Math.min(Math.floor(rawDays), 90) : 7) + (Number(plan.grace_extended_days) || 0);
  return {
    expired: now >= expiry,
    days: duration == null ? null : Math.max(0, Math.floor((now - (expiry - duration * DAY)) / DAY)),
    endsOn: new Date(expiry).toISOString().slice(0, 10),
    reason: cancelled
      ? `${dd ? 'Direct Debit' : 'Recurring card payment'} has been cancelled; membership payment remains outstanding.`
      : plan.failed_provider_reference
        ? `${dd ? 'Direct Debit' : 'Recurring card'} payment failed and remains outstanding.`
        : `${dd ? 'Direct Debit' : 'Recurring card'} payment remains outstanding. The payment plan is recorded as ${plan.status === 'payment_overdue' ? 'overdue' : 'in payment grace'}.`,
  };
}

export async function loadMemberGraceWarning(db, { member, history, paused, now }) {
  if (paused) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  // Only personal paid terms establish renewal authority. A newer paid term
  // supersedes an older expired term; pending attempts are not renewals.
  const paid = history.filter(row => row.status === 'paid')
    .sort((a, b) => String(b.term_end_date || '').localeCompare(String(a.term_end_date || '')));
  const record = paid[0];
  if (!record) return null;
  if (record.billing_agreement_id) {
    const { data: agreement, error } = await db.from('membership_billing_agreements').select('*')
      .eq('tenant_id', member.tenant_id).eq('member_id', member.id)
      .eq('id', record.billing_agreement_id).maybeSingle();
    if (error) throw error;
    if (!agreement || agreement.organization_id || !['gocardless', 'stripe'].includes(agreement.provider)) return null;
    const result = await db.from('membership_payment_plans').select('*')
      .eq('tenant_id', member.tenant_id).eq('billing_agreement_id', agreement.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw result.error;
    return recurringGraceWarning(result.data, agreement, new Date(now).getTime());
  }
  if (!record.term_end_date || record.term_end_date >= today) return null;
  const eligibility = await loadCanvasRenewalEligibility(db, {
    selected: { record }, owner: member, history: paid, today,
  });
  if (eligibility.reason === 'eligibility_evidence_unavailable') throw new Error('Renewal evidence unavailable');
  return annualGraceWarning(eligibility, today);
}
