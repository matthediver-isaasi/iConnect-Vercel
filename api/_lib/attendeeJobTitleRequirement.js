import { ATTENDEE_JOB_TITLE_KEY, requireAttendeeJobTitle, missingAttendeeJobTitle } from '../../shared/attendeeJobTitleRequirement.js';
import { fetchMemberJobTitlesByEmail, resolveStoredJobTitle } from './attendeeJobTitleEnrichment.js';
import { compensateRejectedEventCreditPayment } from './eventPaymentPolicyCompensation.js';

// Mutate only the request's attendee snapshot, never member profiles.
export async function enforceAttendeeJobTitles(db, tenantId, attendees, expectedCount = null) {
  const { data, error } = await db.from('system_settings')
    .select('setting_key, setting_value').eq('tenant_id', tenantId)
    .eq('setting_key', ATTENDEE_JOB_TITLE_KEY);
  if (error || !Array.isArray(data)) throw Object.assign(new Error('Attendee job title requirements are temporarily unavailable. Please retry.'), { statusCode: 503 });
  if (!requireAttendeeJobTitle(data)) return;
  if (!Array.isArray(attendees) || !attendees.length ||
      (expectedCount !== null && attendees.length !== expectedCount)) {
    throw Object.assign(new Error('Provide job titles and complete details for every attendee before payment.'), { statusCode: 400 });
  }
  const titles = await fetchMemberJobTitlesByEmail(db, tenantId,
    attendees.filter(a => !a?.job_title?.trim?.()).map(a => a?.email));
  for (const attendee of attendees) {
    if (attendee) attendee.job_title = resolveStoredJobTitle(
      typeof attendee.job_title === 'string' ? attendee.job_title : '', attendee.email, titles);
  }
  const message = missingAttendeeJobTitle(attendees);
  if (message) throw Object.assign(new Error(message), { statusCode: 400 });
}

// A title-policy change between payment and return must not strand a charge.
// Existing bookings keep their handler's established replay path; otherwise a
// rejected payment is reversed only after provider-owned binding is verified.
export async function checkBookingAttendeeJobTitles({
  db, tenantId, eventId, attendees, bookingTable, paymentIntentId,
  purchaserEmail, allocationContext, paymentService,
}) {
  if (paymentIntentId) {
    const { data, error } = await db.from(bookingTable).select('id')
      .eq('tenant_id', tenantId).eq('event_id', eventId)
      .eq('stripe_payment_intent_id', paymentIntentId).limit(1);
    if (error || !Array.isArray(data)) {
      throw Object.assign(new Error('Unable to verify existing payment bookings. Do not pay again.'), { statusCode: 503 });
    }
    if (data.length) return null;
  }
  try {
    await enforceAttendeeJobTitles(db, tenantId, attendees);
    return null;
  } catch (error) {
    if (!paymentIntentId) throw error;
    let compensation;
    try {
      const service = await paymentService();
      const paymentIntent = await service.paymentIntents.retrieve(paymentIntentId);
      compensation = await compensateRejectedEventCreditPayment({
        paymentIntent, expectedIntentId: paymentIntentId, tenantId, eventId,
        purchaserEmail, allocationContext,
        refundSucceeded: () => service.refunds.create(
          { payment_intent: paymentIntentId, reason: 'requested_by_customer' },
          { idempotencyKey: `event-title-policy:${tenantId}:${paymentIntentId}` },
        ),
        cancelAuthorization: () => service.paymentIntents.cancel(paymentIntentId, {},
          { idempotencyKey: `event-title-policy-cancel:${tenantId}:${paymentIntentId}` }),
      });
    } catch {
      compensation = { ok: false };
    }
    if (!compensation.ok) return {
      success: false, statusCode: 502, refund_failed: true, stripe_payment_intent_id: paymentIntentId,
      error: `${error.message} The card payment could not be automatically reversed. Please contact support with reference: ${paymentIntentId}`,
    };
    return {
      success: false, statusCode: error.statusCode || 400,
      refunded: compensation.action === 'refunded',
      payment_cancelled: compensation.action === 'cancelled',
      error: `${error.message}${compensation.compensated ? ` Your card payment has been automatically ${compensation.action}.` : ''}`,
    };
  }
}
