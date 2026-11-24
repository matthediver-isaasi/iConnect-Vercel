// Payment evidence is not membership entitlement. A warning must never revoke
// access, forgive debt, or authorise a new checkout.
export const MEMBERSHIP_PAYMENT_WARNINGS = Object.freeze({
  cancelled: 'Your Direct Debit arrangement has been cancelled. Further payments cannot be collected through it.',
  cancelled_after_grace: 'Your Direct Debit arrangement has been cancelled and the payment grace period has ended. Your membership payment needs attention.',
  failed: 'Your latest membership payment failed. Your membership payment needs attention.',
});

export function membershipPaymentWarning({ agreement, plan, now = new Date() } = {}) {
  const cancelled = ['cancelled', 'canceled', 'payment_plan_cancelled'];
  const stopped = cancelled.includes(agreement?.status) || cancelled.includes(plan?.status);
  const failed = plan?.last_payment_status === 'failed';
  const deadline = Date.parse(plan?.grace_expires_at || '');
  const at = new Date(now).getTime();
  if (stopped) {
    const code = failed && Number.isFinite(deadline) && Number.isFinite(at) && deadline <= at
      ? 'cancelled_after_grace' : 'cancelled';
    return { code, message: MEMBERSHIP_PAYMENT_WARNINGS[code] };
  }
  return failed ? { code: 'failed', message: MEMBERSHIP_PAYMENT_WARNINGS.failed } : null;
}
