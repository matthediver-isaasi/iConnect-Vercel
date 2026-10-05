import Stripe from 'stripe';
import { getStripeCredentials } from './stripeCredentials.js';
import { recoverPublicTicketMembers, assertPublicTicketPaymentEvidence } from './publicTicketMemberPurchase.js';

export async function compensatePublicTicketCapacity(db, purchase, stripeClient) {
  if (!purchase.stripe_payment_intent_id) return { state: 'excluded', refunded: false };
  try {
    const { error: attemptError } = await db.from('public_ticket_member_purchase').update({
      updated_at: new Date().toISOString(),
    }).eq('id', purchase.id).eq('tenant_id', purchase.tenant_id)
      .eq('last_error_code', 'capacity_refund_pending');
    if (attemptError) throw attemptError;
    const client = stripeClient || new Stripe(
      (await getStripeCredentials(purchase.tenant_id, 'events'))?.secret_key,
      { timeout: 5000, maxNetworkRetries: 1 },
    );
    const intent = await client.paymentIntents.retrieve(purchase.stripe_payment_intent_id, { expand: ['latest_charge'] });
    assertPublicTicketPaymentEvidence({
      ...intent, latest_charge: { ...intent.latest_charge, refunded: false, amount_refunded: 0 },
    }, purchase, purchase.tenant_id, purchase.event_id);
    const refund = intent.latest_charge.refunded ? { status: 'succeeded' }
      : await client.refunds.create({ payment_intent: intent.id, reason: 'requested_by_customer' },
        { idempotencyKey: `public-ticket-capacity:${purchase.id}` });
    const refunded = refund.status === 'succeeded';
    const { error } = await db.from('public_ticket_member_purchase').update({
      state: refunded ? 'excluded' : 'retryable',
      last_error_code: refunded ? 'capacity_refunded' : 'capacity_refund_pending',
      updated_at: new Date().toISOString(),
    }).eq('id', purchase.id).eq('tenant_id', purchase.tenant_id)
      .eq('last_error_code', 'capacity_refund_pending');
    if (error) throw error;
    return { state: refunded ? 'excluded' : 'retryable', refunded };
  } catch {
    return { state: 'retryable', refunded: false };
  }
}

export async function loadPublicTicketPayment(tenantId, paymentIntentId) {
  const credentials = await getStripeCredentials(tenantId, 'events');
  if (!credentials?.secret_key) throw new Error('Payment verification unavailable');
  return new Stripe(credentials.secret_key, { timeout: 5000, maxNetworkRetries: 1 })
    .paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
}

export async function recoverPublicTicketPurchase(db, purchase, loadPaymentIntent = loadPublicTicketPayment) {
  if (purchase.last_error_code === 'capacity_refund_pending') return compensatePublicTicketCapacity(db, purchase);
  try {
    return await recoverPublicTicketMembers({ db, purchase, loadPaymentIntent });
  } catch (error) {
    const excluded = error.code === 'PAYMENT_NOT_ELIGIBLE';
    const { error: writeError } = await db.from('public_ticket_member_purchase')
      .update({
        state: excluded ? 'excluded' : 'retryable',
        last_error_code: excluded ? 'payment_not_eligible' : 'verification_unavailable',
        updated_at: new Date().toISOString(),
      }).eq('id', purchase.id).neq('state', 'completed');
    if (writeError) throw new Error('Unable to record recovery outcome');
    return { state: excluded ? 'excluded' : 'retryable' };
  }
}

export async function recoverPublicTicketPurchases(db, { budgetMs = 20000 } = {}) {
  const start = Date.now();
  const { data, error } = await db.from('public_ticket_member_purchase').select('*')
    .in('state', ['prepared', 'ready', 'retryable'])
    .or('booking_ids.neq.{},last_error_code.eq.capacity_refund_pending')
    .order('updated_at').order('id').limit(25);
  if (error || !Array.isArray(data)) throw new Error('Unable to load ticket member recovery work');
  let processed = 0;
  for (const purchase of data) {
    if (Date.now() - start >= budgetMs) break;
    await recoverPublicTicketPurchase(db, purchase);
    processed++;
  }
  return { processed };
}

export async function replayPublicTicketBooking(db, purchase) {
  if (!purchase?.booking_ids?.length) return null;
  const source = purchase.event_kind === 'simple' ? 'booking' : 'complex_event_booking';
  const { data: bookings, error } = await db.from(source).select('*')
    .eq('tenant_id', purchase.tenant_id).eq('event_id', purchase.event_id).in('id', purchase.booking_ids);
  if (error || !Array.isArray(bookings) || bookings.length !== purchase.booking_ids.length) {
    throw new Error('Unable to verify the complete booking batch. Do not pay again.');
  }
  if (bookings.some(booking => booking.status !== 'confirmed')) {
    return { success: false, error: 'This purchase is no longer fully confirmed. Contact the event administrator; do not pay again.' };
  }
  const outcome = await recoverPublicTicketPurchase(db, purchase);
  if (outcome.state === 'excluded') {
    return { success: false, error: 'This purchase is no longer eligible for completion. Do not pay again.' };
  }
  return {
    success: true, already_processed: true, bookings, booking_count: bookings.length,
    booking_reference: bookings[0].booking_group_reference || bookings[0].booking_reference,
    booking_group_reference: bookings[0].booking_group_reference || bookings[0].booking_reference,
    member_creation: outcome,
  };
}
