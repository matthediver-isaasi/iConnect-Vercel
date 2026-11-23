import { createHash } from 'node:crypto';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';

const fail = (message, code, status = 409) => { throw new FunnelJourneyError(message, code, status); };
const paymentStates = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'succeeded', 'canceled']);
const hash = value => createHash('sha256').update(value).digest('hex');

/**
 * An aggregate intent is never a single event's intent with extra bookings
 * appended later. Every provider call uses the durable order's original request.
 * The store and provider adapters are mandatory; no legacy endpoint fallback.
 */
export function validateFunnelPaymentEvidence(order, intent) {
  const expected = order.payment_request;
  if (!expected || !intent || intent.id !== order.payment_intent_id
    || !paymentStates.has(intent.status) || intent.amount !== order.payable_minor
    || String(intent.currency).toUpperCase() !== order.currency
    || intent.metadata?.event_funnel_order_id !== order.id
    || intent.metadata?.event_funnel_session_id !== order.session_id
    || intent.metadata?.tenant_id !== order.tenant_id
    || intent.livemode !== (order.snapshot.paymentAuthority?.mode === 'live')) {
    fail('The original payment could not be verified. Do not pay again.', 'PAYMENT_AUTHORITY_MISMATCH');
  }
  if (intent.status === 'succeeded' && intent.amount_received !== order.payable_minor) {
    fail('The received payment does not match this order. Do not pay again.', 'PAYMENT_AMOUNT_MISMATCH');
  }
  // Registration success depends on the verified PI, not accounting metadata.
  // Missing/ambiguous charge dates must hold invoice delivery for review rather
  // than erase a paid registration. Never substitute PI creation for paid time.
  const charge=intent.latest_charge;
  const captured= intent.status==='succeeded' && intent.capture_method==='automatic'
    && charge && typeof charge==='object' && /^ch_[A-Za-z0-9]+$/.test(charge.id || '')
    && charge.payment_intent===intent.id && charge.status==='succeeded'
    && charge.livemode===intent.livemode && charge.paid===true && charge.captured===true
    && charge.refunded===false && charge.amount_refunded===0
    && charge.amount_captured===order.payable_minor && charge.amount===order.payable_minor
    && String(charge.currency).toUpperCase()===order.currency
    && Number.isSafeInteger(charge.created) && charge.created>0
    && Number.isFinite(new Date(charge.created*1000).getTime());
  return {
    id: intent.id, status: intent.status, amount: intent.amount, amountReceived: intent.amount_received || 0,
    currency: String(intent.currency).toUpperCase(), livemode: intent.livemode,
    ...(captured ? {capturedCharge:{id:charge.id,paidAt:new Date(charge.created*1000).toISOString(),
      amountMinor:charge.amount_captured,currency:order.currency,livemode:charge.livemode}} : {}),
  };
}

export function funnelPaymentRequest(order) {
  if (!Number.isSafeInteger(order.payable_minor) || order.payable_minor <= 0
    || !/^[A-Z]{3}$/.test(order.currency || '') || order.payment_method !== 'card'
    || !order.snapshot?.paymentAuthority?.accountFingerprint
    || !['live', 'test'].includes(order.snapshot.paymentAuthority.mode)) {
    fail('Original card payment terms are unavailable.', 'INVALID_PAYMENT_AUTHORITY', 503);
  }
  return {
    amount: order.payable_minor, currency: order.currency.toLowerCase(),
    payment_method_types: ['card'],
    ...(order.snapshot.purchaser?.email ? { receipt_email: order.snapshot.purchaser.email } : {}),
    metadata: {
      tenant_id: order.tenant_id, event_funnel_order_id: order.id,
      event_funnel_session_id: order.session_id, feature: 'events',
    },
  };
}

export function createFunnelPaymentService({ store, providerFor, now = () => Date.now() }) {
  if (!store || typeof providerFor !== 'function') throw new Error('Durable order and payment adapters are required');
  const replayWindow = 23 * 60 * 60 * 1000;
  async function originalProvider(order) {
    const provider = await providerFor(order.snapshot.paymentAuthority);
    if (!provider || provider.identity?.accountFingerprint !== order.snapshot.paymentAuthority.accountFingerprint
      || provider.identity?.mode !== order.snapshot.paymentAuthority.mode) {
      fail('The original payment account is unavailable. Do not start another payment.', 'PAYMENT_ACCOUNT_UNAVAILABLE', 503);
    }
    return provider;
  }
  async function retrieve(order) {
    const provider = await originalProvider(order);
    const intent = await provider.retrieve(order.payment_intent_id);
    return { provider, intent, evidence: validateFunnelPaymentEvidence(order, intent) };
  }
  return {
    async ensurePayment(order) {
      if (order.payment_method !== 'card') fail('This order does not use a card payment.', 'INVALID_PAYMENT_METHOD');
      if (order.state === 'confirmed' || order.verified_payment) {
        return {orderId:order.id,state:order.state === 'confirmed' ? 'confirmed' : 'succeeded'};
      }
      if (order.state === 'confirmed') return { state: 'confirmed', orderId: order.id };
      if (['cancelled', 'failed'].includes(order.state)) fail('This payment attempt has ended.', 'PAYMENT_ENDED');
      if (!order.payment_request && !order.payment_intent_id
        && (!Number.isFinite(Date.parse(order.snapshot.reservationExpiresAt)) || Date.parse(order.snapshot.reservationExpiresAt) <= now())) {
        fail('The reservation expired before payment started. Re-reserve before paying.', 'PAYMENT_TIMER_EXPIRED');
      }
      const provider = await originalProvider(order);
      if (order.payment_intent_id) {
        const intent = await provider.retrieve(order.payment_intent_id);
        const evidence = validateFunnelPaymentEvidence(order, intent);
        return { orderId: order.id, state: evidence.status, clientSecret: intent.client_secret, publishableKey: provider.publishableKey };
      }
      const parameters = order.payment_request || funnelPaymentRequest(order);
      if (!order.payment_request && provider.canCreate === false) {
        fail('Card payments are unavailable. No payment has been started.', 'PAYMENT_ACCOUNT_UNAVAILABLE', 503);
      }
      // This write pins stock and financial authority BEFORE any network write.
      const prepared = await store.preparePayment(order.id, parameters);
      if (prepared.payment_intent_id) return this.ensurePayment(prepared);
      if (!prepared.payment_requested_at || !Number.isFinite(Date.parse(prepared.payment_requested_at))
        || now() - Date.parse(prepared.payment_requested_at) >= replayWindow) {
        await store.markUncertain(order.id, 'original_create_window_elapsed');
        fail('The original payment needs reconciliation. Do not pay again.', 'PAYMENT_RECONCILIATION_REQUIRED');
      }
      let intent;
      try {
        intent = await provider.create(prepared.payment_request, {
          idempotencyKey: `event-funnel:${hash(`${order.tenant_id}:${order.id}`).slice(0, 48)}`,
        });
      } catch {
        // Network errors, timeouts and even a provider-side 4xx are not
        // authoritative evidence that an earlier identical request never ran.
        await store.markUncertain(order.id, 'provider_create_unconfirmed');
        fail('Payment status is being checked. Do not start another payment.', 'PAYMENT_UNCERTAIN', 503);
      }
      const bound = await store.bindPayment(order.id, intent.id);
      const evidence = validateFunnelPaymentEvidence(bound, intent);
      return { orderId: order.id, state: evidence.status, clientSecret: intent.client_secret, publishableKey: provider.publishableKey };
    },
    async reconcile(order) {
      if (order.state === 'confirmed') return { state: 'confirmed', orderId: order.id };
      if (['cancelled', 'failed'].includes(order.state)) return { state: order.state, orderId: order.id };
      if (order.payment_method !== 'card') {
        if (!order.snapshot?.submissionAccepted) fail('Checkout has not been submitted.', 'SUBMISSION_REQUIRED');
        return store.finalize(order.id, { method: order.payment_method });
      }
      if (order.verified_payment) {
        // The private immutable receipt survives a registration transaction
        // failure. Provider availability must not block replaying that commit.
        return store.finalize(order.id, { method:'card',payment:order.verified_payment });
      }
      if (!order.payment_request && !order.payment_intent_id
        && Number.isFinite(Date.parse(order.snapshot.reservationExpiresAt))
        && Date.parse(order.snapshot.reservationExpiresAt) <= now()) {
        return store.release(order.id, { outcome: 'not_started' });
      }
      if (!order.payment_intent_id) {
        await this.ensurePayment(order);
        order = await store.read(order.id);
      }
      let verified;
      try { verified = await retrieve(order); }
      catch (error) {
        await store.markUncertain(order.id, 'provider_read_unconfirmed');
        throw error;
      }
      if (verified.evidence.status === 'succeeded') {
        // Any storage failure here retains the original paid order and pinned
        // inventory. Retrying finalization must never create another intent.
        await store.recordPayment(order.id, verified.evidence);
        return store.finalize(order.id, { method: 'card', payment: verified.evidence });
      }
      if (verified.evidence.status === 'canceled') {
        return store.release(order.id, { paymentIntentId: order.payment_intent_id, outcome: 'cancelled' });
      }
      return { orderId: order.id, state: verified.evidence.status };
    },
    async cancel(order) {
      if (order.state === 'confirmed') fail('Confirmed registrations use the cancellation process.', 'ALREADY_CONFIRMED');
      if (order.verified_payment) return this.reconcile(order);
      if (order.payment_method !== 'card') {
        if (order.snapshot?.submissionAccepted) return this.reconcile(order);
        return store.release(order.id, { outcome: 'not_started' });
      }
      if (!order.payment_intent_id) {
        if (order.payment_requested_at) {
          await store.markUncertain(order.id, 'cancel_requires_original_create');
          fail('The original payment must be reconciled before releasing the reservation.', 'PAYMENT_UNCERTAIN');
        }
        return store.release(order.id, { outcome: 'not_started' });
      }
      const verified = await retrieve(order);
      if (verified.evidence.status === 'succeeded') {
        await store.recordPayment(order.id, verified.evidence);
        return store.finalize(order.id, { method: 'card', payment: verified.evidence });
      }
      if (verified.evidence.status !== 'canceled') {
        try {
          await verified.provider.cancel(order.payment_intent_id, {
            idempotencyKey: `event-funnel-cancel:${hash(order.id).slice(0, 48)}`,
          });
        } catch {
          await store.markUncertain(order.id, 'provider_cancel_unconfirmed');
          fail('Cancellation status is being checked; your places remain reserved.', 'PAYMENT_UNCERTAIN', 503);
        }
      }
      // A successful cancel HTTP response is not enough: retrieve the original
      // intent again, including the possible success-vs-cancel race.
      return this.reconcile(await store.read(order.id));
    },
  };
}
