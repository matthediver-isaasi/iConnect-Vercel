// Shared booking cancellation helper used by the event-deletion flow
// (api/events/[id]/delete-with-cancellations.js and the complex-event variant).
//
// This mirrors processCancellation + sendCancellationNotificationEmails from
// api/booking-cancellation-requests/[requestId].js, but takes a fetched booking
// directly and accepts a `reason` discriminator that drives email wording.
// The existing per-booking PATCH endpoint and approve-group.js are left
// untouched intentionally to minimise regression risk on the request-driven
// cancellation queue (see task-700 commit notes).

import { supabase } from './database.js';
import { getStripeCredentials } from './stripeCredentials.js';
import { createXeroCreditNote } from './xero.js';
import { sendEmail } from './emailService.js';
import { cancelZoomRegistrant, resolveEventZoomWebinar } from './zoomClient.js';
import Stripe from 'stripe';
import {
  BOOKING_SOURCE_COMPLEX,
  isComplexSource,
  normalizeComplexBooking,
  getBookingTable,
  restoreComplexEventSeats,
  cancelComplexEventZoomRegistrations,
  reinstateVoucherDirect,
  reinstateVoucherFromTransactions,
} from './bookingLookup.js';

export const CANCELLATION_REASON_REQUEST_APPROVED = 'request_approved';
export const CANCELLATION_REASON_EVENT_DELETED = 'event_deleted';

/**
 * Cancel a single booking and run all reversal side-effects (refund, credit
 * note, voucher / training-fund / discount reinstatement, Zoom unregister).
 *
 * Idempotent: re-running on an already-cancelled booking returns
 * { success:true, alreadyCancelled:true } without touching financial state.
 *
 * @param {object} args
 * @param {object} args.booking         booking row (regular or normalized complex)
 * @param {string} args.source          'booking' | 'complex_event_booking'
 * @param {string} args.tenantId
 * @param {string} args.reason          CANCELLATION_REASON_*
 * @param {object} [args.refundAllocation]
 * @param {object} [args.reversalOptions]
 * @returns {Promise<{success:boolean, alreadyCancelled?:boolean, requiresManualAction?:boolean, reversalResults?:object, error?:string}>}
 */
export async function cancelBookingForEventDeletion({
  booking,
  source,
  tenantId,
  reason,
  refundAllocation = null,
  reversalOptions = {},
  cancellationRequestId = null,
}) {
  const reversalResults = {
    trainingFund: null,
    vouchers: [],
    discountCode: null,
    programTicket: null,
    stripeRefund: null,
    xeroCreditNote: null,
    replacements: [],
  };

  if (!booking || !booking.id) {
    return { success: false, error: 'Booking is required' };
  }

  const isComplex = isComplexSource(source);
  const bookingTable = getBookingTable(source);

  if (booking.status === 'cancelled') {
    return { success: true, alreadyCancelled: true, reversalResults };
  }

  // 1. Mark booking cancelled (do this first so re-runs are idempotent).
  const { error: updateError } = await supabase
    .from(bookingTable)
    .update({ status: 'cancelled' })
    .eq('id', booking.id);
  if (updateError) {
    return { success: false, error: 'Failed to update booking status: ' + updateError.message };
  }
  console.log(`[EventDeleteCancel] Booking ${booking.id} cancelled (source: ${source}, reason: ${reason})`);

  let requiresManualAction = false;

  // 2. Restore seats + cancel Zoom (best-effort, non-blocking).
  if (booking.event_id) {
    if (isComplex) {
      try { await restoreComplexEventSeats(booking, tenantId); } catch (err) {
        console.error(`[EventDeleteCancel] Complex seat restore error:`, err.message);
      }
    } else {
      try {
        const { data: ev } = await supabase
          .from('event')
          .select('id, available_seats, is_unlimited_registration')
          .eq('id', booking.event_id)
          .single();
        if (ev && ev.available_seats !== null && ev.available_seats !== undefined && !ev.is_unlimited_registration) {
          const { error: rpcErr } = await supabase.rpc('adjust_event_seats', { p_event_id: booking.event_id, p_delta: 1 });
          if (rpcErr) {
            await supabase.from('event').update({ available_seats: ev.available_seats + 1 }).eq('id', booking.event_id);
          }
        }
      } catch (err) {
        console.error(`[EventDeleteCancel] Seat restore error:`, err.message);
      }
    }

    if (isComplex) {
      try { await cancelComplexEventZoomRegistrations(booking, tenantId); } catch (err) {
        console.error(`[EventDeleteCancel] Complex zoom cancel error:`, err.message);
      }
    } else {
      try {
        const { data: ev } = await supabase
          .from('event')
          .select('id, zoom_webinar_id, location, backstage_event_id')
          .eq('id', booking.event_id)
          .single();
        if (ev) {
          const webinar = await resolveEventZoomWebinar(ev);
          if (webinar?.zoom_webinar_id && booking.attendee_email) {
            await cancelZoomRegistrant(tenantId, webinar.zoom_webinar_id, booking.attendee_email);
          }
        }
      } catch (err) {
        console.error(`[EventDeleteCancel] Zoom cancel error:`, err.message);
      }
    }
  }

  // 3. Org-level reversals: training fund + program tickets.
  const organizationId = booking.organization_id;
  let org = null;
  if (organizationId) {
    const { data: orgData } = await supabase
      .from('organization')
      .select('id, program_ticket_balances, training_fund_balance')
      .eq('id', organizationId)
      .single();
    org = orgData;
  }

  if (booking.training_fund_amount > 0 && org) {
    try {
      const refundAmount = booking.training_fund_amount;
      const currentBalance = org.training_fund_balance || 0;
      const newBalance = currentBalance + refundAmount;
      await supabase.from('organization').update({ training_fund_balance: newBalance }).eq('id', org.id);
      await supabase.from('training_fund_transaction').insert({
        organization_id: org.id,
        type: 'cancellation_refund',
        amount: refundAmount,
        balance_before: currentBalance,
        balance_after: newBalance,
        reason: `Event-deletion cancellation refund: ${booking.booking_reference || booking.id}`,
        booking_id: booking.id,
        created_by: booking.member_id,
        created_date: new Date().toISOString(),
        tenant_id: tenantId,
      });
      reversalResults.trainingFund = { amount: refundAmount, success: true };
    } catch (err) {
      console.error(`[EventDeleteCancel] Training fund error:`, err.message);
      reversalResults.trainingFund = { amount: booking.training_fund_amount, success: false, error: err.message };
    }
  }

  // 4. Voucher reinstatement.
  if (booking.voucher_amount > 0 && booking.booking_reference) {
    try {
      if (isComplex && booking.voucher_id) {
        await reinstateVoucherDirect(booking, refundAllocation, reversalOptions, reversalResults, tenantId);
      } else {
        await reinstateVoucherFromTransactions(booking, refundAllocation, reversalOptions, reversalResults, tenantId);
      }
    } catch (err) {
      console.error(`[EventDeleteCancel] Voucher reinstatement error:`, err.message);
    }
  }

  // 5. Discount code usage decrement (only first ticket in a group).
  if (booking.discount_code_id && booking.discount_code_amount > 0) {
    try {
      const { data: dc } = await supabase
        .from('discount_code')
        .select('*')
        .eq('id', booking.discount_code_id)
        .single();
      if (dc) {
        const isExpired = dc.expires_at && new Date(dc.expires_at) < new Date();
        const isFirstInGroup = !booking.booking_group_reference
          || booking.booking_reference === booking.booking_group_reference
          || booking.booking_reference === `${booking.booking_group_reference}-1`;
        if (!isExpired && isFirstInGroup) {
          await supabase
            .from('discount_code')
            .update({ current_usage_count: Math.max(0, (dc.current_usage_count || 1) - 1) })
            .eq('id', dc.id);
          if (organizationId) {
            const { data: usage } = await supabase
              .from('discount_code_usage')
              .select('id, usage_count')
              .eq('discount_code_id', dc.id)
              .eq('organization_id', organizationId)
              .maybeSingle();
            if (usage && usage.usage_count > 0) {
              await supabase.from('discount_code_usage')
                .update({ usage_count: usage.usage_count - 1 })
                .eq('id', usage.id);
            }
          }
          reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: true, reversed: true };
        } else if (!isFirstInGroup) {
          reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: true, skippedNotFirstInGroup: true };
        } else {
          reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: false, expired: true, skipped: true };
        }
      }
    } catch (err) {
      console.error(`[EventDeleteCancel] Discount code reversal error:`, err.message);
      reversalResults.discountCode = { success: false, error: err.message };
    }
  }

  // 6. Program ticket refund (regular events only).
  if (booking.event_id && booking.member_id && !isComplex) {
    try {
      const { data: event } = await supabase.from('event').select('program_tag, title').eq('id', booking.event_id).single();
      if (event?.program_tag && org) {
        const balances = org.program_ticket_balances || {};
        const cur = balances[event.program_tag] || 0;
        await supabase.from('organization').update({
          program_ticket_balances: { ...balances, [event.program_tag]: cur + 1 },
          last_synced: new Date().toISOString(),
        }).eq('id', org.id);
        await supabase.from('program_ticket_transaction').insert({
          organization_id: org.id,
          program_name: event.program_tag,
          transaction_type: 'refund',
          quantity: 1,
          booking_reference: booking.booking_reference || booking.backstage_order_id || booking.id,
          event_name: event.title || 'Unknown Event',
          member_email: booking.attendee_email || 'unknown',
          notes: `Ticket refunded via event deletion`,
        });
        reversalResults.programTicket = { programTag: event.program_tag, success: true };
      }
    } catch (err) {
      console.error(`[EventDeleteCancel] Program ticket refund error:`, err.message);
    }
  }

  // 7. Stripe refund (full refundable amount).
  const totalCost = parseFloat(booking.total_cost) || 0;
  const trainingFundAmt = parseFloat(booking.training_fund_amount) || 0;
  const voucherAmt = parseFloat(booking.voucher_amount) || 0;
  const discountAmt = parseFloat(booking.discount_code_amount) || 0;
  const accountAmt = parseFloat(booking.account_amount) || 0;
  const cardAmount = Math.max(0, totalCost - trainingFundAmt - voucherAmt - discountAmt - accountAmt);

  if (booking.stripe_payment_intent_id && booking.payment_method === 'card' && cardAmount > 0) {
    try {
      const creds = await getStripeCredentials(tenantId, 'events');
      if (!creds || !creds.secret_key || !creds.is_enabled) {
        reversalResults.stripeRefund = {
          success: false,
          amount: cardAmount,
          requiresManualRefund: true,
          error: !creds?.is_enabled ? 'Stripe integration is disabled for this tenant' : 'Stripe not configured for this tenant',
        };
        requiresManualAction = true;
      } else {
        const stripe = new Stripe(creds.secret_key);
        const refundPence = Math.round(cardAmount * 100);
        const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
        const received = pi.amount_received || 0;
        const existing = await stripe.refunds.list({ payment_intent: booking.stripe_payment_intent_id, limit: 100 });
        const refunded = existing.data.reduce((s, r) => s + (r.status !== 'failed' ? r.amount : 0), 0);
        const refundable = received - refunded;
        if (refundable <= 0) {
          reversalResults.stripeRefund = { success: true, amount: cardAmount, alreadyRefunded: true, paymentIntentId: booking.stripe_payment_intent_id };
        } else {
          const actualPence = Math.min(refundPence, refundable);
          // Idempotency key keyed on booking + reason so re-running event deletion
          // never double-refunds.
          const idempotencyKey = `event-delete-refund-${reason}-${booking.id}`;
          const refund = await stripe.refunds.create({
            payment_intent: booking.stripe_payment_intent_id,
            amount: actualPence,
            reason: 'requested_by_customer',
            metadata: {
              booking_id: booking.id,
              booking_reference: booking.booking_reference || '',
              cancellation_reason: reason,
              cancellation_request_id: cancellationRequestId || '',
            },
          }, { idempotencyKey });
          reversalResults.stripeRefund = {
            success: true,
            amount: actualPence / 100,
            refundId: refund.id,
            status: refund.status,
            paymentIntentId: booking.stripe_payment_intent_id,
            partialRefund: actualPence < refundPence,
          };
        }
      }
    } catch (err) {
      console.error(`[EventDeleteCancel] Stripe refund error:`, err.message);
      reversalResults.stripeRefund = {
        success: false,
        amount: cardAmount,
        requiresManualRefund: true,
        error: err.message,
        paymentIntentId: booking.stripe_payment_intent_id,
      };
      requiresManualAction = true;
    }
  }

  // 8. Xero credit note (full invoice amount).
  if (booking.xero_invoice_id && totalCost > 0) {
    try {
      const result = await createXeroCreditNote({
        appTenantId: tenantId,
        invoiceId: booking.xero_invoice_id,
        creditAmount: totalCost,
        description: `Event cancelled by organiser — booking ${booking.booking_reference || booking.id}`,
        reference: `Event-cancel: ${booking.booking_reference || booking.id}`,
      });
      if (result.skipped) {
        reversalResults.xeroCreditNote = {
          success: false,
          skipped: true,
          reason: result.reason,
          amount: totalCost,
          invoiceNumber: result.invoiceNumber,
          requiresManualAction: true,
        };
        requiresManualAction = true;
      } else {
        reversalResults.xeroCreditNote = {
          success: true,
          amount: result.amount,
          creditNoteId: result.creditNoteId,
          creditNoteNumber: result.creditNoteNumber,
          allocated: result.allocated,
          invoiceNumber: result.invoiceNumber,
          alreadyExisted: result.alreadyExisted || false,
        };
        if (result.creditNoteId) {
          await supabase
            .from(bookingTable)
            .update({
              xero_credit_note_id: result.creditNoteId,
              xero_credit_note_number: result.creditNoteNumber,
            })
            .eq('id', booking.id);
        }
      }
    } catch (err) {
      console.error(`[EventDeleteCancel] Xero credit note error:`, err.message);
      reversalResults.xeroCreditNote = {
        success: false,
        amount: totalCost,
        requiresManualAction: true,
        error: err.message,
        invoiceId: booking.xero_invoice_id,
        invoiceNumber: booking.xero_invoice_number,
      };
      requiresManualAction = true;
    }
  }

  return { success: true, requiresManualAction, reversalResults };
}

/**
 * Send cancellation email to attendee + booker, with wording driven by `reason`.
 */
export async function sendEventDeletionCancellationEmail({
  booking,
  source,
  tenantId,
  reason,
  organiserMessage = null,
  eventName: eventNameOverride = null,
  reversalResults = null,
}) {
  if (!booking) return;

  const isComplex = isComplexSource(source);
  const attendeeEmail = booking.attendee_email;
  const memberId = booking.member_id;
  if (!attendeeEmail && !memberId) return;

  let eventName = eventNameOverride || 'your event';
  if (!eventNameOverride && booking.event_id) {
    const { data: ev } = await supabase
      .from(isComplex ? 'complex_event' : 'event')
      .select('title')
      .eq('id', booking.event_id)
      .single();
    if (ev?.title) eventName = ev.title;
  }

  let bookerEmail = null;
  let bookerFirstName = null;
  if (memberId) {
    const { data: m } = await supabase
      .from('member')
      .select('email, first_name')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();
    if (m) { bookerEmail = m.email; bookerFirstName = m.first_name; }
  }

  const attendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';
  const bookingRef = booking.booking_reference || booking.booking_group_reference || '';

  const isEventDeleted = reason === CANCELLATION_REASON_EVENT_DELETED;
  const subject = isEventDeleted
    ? `Event cancelled — ${eventName}`
    : `Booking cancellation confirmed — ${eventName}`;

  const financialLines = [];
  if (reversalResults) {
    const rr = reversalResults;
    if (rr.trainingFund?.success) {
      financialLines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
    }
    for (const v of rr.vouchers || []) {
      if (v.reinstated) financialLines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
      if (v.replacementCreated) financialLines.push(`Replacement voucher ${v.newVoucherCode} issued`);
    }
    if (rr.discountCode?.reversed) financialLines.push(`Discount code ${rr.discountCode.code} usage reversed`);
    if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
      financialLines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
    } else if (rr.stripeRefund && rr.stripeRefund.requiresManualRefund) {
      financialLines.push(`Card refund of £${Number(rr.stripeRefund.amount).toFixed(2)} could not be processed automatically — our team will be in touch`);
    }
    if (rr.xeroCreditNote?.success) {
      financialLines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
    } else if (rr.xeroCreditNote?.requiresManualAction) {
      financialLines.push(`A credit note will be issued shortly`);
    }
  }

  const safeOrganiserMessage = organiserMessage
    ? String(organiserMessage).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    : null;

  const buildHtml = (recipientName, isBooker) => {
    const safeName = recipientName || 'there';
    let body = `<p>Hi ${safeName},</p>`;
    if (isEventDeleted) {
      if (isBooker && attendeeEmail && attendeeEmail.toLowerCase() !== (bookerEmail || '').toLowerCase()) {
        body += `<p><strong>${eventName}</strong> has been cancelled by the organiser. The booking you made for <strong>${attendeeName}</strong> has therefore been cancelled.</p>`;
      } else {
        body += `<p><strong>${eventName}</strong> has been cancelled by the organiser, so your booking has been cancelled.</p>`;
      }
    } else {
      if (isBooker && attendeeEmail && attendeeEmail.toLowerCase() !== (bookerEmail || '').toLowerCase()) {
        body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
      } else {
        body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled.</p>`;
      }
    }

    if (bookingRef) {
      body += `<p style="color:#666;font-size:14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
    }

    if (safeOrganiserMessage) {
      body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
      body += `<p style="margin:0 0 6px 0;font-weight:600;">A message from the organiser</p>`;
      body += `<p style="margin:0;color:#555;">${safeOrganiserMessage}</p>`;
      body += `</div>`;
    }

    if (financialLines.length > 0) {
      body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
      body += `<p style="margin:0 0 10px 0;font-weight:600;">Refund summary</p>`;
      body += `<ul style="margin:0;padding-left:20px;color:#555;">`;
      for (const line of financialLines) body += `<li style="margin-bottom:6px;">${line}</li>`;
      body += `</ul></div>`;
    }

    body += `<p style="color:#666;font-size:14px;">If you have any questions, please get in touch.</p>`;
    return body;
  };

  const recipients = new Set();
  if (attendeeEmail) recipients.add(attendeeEmail.toLowerCase());
  if (bookerEmail && bookerEmail.toLowerCase() !== (attendeeEmail || '').toLowerCase()) {
    recipients.add(bookerEmail.toLowerCase());
  }

  for (const to of recipients) {
    const isBooker = bookerEmail && to === bookerEmail.toLowerCase();
    const recipientName = isBooker ? bookerFirstName : (booking.attendee_first_name || attendeeName);
    try {
      await sendEmail({
        to,
        subject,
        html: buildHtml(recipientName, isBooker),
        tenantId,
      });
      console.log(`[EventDeleteCancel] Sent ${reason} email to ${to} | bookingId: ${booking.id}`);
    } catch (err) {
      console.error(`[EventDeleteCancel] Email send failed to ${to}:`, err.message);
    }
  }
}

export { normalizeComplexBooking, BOOKING_SOURCE_COMPLEX };
