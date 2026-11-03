import { historyFromFormPaymentSnapshot } from './formMembershipPaymentQuote.js';
import { finalizePostGraceRecordDates } from './postGraceFinalization.js';

export async function ensurePostGraceUpfrontHistory(db, { reservation, paymentIntent, tenantId, memberId }) {
  const sim = reservation.quote?.simResult;
  if (reservation.tenant_id !== tenantId || reservation.member_id !== memberId
      || reservation.organization_id || sim?.formRenewal?.state !== 'post_grace_renewal'
      || !sim.formRenewalElectionId
      || paymentIntent.metadata?.post_grace_election_id !== sim.formRenewalElectionId
      || paymentIntent.metadata?.tenant_id !== tenantId || paymentIntent.metadata?.member_id !== memberId) {
    throw new Error('Restart checkout identity could not be verified');
  }
  const read = () => db.from('member_membership_history').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId)
    .eq('membership_payment_quote_id', reservation.id).maybeSingle();
  let { data: history, error } = await read();
  if (error) throw new Error('Pending restart membership could not be read');
  if (!history) {
    const fields = historyFromFormPaymentSnapshot({ ...reservation.quote, quoteId: reservation.id });
    const result = await db.from('member_membership_history').insert({
      ...fields, tenant_id: tenantId, member_id: memberId, previous_term_id: null,
      stripe_payment_intent_id: paymentIntent.id, payment_method: 'stripe',
      status: 'pending_payment_setup', payment_status: 'unpaid',
    }).select('*').maybeSingle();
    if (result.error?.code === '23505') {
      ({ data: history, error } = await read());
      if (error) throw new Error('Concurrent restart membership could not be verified');
    } else {
      if (result.error) throw new Error(`Pending restart membership could not be saved: ${result.error.message}`);
      history = result.data;
    }
  }
  if (!history || history.stripe_payment_intent_id !== paymentIntent.id
      || history.membership_successor_election_id !== sim.formRenewalElectionId) {
    throw new Error('Another payment owns the pending restart membership');
  }
  return history;
}

/** Use Stripe's succeeded event time, never PI/charge creation or webhook receipt. */
export async function stripeSuccessfulPaymentTime(stripe, paymentIntent) {
  if (paymentIntent?.status !== 'succeeded' || !paymentIntent.id
      || !Number.isSafeInteger(paymentIntent.created)) throw new Error('Successful Stripe payment is required');
  let cursor;
  for (let page = 0; page < 20; page++) {
    const events = await stripe.events.list({
      type: 'payment_intent.succeeded', created: { gte: paymentIntent.created }, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    if (!Array.isArray(events.data)) throw new Error('Stripe success evidence is unavailable');
    const matching = events.data.find(event => event.type === 'payment_intent.succeeded'
      && event.data?.object?.id === paymentIntent.id && event.data.object.status === 'succeeded');
    if (matching) {
      if (!Number.isSafeInteger(matching.created)) throw new Error('Stripe success time is invalid');
      return new Date(matching.created * 1000).toISOString();
    }
    if (!events.has_more) break;
    const next = events.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error('Stripe success evidence pagination did not advance');
    cursor = next;
  }
  throw new Error('Payment succeeded; its authoritative success time is not available yet. Do not pay again.');
}

export async function finalizePostGraceStripePayment(db, { tenantId, paymentIntent, stripe }) {
  const electionId = paymentIntent?.metadata?.post_grace_election_id;
  if (!electionId) return { applicable: false };
  const memberId = paymentIntent.metadata.member_id;
  if (paymentIntent.status !== 'succeeded' || paymentIntent.metadata.tenant_id !== tenantId
      || !memberId || paymentIntent.metadata.organization_id
      || paymentIntent.amount_received !== paymentIntent.amount) {
    throw new Error('Restart payment identity or settlement is invalid');
  }
  const { data: reservation, error } = await db.from('membership_post_grace_renewal').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('election_id', electionId).maybeSingle();
  if (error || !reservation) throw new Error('Restart reservation could not be verified');
  if (reservation.payment_method !== 'upfront') throw new Error('PaymentIntent does not own an upfront restart');
  const paidAt = reservation.status === 'settled' && reservation.payment_id === paymentIntent.id
    ? reservation.paid_at : await stripeSuccessfulPaymentTime(stripe, paymentIntent);
  const result = await finalizePostGraceRecordDates(db, {
    tenantId, memberId, electionId,
    evidence: { tenantId, memberId, reservationId: reservation.id,
      provider: 'stripe', id: paymentIntent.id, status: 'succeeded', paidAt,
      amountMinor: paymentIntent.amount_received, currency: paymentIntent.currency.toUpperCase() },
  });
  return { ...result, paidAt };
}
