// Unified booking cancellation engine (task-706).
//
// Single source of truth for the per-booking cancellation pipeline used by:
//   1. api/booking-cancellation-requests/[requestId].js   (member-raised request, admin approval)
//   2. api/booking-cancellation-requests/approve-group.js (admin batch approval, with skips
//                                                          for the steps it consolidates at
//                                                          the group level — Stripe / Xero /
//                                                          discount code / voucher / seats /
//                                                          zoom)
//   3. api/_lib/eventDeletion.js                          (organiser-driven event deletion)
//
// The same side-effects (refund, Xero credit note, voucher / training-fund /
// discount-code / program-ticket reinstatement, Zoom unregister) used to live
// in two places — task-700 deliberately kept them separate to limit blast
// radius. Task-706 collapses them so bug fixes only need to be made once.
//
// `reason` drives observability (log prefix, Stripe metadata, idempotency key
// suffix) and email wording. `skip*` flags let callers that handle a step at
// a higher level (e.g. group approval consolidating Stripe into one refund)
// opt out of that step per-booking.

import { supabase } from './database.js';
import { getStripeCredentials } from './stripeCredentials.js';
import { getAccountingProvider, buildCreditNoteColumnUpdate } from './accountingProvider.js';
import { sendEmail } from './emailService.js';
import { buildInboxDelivery } from './transactionalInbox.js';
import {
  buildCancellationEmail,
  CANCELLATION_FLOW_EVENT_DELETED,
} from './cancellationEmail.js';
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

function logPrefixFor(reason) {
  if (reason === CANCELLATION_REASON_EVENT_DELETED) return '[EventDeleteCancel]';
  if (reason === CANCELLATION_REASON_REQUEST_APPROVED) return '[CancellationRequest]';
  return '[CancelBooking]';
}

/**
 * Cancel a single booking and run all reversal side-effects (refund, credit
 * note, voucher / training-fund / discount-code / program-ticket
 * reinstatement, Zoom unregister, seat restore).
 *
 * Idempotent: re-running on an already-cancelled booking returns
 * { success:true, alreadyCancelled:true } without touching financial state.
 *
 * @param {object} args
 * @param {object} args.booking                 booking row (regular or normalized complex)
 * @param {string} args.source                  'booking' | 'complex_event_booking'
 * @param {string} args.tenantId
 * @param {string} args.reason                  CANCELLATION_REASON_*
 * @param {object} [args.refundAllocation]      { stripeAmount?, trainingFundAmount?, invoiceAmount? }
 * @param {object} [args.reversalOptions]       voucher / discountCodeReplacement options
 * @param {number} [args.customRefundAmount]    explicit Stripe refund amount (overrides full card amount)
 * @param {string} [args.creditNoteEmail]       if set, emails the Xero credit note PDF here
 * @param {string} [args.cancellationRequestId] populates Stripe metadata + idempotency key
 * @param {boolean} [args.skipStripeRefund]
 * @param {boolean} [args.skipXeroCreditNote]
 * @param {boolean} [args.skipDiscountCodeReversal]
 * @param {boolean} [args.skipVoucherReinstatement]
 * @param {boolean} [args.skipSeatRestore]
 * @param {boolean} [args.skipZoomCancel]
 * @param {string}  [args.xeroDescription]      override xero credit note line description
 * @param {string}  [args.xeroReference]        override xero credit note reference
 * @param {string}  [args.programTicketNote]    override program_ticket_transaction note text
 * @param {string}  [args.trainingFundReasonText] override training_fund_transaction reason text
 * @returns {Promise<{success:boolean, alreadyCancelled?:boolean, requiresManualAction?:boolean, reversalResults?:object, error?:string}>}
 */
export async function cancelBooking({
  booking,
  source,
  tenantId,
  reason,
  refundAllocation = null,
  reversalOptions = {},
  customRefundAmount = null,
  creditNoteEmail = null,
  cancellationRequestId = null,
  skipStripeRefund = false,
  skipXeroCreditNote = false,
  skipDiscountCodeReversal = false,
  skipVoucherReinstatement = false,
  skipSeatRestore = false,
  skipZoomCancel = false,
  xeroDescription = null,
  xeroReference = null,
  programTicketNote = null,
  trainingFundReasonText = null,
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

  const LP = logPrefixFor(reason);
  const isComplex = isComplexSource(source);
  const bookingTable = getBookingTable(source);

  if (booking.status === 'cancelled') {
    return { success: true, alreadyCancelled: true, reversalResults };
  }

  // Validate customRefundAmount up front so callers get a clean 400.
  if (customRefundAmount !== undefined && customRefundAmount !== null) {
    const parsed = parseFloat(customRefundAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { success: false, error: 'custom_refund_amount must be a positive number' };
    }
  }

  // 1. Commit the status and any commercial allocation movement together under
  // the shared ticket lock. Otherwise registrations can observe a false
  // free-place window between two separate database requests.
  const { data: atomicCancellation, error: atomicCancellationError } = await supabase.rpc('cancel_event_booking_with_allocation', {
    p_tenant_id: tenantId,
    p_booking_kind: isComplex ? 'complex' : 'simple',
    p_booking_id: booking.id,
    p_idempotency_key: `booking-cancelled:${booking.id}`,
    p_actor_kind: 'system',
    p_actor_id: booking.id,
  });
  if (atomicCancellationError) {
    // Rollout compatibility for environments that have not applied the new
    // migration yet. Other RPC errors fail closed before financial side effects.
    if (atomicCancellationError.code === '42883' || atomicCancellationError.code === 'PGRST202') {
      const { error: updateError } = await supabase
        .from(bookingTable)
        .update({ status: 'cancelled' })
        .eq('id', booking.id);
      if (updateError) {
        return { success: false, error: 'Failed to update booking status: ' + updateError.message };
      }
    } else {
      return { success: false, error: 'Failed to update booking status: ' + atomicCancellationError.message };
    }
  }
  if (atomicCancellation?.alreadyCancelled) {
    return { success: true, alreadyCancelled: true, reversalResults };
  }
  console.log(`${LP} Booking ${booking.id} cancelled (source: ${source}, reason: ${reason})`);

  let requiresManualAction = false;

  // 2. Restore seats + cancel Zoom (best-effort, non-blocking).
  if (booking.event_id && (!skipSeatRestore || !skipZoomCancel)) {
    if (!skipSeatRestore) {
      if (isComplex) {
        try { await restoreComplexEventSeats(booking, tenantId); } catch (err) {
          console.error(`${LP} Complex seat restore error:`, err.message);
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
          console.error(`${LP} Seat restore error:`, err.message);
        }
      }
    }

    if (!skipZoomCancel) {
      if (isComplex) {
        try { await cancelComplexEventZoomRegistrations(booking, tenantId); } catch (err) {
          console.error(`${LP} Complex zoom cancel error:`, err.message);
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
          console.error(`${LP} Zoom cancel error:`, err.message);
        }
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

  // Training fund. Honour refundAllocation.trainingFundAmount if supplied
  // (capped at booking.training_fund_amount; <= 0 ⇒ skip with success flag).
  if (booking.training_fund_amount > 0 && org) {
    try {
      let refundAmount = booking.training_fund_amount;
      if (refundAllocation && refundAllocation.trainingFundAmount !== undefined) {
        const allocatedAmt = parseFloat(refundAllocation.trainingFundAmount) || 0;
        refundAmount = Math.min(allocatedAmt, booking.training_fund_amount);
      }
      if (refundAmount <= 0) {
        reversalResults.trainingFund = { amount: 0, success: true, skipped: true };
        console.log(`${LP} Training fund refund skipped per allocation`);
      } else {
        if (!tenantId) {
          throw new Error('Refusing to write training_fund_transaction with NULL tenant_id during cancellation refund');
        }
        const currentBalance = org.training_fund_balance || 0;
        const newBalance = currentBalance + refundAmount;
        await supabase.from('organization').update({ training_fund_balance: newBalance }).eq('id', org.id);
        await supabase.from('training_fund_transaction').insert({
          organization_id: org.id,
          type: 'cancellation_refund',
          amount: refundAmount,
          balance_before: currentBalance,
          balance_after: newBalance,
          reason: trainingFundReasonText
            || `${reason === CANCELLATION_REASON_EVENT_DELETED ? 'Event-deletion cancellation refund' : 'Cancellation refund'}: ${booking.booking_reference || booking.id}`,
          booking_id: booking.id,
          created_by: booking.member_id,
          created_date: new Date().toISOString(),
          tenant_id: tenantId,
        });
        org.training_fund_balance = newBalance;
        reversalResults.trainingFund = { amount: refundAmount, success: true };
        console.log(`${LP} Training fund reinstated: £${refundAmount}`);
      }
    } catch (err) {
      console.error(`${LP} Training fund error:`, err.message);
      reversalResults.trainingFund = { amount: booking.training_fund_amount, success: false, error: err.message };
    }
  }

  // 4. Voucher reinstatement.
  if (!skipVoucherReinstatement && booking.voucher_amount > 0 && booking.booking_reference) {
    try {
      if (isComplex && booking.voucher_id) {
        await reinstateVoucherDirect(booking, refundAllocation, reversalOptions, reversalResults, tenantId);
      } else {
        await reinstateVoucherFromTransactions(booking, refundAllocation, reversalOptions, reversalResults, tenantId);
      }
    } catch (err) {
      console.error(`${LP} Voucher reinstatement error:`, err.message);
    }
  }

  // 5. Discount code usage decrement (only first ticket in a group).
  //    When the code has expired and reversalOptions.discountCodeReplacement
  //    supplies a newExpiryDate, mint a single-use replacement code.
  if (!skipDiscountCodeReversal && booking.discount_code_id && booking.discount_code_amount > 0) {
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
          console.log(`${LP} Discount code ${dc.code} usage decremented`);
        } else if (isExpired && isFirstInGroup) {
          const replacementOption = reversalOptions.discountCodeReplacement;
          if (replacementOption && replacementOption.newExpiryDate) {
            const newCode = `REFUND-${dc.code}-${Date.now().toString(36).toUpperCase()}`;
            const { data: newDC, error: createErr } = await supabase
              .from('discount_code')
              .insert({
                code: newCode,
                type: dc.type,
                value: dc.value,
                description: `Replacement for expired code ${dc.code} (cancellation of ${booking.booking_reference})`,
                is_active: true,
                expires_at: replacementOption.newExpiryDate,
                max_usage_count: 1,
                current_usage_count: 0,
                organization_id: organizationId || null,
                tenant_id: tenantId,
              })
              .select()
              .single();
            if (createErr) {
              reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: false, expired: true, error: 'Failed to create replacement: ' + createErr.message };
            } else {
              reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: true, expired: true, replacementCreated: true, newCode: newDC.code, newCodeId: newDC.id };
              reversalResults.replacements.push({ type: 'discount_code', originalCode: dc.code, newCode: newDC.code, value: dc.value, discountType: dc.type, expiryDate: replacementOption.newExpiryDate });
              console.log(`${LP} Replacement discount code ${newCode} created for expired ${dc.code}`);
            }
          } else {
            reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: false, expired: true, skipped: true };
          }
        } else if (!isFirstInGroup) {
          reversalResults.discountCode = { codeId: dc.id, code: dc.code, amount: booking.discount_code_amount, success: true, skippedNotFirstInGroup: true };
        }
      }
    } catch (err) {
      console.error(`${LP} Discount code reversal error:`, err.message);
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
          notes: programTicketNote
            || (reason === CANCELLATION_REASON_EVENT_DELETED
              ? 'Ticket refunded via event deletion'
              : 'Ticket refunded via approved cancellation request'),
        });
        reversalResults.programTicket = { programTag: event.program_tag, success: true };
        console.log(`${LP} Program ticket refunded for ${event.program_tag}`);
      }
    } catch (err) {
      console.error(`${LP} Program ticket refund error:`, err.message);
    }
  }

  // 7. Stripe refund.
  const totalCost = parseFloat(booking.total_cost) || 0;
  const trainingFundAmt = parseFloat(booking.training_fund_amount) || 0;
  const voucherAmt = parseFloat(booking.voucher_amount) || 0;
  const discountAmt = parseFloat(booking.discount_code_amount) || 0;
  const accountAmt = parseFloat(booking.account_amount) || 0;
  const fullCardAmount = Math.max(0, totalCost - trainingFundAmt - voucherAmt - discountAmt - accountAmt);

  let effectiveRefundAmount = null;
  if (customRefundAmount !== undefined && customRefundAmount !== null) {
    const customAmt = parseFloat(customRefundAmount);
    const maxAllowed = Math.min(fullCardAmount > 0 ? fullCardAmount : Infinity, totalCost > 0 ? totalCost : Infinity);
    if (customAmt > maxAllowed) {
      return { success: false, error: `custom_refund_amount (${customAmt}) exceeds maximum refundable amount (${maxAllowed.toFixed(2)})` };
    }
    effectiveRefundAmount = customAmt;
  }

  if (!skipStripeRefund && booking.stripe_payment_intent_id && booking.payment_method === 'card') {
    const cardAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : fullCardAmount;
    if (cardAmount > 0) {
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
            console.log(`${LP} PaymentIntent ${booking.stripe_payment_intent_id} already fully refunded`);
          } else {
            const actualPence = Math.min(refundPence, refundable);
            // Idempotency key: for event-deletion keyed on booking + reason
            // (preserved literal for the audit script regression check); for
            // request-driven flows keyed on booking + cancellation request.
            const idempotencyKey = reason === CANCELLATION_REASON_EVENT_DELETED
              ? `event-delete-refund-${reason}-${booking.id}`
              : `cancel-refund-${cancellationRequestId || reason}-${booking.id}`;
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
            console.log(`${LP} Stripe refund ${refund.id}: £${actualPence / 100} (status: ${refund.status})`);
          }
        }
      } catch (err) {
        console.error(`${LP} Stripe refund error:`, err.message);
        reversalResults.stripeRefund = {
          success: false,
          amount: cardAmount,
          requiresManualRefund: true,
          error: err.message,
          paymentIntentId: booking.stripe_payment_intent_id,
        };
        requiresManualAction = true;
      }
    } else {
      console.log(`${LP} Card amount is £0 — no Stripe refund needed`);
    }
  }

  // 8. Xero credit note.
  const _invoiceIdForCredit = booking.accounting_invoice_id || booking.xero_invoice_id;
  if (!skipXeroCreditNote && _invoiceIdForCredit) {
    let creditAmount = totalCost;
    if (refundAllocation && refundAllocation.invoiceAmount !== undefined) {
      const invoiceAlloc = parseFloat(refundAllocation.invoiceAmount);
      if (Number.isFinite(invoiceAlloc) && invoiceAlloc > 0) {
        creditAmount = Math.min(invoiceAlloc, totalCost);
      }
    } else if (effectiveRefundAmount !== null) {
      creditAmount = effectiveRefundAmount;
    }

    if (creditAmount > 0) {
      try {
        const description = xeroDescription
          || (reason === CANCELLATION_REASON_EVENT_DELETED
            ? `Event cancelled by organiser — booking ${booking.booking_reference || booking.id}`
            : `Cancellation of booking ${booking.booking_reference || booking.id} — ${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim());
        const referenceText = xeroReference
          || (reason === CANCELLATION_REASON_EVENT_DELETED
            ? `Event-cancel: ${booking.booking_reference || booking.id}`
            : `Cancel: ${booking.booking_reference || booking.id}`);

        const provider = await getAccountingProvider(tenantId);
        const result = await provider.createCreditNote({
          appTenantId: tenantId,
          invoiceId: booking.accounting_invoice_id || booking.xero_invoice_id,
          creditAmount,
          description,
          reference: referenceText,
        });

        if (result.skipped) {
          reversalResults.xeroCreditNote = {
            success: false,
            skipped: true,
            reason: result.reason,
            amount: creditAmount,
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
          console.log(`${LP} Xero credit note ${result.creditNoteNumber} created for £${result.amount}`);
          if (result.creditNoteId) {
            await supabase
              .from(bookingTable)
              .update(buildCreditNoteColumnUpdate(result))
              .eq('id', booking.id);

            if (creditNoteEmail) {
              try {
                await provider.emailCreditNote({
                  appTenantId: tenantId,
                  creditNoteId: result.creditNoteId,
                  creditNoteNumber: result.creditNoteNumber,
                  toEmail: creditNoteEmail,
                  tenantId,
                });
                reversalResults.xeroCreditNote.emailed = true;
                reversalResults.xeroCreditNote.emailedTo = creditNoteEmail;
              } catch (emailErr) {
                console.error(`${LP} Failed to email credit note to ${creditNoteEmail}:`, emailErr.message);
                reversalResults.xeroCreditNote.emailed = false;
                reversalResults.xeroCreditNote.emailError = emailErr.message;
              }
            }
          }
        }
      } catch (err) {
        const errCreditAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : totalCost;
        console.error(`${LP} Xero credit note error:`, err.message);
        reversalResults.xeroCreditNote = {
          success: false,
          amount: errCreditAmount,
          requiresManualAction: true,
          error: err.message,
          invoiceId: _invoiceIdForCredit,
          invoiceNumber: booking.accounting_invoice_number || booking.xero_invoice_number,
        };
        requiresManualAction = true;
      }
    }
  }

  return { success: true, requiresManualAction, reversalResults };
}

// Backwards-compatible alias used by api/_lib/eventDeletion.js.
export const cancelBookingForEventDeletion = cancelBooking;

/**
 * Send cancellation email to attendee + booker, with wording driven by `reason`.
 * (Used only by the event-deletion flow; the request-driven flow has its own
 * approval/rejection email function in [requestId].js.)
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
  const hasDifferentBookerAttendee = !!(
    attendeeEmail && attendeeEmail.toLowerCase() !== (bookerEmail || '').toLowerCase()
  );

  const recipients = new Set();
  if (attendeeEmail) recipients.add(attendeeEmail.toLowerCase());
  if (bookerEmail && bookerEmail.toLowerCase() !== (attendeeEmail || '').toLowerCase()) {
    recipients.add(bookerEmail.toLowerCase());
  }

  for (const to of recipients) {
    const isBooker = bookerEmail && to === bookerEmail.toLowerCase();
    const recipientName = isBooker ? bookerFirstName : (booking.attendee_first_name || attendeeName);
    const { subject, html } = buildCancellationEmail({
      flow: CANCELLATION_FLOW_EVENT_DELETED,
      isGroup: false,
      eventName,
      recipientName,
      isBooker,
      bookingRef,
      attendeeName,
      hasDifferentBookerAttendee,
      eventDeletedReason: isEventDeleted,
      reversalResults,
      organiserMessage,
    });
    try {
      const inboxDelivery = await buildInboxDelivery({
        tenantId,
        memberId: isBooker ? null : (booking.member_id || null),
        email: to,
        labelKey: 'events',
      });
      await sendEmail({
        to,
        subject,
        html,
        tenantId,
        inboxDelivery,
      });
      console.log(`[EventDeleteCancel] Sent ${reason} email to ${to} | bookingId: ${booking.id}`);
    } catch (err) {
      console.error(`[EventDeleteCancel] Email send failed to ${to}:`, err.message);
    }
  }
}

export { normalizeComplexBooking, BOOKING_SOURCE_COMPLEX };
