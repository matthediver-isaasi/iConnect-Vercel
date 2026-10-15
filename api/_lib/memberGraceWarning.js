import { paymentReportGrace } from './membershipPaymentReportGrace.js';

const DAY = 86400000;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export function annualGraceWarning(eligibility, today) {
  const end = dateOnly(eligibility?.paidThroughDate);
  const closes = dateOnly(eligibility?.graceEndDate);
  if (!end || !closes || !dateOnly(today) || today <= end) return null;
  return {
    expired: today > closes,
    days: Math.floor((Date.parse(today) - Date.parse(end)) / DAY),
    remainingDays: Math.max(0, Math.floor((Date.parse(closes) - Date.parse(today)) / DAY)),
    noGrace: today > closes && (eligibility.noGrace === true || closes === end),
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
  const paid = history.filter(row => row.membership_source === 'personal'
      && row.tenant_id === member.tenant_id && row.member_id === member.id
      && row.payment_status === 'paid' && ['active', 'paid', 'expired'].includes(row.status)
      && (!row.term_start_date || row.term_start_date <= today))
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
    const warning = recurringGraceWarning(result.data, agreement, new Date(now).getTime());
    if (!warning && ['payment_grace_period', 'payment_overdue', 'payment_plan_cancelled', 'expired', 'cancelled', 'canceled'].includes(result.data?.status)) {
      return { policyUnknown: true, reason: 'The recurring payment is overdue or cancelled, but its grace deadline is unavailable. Review the payment plan before taking action.' };
    }
    return warning;
  }
  if (record.term_end_date >= today) return null;
  let configs = [];
  if (!record.commitment_snapshot?.config && record.config_id) {
    const { data, error } = await db.from('membership_tier_config').select('*')
      .eq('tenant_id', member.tenant_id).eq('id', record.config_id).maybeSingle();
    if (error) throw error;
    if (data) configs = [data];
  }
  // Renewal checkout eligibility is not a warning policy: reservations must
  // block duplicate checkout without hiding an overdue, unpaid renewal.
  const result = await paymentReportGrace(db, {
    row: { historyId: record.id, memberId: member.id, currentExpiryDate: record.term_end_date },
    history: paid, configs, tenantId: member.tenant_id, today,
  });
  const warning = annualGraceWarning({
    paidThroughDate: record.term_end_date, graceEndDate: result.graceEndDate,
    noGrace: (record.commitment_snapshot?.config || configs[0])?.renewal_grace_days != null
      && Number((record.commitment_snapshot?.config || configs[0])?.renewal_grace_days) === 0
      && Date.parse(result.graceEndDate) - Date.parse(record.term_end_date) <= DAY,
  }, today);
  return warning || { policyUnknown: true,
    reason: 'The membership expiry or applied grace policy could not be established. Review the Membership tab before taking action.' };
}
