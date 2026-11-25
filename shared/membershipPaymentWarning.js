
// Payment evidence is not membership entitlement. A warning must never revoke
// access, forgive debt, or authorise a new checkout. Cancellation copy names
// the provider arrangement that actually stopped (GoCardless Direct Debit vs
// Stripe monthly card plan) and only says further collection through it has
// stopped; it never implies anything already owed was cleared.
export const MEMBERSHIP_PAYMENT_WARNINGS = Object.freeze({
  cancelled: 'Your Direct Debit arrangement has been cancelled. Further payments cannot be collected through it.',
  cancelled_after_grace: 'Your Direct Debit arrangement has been cancelled and the payment grace period has ended. Your membership payment needs attention.',
  card_plan_cancelled: 'Your monthly card payment plan has been cancelled. Further payments cannot be taken from your card through it.',
  card_plan_cancelled_after_grace: 'Your monthly card payment plan has been cancelled and the payment grace period has ended. Your membership payment needs attention.',
  failed: 'Your latest membership payment failed. Your membership payment needs attention.',
});

export function membershipPaymentWarning({ agreement, plan, now = new Date() } = {}) {
  const cancelled = ['cancelled', 'canceled', 'payment_plan_cancelled'];
  const stopped = cancelled.includes(agreement?.status) || cancelled.includes(plan?.status);
  const failed = plan?.last_payment_status === 'failed';
  const deadline = Date.parse(plan?.grace_expires_at || '');
  const at = new Date(now).getTime();
  if (stopped) {
    // A Stripe card agreement keeps its own status when Stripe ends the
    // subscription, so the plan's provider is the primary evidence.
    const card = (plan?.provider || agreement?.provider) === 'stripe';
    const afterGrace = failed && Number.isFinite(deadline) && Number.isFinite(at) && deadline <= at;
    const code = card
      ? (afterGrace ? 'card_plan_cancelled_after_grace' : 'card_plan_cancelled')
      : (afterGrace ? 'cancelled_after_grace' : 'cancelled');
    return { code, message: MEMBERSHIP_PAYMENT_WARNINGS[code] };
  }
  return failed ? { code: 'failed', message: MEMBERSHIP_PAYMENT_WARNINGS.failed } : null;
}
