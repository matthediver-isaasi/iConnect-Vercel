import { cancelRenewalIntents, cancelRenewalSetup, RenewalSwitchError } from './renewalPaymentSwitch.js';

export async function initialRecoveryGeneration(db, tenantId, memberId) {
  const { data, error } = await db.from('form_initial_checkout_recovery').select('id')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('state', 'released')
    .order('released_at', { ascending: false }).limit(1);
  if (error) throw new Error('Payment recovery settings could not be verified. Please retry.');
  return data?.[0]?.id || null;
}

export async function findInitialCheckout(db, tenantId, memberId) {
  const { data: agreements, error } = await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).is('organization_id', null)
    .is('membership_successor_election_id', null).is('cancelled_for_switch_at', null)
    .eq('status', 'payment_setup_required');
  if (error) throw error;
  const { data: quotes, error: quoteError } = await db.from('membership_payment_quote').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).is('organization_id', null)
    .is('cancelled_for_switch_at', null);
  if (quoteError) throw quoteError;
  const personal = (quotes || []).filter(q => !q.quote?.simResult?.formRenewalElectionId);
  return { agreements: agreements || [], quotes: personal };
}

export async function recoverInitialCheckout({ db, tenantId, memberId, stripeForQuote, stripeForAgreement, gcForAgreement }) {
  const args = { p_tenant_id: tenantId, p_member_id: memberId };
  const begun = await db.rpc('begin_form_initial_checkout_recovery', args);
  if (begun.error) throw new RenewalSwitchError('initial_checkout_unresolved',
    'Your earlier checkout could not be safely released yet. Retry the check; do not start another payment.', 409);
  const snapshot = begun.data;
  const receipts = [];
  try {
    for (const quote of snapshot.quotes || []) receipts.push(...await cancelRenewalIntents({
      quote, attempts: [], stripeForQuote,
    }));
    for (const agreement of snapshot.agreements || []) receipts.push(await cancelRenewalSetup({
      agreement, stripeForAgreement, gcForAgreement,
    }));
  } catch (error) {
    if (error.code === 'payment_committed') {
      const refused = await db.rpc('finish_form_initial_checkout_recovery', {
        ...args, p_recovery_id: snapshot.recoveryId, p_receipts: [], p_refused: true,
      });
      if (refused.error) throw new RenewalSwitchError('initial_checkout_unresolved',
        'Payment authorisation was detected. Please retry checking status; do not pay again.', 409);
    }
    if (error instanceof RenewalSwitchError) throw error;
    throw new RenewalSwitchError('provider_unavailable',
      'We could not confirm cancellation with the payment provider. Your checkout is still protected. Please retry.', 503);
  }
  const finished = await db.rpc('finish_form_initial_checkout_recovery', {
    ...args, p_recovery_id: snapshot.recoveryId, p_receipts: receipts, p_refused: false,
  });
  if (finished.error || finished.data !== true) throw new RenewalSwitchError('initial_checkout_unresolved',
    'Cancellation has not finished updating. Please retry; no new payment has been started.', 409);
  return { released: true };
}
