/**
 * A provider failure is an unknown outcome, never permission to release a term.
 * The database holds the election across requests while reconciliation runs.
 */
export class RenewalSwitchError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function rpc(db, name, args) {
  const result = await db.rpc(name, args);
  if (result.error) throw new RenewalSwitchError('renewal_reconciliation_required',
    'This renewal cannot be changed safely yet. Check its status or contact your membership administrator.');
  return result.data;
}

export async function beginRenewalProviderWork(db, reservation) {
  const electionId = reservation.quote?.simResult?.formRenewalElectionId;
  if (!electionId) return null;
  return rpc(db, 'begin_membership_successor_provider_work', {
    p_tenant_id: reservation.tenant_id, p_election_id: electionId,
  });
}

export async function finishRenewalProviderWork(db, reservation, token) {
  if (!token) return;
  await rpc(db, 'finish_membership_successor_provider_work', {
    p_tenant_id: reservation.tenant_id,
    p_election_id: reservation.quote.simResult.formRenewalElectionId, p_token: token,
  });
}

function verifyIntent(intent, quote, attemptId = null) {
  const metadata = intent?.metadata || {};
  if (!intent?.id || metadata.tenant_id !== quote.tenant_id
      || metadata.member_id !== quote.member_id
      || (metadata.organization_id || null) !== (quote.organization_id || null)
      || metadata.membership_quote_id !== quote.id
      || (metadata.membership_attempt_id || null) !== attemptId
      || intent.livemode !== (quote.quote.stripeEnvironment === 'live')) {
    throw new RenewalSwitchError('provider_identity_mismatch',
      'The saved checkout could not be verified. No new payment method has been enabled.');
  }
}

/**
 * stripeForQuote must select the saved environment, not today's feature mode.
 * Each cancellation is re-read. Only a terminal cancelled intent is evidence.
 */
export async function cancelRenewalIntents({ quote, attempts, stripeForQuote }) {
  if (!['test', 'live'].includes(quote.quote?.stripeEnvironment)) {
    throw new RenewalSwitchError('provider_outcome_unknown',
      'The original payment environment was not saved. Please contact your membership administrator.');
  }
  const stripe = await stripeForQuote(quote);
  if (quote.quote.stripeAccountId) {
    const account = await stripe.accounts.retrieve();
    if (account.id !== quote.quote.stripeAccountId) {
      throw new RenewalSwitchError('provider_account_changed',
        'The original payment account is not available. Please contact your membership administrator.');
    }
  }
  const identities = [
    { id: quote.stripe_payment_intent_id, attemptId: null },
    ...attempts.map(attempt => ({ id: attempt.provider_intent_id, attemptId: attempt.id })),
  ];
  if (identities.some(item => !item.id)) {
    throw new RenewalSwitchError('provider_outcome_unknown',
      'A checkout is still being prepared or has an unknown outcome. Please check its status before changing method.');
  }
  // Check all attempts before cancelling any. A late success on any attempt
  // must retain the whole election, even when another attempt is unpaid.
  const intents = await Promise.all(identities.map(async identity => {
    const intent = await stripe.paymentIntents.retrieve(identity.id);
    verifyIntent(intent, quote, identity.attemptId);
    if (!['canceled', 'requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) {
      throw new RenewalSwitchError('payment_committed',
        'This payment is processing, authorized, or paid. It cannot be replaced. Check renewal status or contact your membership administrator.');
    }
    return { ...identity, intent };
  }));
  const receipts = [];
  for (const { id, attemptId, intent } of intents) {
    if (intent.status !== 'canceled') {
      await stripe.paymentIntents.cancel(id, {}, { idempotencyKey: `renewal-switch:${quote.id}:${id}` });
    }
    const cancelled = await stripe.paymentIntents.retrieve(id);
    verifyIntent(cancelled, quote, attemptId);
    if (cancelled.status !== 'canceled') {
      throw new RenewalSwitchError('provider_outcome_unknown',
        'Cancellation has not been confirmed. Your renewal remains reserved; no replacement payment is available yet.');
    }
    receipts.push({ id, status: 'canceled', livemode: cancelled.livemode });
  }
  return receipts;
}

/** Retire a hosted setup, never an already-authorized mandate/subscription. */
export async function cancelRenewalSetup({ agreement, stripeForAgreement, gcForAgreement }) {
  if (agreement.status !== 'payment_setup_required'
      || agreement.gocardless_mandate_id || agreement.gocardless_subscription_id
      || agreement.stripe_subscription_id) {
    throw new RenewalSwitchError('payment_committed',
      'This payment arrangement is already authorized. Please contact your membership administrator to change it.');
  }
  if (agreement.provider === 'stripe') {
    if (!agreement.stripe_checkout_session_id || !['test', 'live'].includes(agreement.environment)) {
      throw new RenewalSwitchError('provider_outcome_unknown', 'The original card setup needs provider reconciliation.');
    }
    const stripe = await stripeForAgreement(agreement);
    const verify = session => {
      if (session?.id !== agreement.stripe_checkout_session_id
          || session.metadata?.tenant_id !== agreement.tenant_id
          || session.metadata?.member_id !== agreement.member_id
          || session.livemode !== (agreement.environment === 'live')) {
        throw new RenewalSwitchError('provider_identity_mismatch', 'The original card setup could not be verified.');
      }
      if (session.subscription || session.payment_intent
          || !['open', 'expired'].includes(session.status)) {
        throw new RenewalSwitchError('payment_committed',
          'This card setup has already completed or created a payment. Check renewal status before making another payment.');
      }
    };
    let session = await stripe.checkout.sessions.retrieve(agreement.stripe_checkout_session_id);
    verify(session);
    if (session.status !== 'expired') await stripe.checkout.sessions.expire(session.id);
    session = await stripe.checkout.sessions.retrieve(session.id);
    verify(session);
    if (session.status !== 'expired') throw new RenewalSwitchError('provider_outcome_unknown', 'Card setup cancellation has not been confirmed.');
    return { id: session.id, status: 'canceled', provider: 'stripe_checkout', environment: agreement.environment };
  }
  if (agreement.provider === 'gocardless') {
    if (!agreement.gocardless_billing_request_id || !['sandbox', 'live'].includes(agreement.environment)) {
      throw new RenewalSwitchError('provider_outcome_unknown', 'The original Direct Debit setup needs provider reconciliation.');
    }
    // The factory must refuse a changed environment or unavailable old account;
    // it must not silently choose today's tenant defaults.
    const gc = await gcForAgreement(agreement);
    const verify = request => {
      if (request?.id !== agreement.gocardless_billing_request_id
          || request.metadata?.tenant_id !== agreement.tenant_id
          || (agreement.organization_id
            ? request.metadata?.organization_id !== agreement.organization_id
            : request.metadata?.member_id !== agreement.member_id)) {
        throw new RenewalSwitchError('provider_identity_mismatch', 'The original Direct Debit setup could not be verified.');
      }
      if (request.links?.mandate_request_mandate || request.links?.payment_request_payment
          || !['pending', 'ready_to_fulfil', 'cancelled'].includes(request.status)) {
        throw new RenewalSwitchError('payment_committed',
          'This Direct Debit has already been authorized or cannot safely be cancelled. Please contact your membership administrator.');
      }
    };
    let request = await gc.getBillingRequest(agreement.gocardless_billing_request_id);
    verify(request);
    if (request.status !== 'cancelled') await gc.cancelBillingRequest(request.id);
    request = await gc.getBillingRequest(request.id);
    verify(request);
    if (request.status !== 'cancelled') throw new RenewalSwitchError('provider_outcome_unknown', 'Direct Debit cancellation has not been confirmed.');
    return { id: request.id, status: 'canceled', provider: 'gocardless', environment: agreement.environment };
  }
  throw new RenewalSwitchError('provider_outcome_unknown', 'This payment provider requires administrator reconciliation.');
}

export async function changeRenewalPaymentMethod({
  db, tenantId, memberId, organizationId = null, electionId, stripeForQuote,
  stripeForAgreement, gcForAgreement,
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(electionId || '')) {
    throw new RenewalSwitchError('renewal_changed', 'Refresh the renewal details before changing payment method.');
  }
  const scope = {
    p_tenant_id: tenantId, p_election_id: electionId,
    p_payer_member_id: memberId, p_organization_id: organizationId,
  };
  const snapshot = await rpc(db, 'begin_membership_successor_switch', scope);
  if (snapshot.released) return { released: true };
  let receipts = [];
  try {
    if (snapshot.quote) receipts = await cancelRenewalIntents({
      quote: snapshot.quote, attempts: snapshot.attempts, stripeForQuote,
    });
    for (const agreement of snapshot.agreements || []) {
      receipts.push(await cancelRenewalSetup({ agreement, stripeForAgreement, gcForAgreement }));
    }
  } catch (error) {
    // Keep the durable switch fence on transport failures or uncertain outcomes.
    // A retry adopts the exact same attempt list; it cannot create a new intent.
    if (error instanceof RenewalSwitchError && error.code === 'payment_committed') {
      await rpc(db, 'refuse_membership_successor_switch', scope);
    }
    if (error instanceof RenewalSwitchError) throw error;
    throw new RenewalSwitchError('provider_unavailable',
      'The payment provider could not confirm cancellation. Your renewal is still reserved. Retry Change payment method to check again.', 503);
  }
  const released = await rpc(db, 'finish_membership_successor_switch', { ...scope, p_receipts: receipts });
  if (released !== true) throw new RenewalSwitchError('renewal_reconciliation_required', 'The renewal is still reserved. Please check its status.');
  return { released: true };
}
