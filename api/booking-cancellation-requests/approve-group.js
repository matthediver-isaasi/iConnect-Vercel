import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { getAccountingProvider, buildCreditNoteColumnUpdate } from '../_lib/accountingProvider.js';
import { sendEmail } from '../_lib/emailService.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import {
  buildCancellationEmail,
  CANCELLATION_FLOW_REQUEST_APPROVED,
  CANCELLATION_FLOW_REQUEST_REJECTED,
} from '../_lib/cancellationEmail.js';
import { cancelZoomRegistrant, resolveEventZoomWebinar } from '../_lib/zoomClient.js';
import Stripe from 'stripe';
import {
  isComplexSource,
  normalizeComplexBooking,
  getBookingTable,
  restoreComplexEventSeatsMultiple,
  cancelComplexEventZoomRegistrationsMultiple,
  reinstateVoucherDirect,
  reinstateVoucherFromTransactions,
} from '../_lib/bookingLookup.js';
import {
  cancelBooking,
  CANCELLATION_REASON_REQUEST_APPROVED,
} from '../_lib/bookingCancellation.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  if (!(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Admin access required to approve or reject requests' });
  }

  const tenantId = ctx.tenantId;
  const { request_ids, status, review_notes, reversal_options, custom_refund_amount, credit_note_email, suppress_emails, refund_allocation } = req.body;

  if (!request_ids || !Array.isArray(request_ids) || request_ids.length === 0) {
    return res.status(400).json({ error: 'request_ids is required and must be a non-empty array' });
  }

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const { data: pendingRequests, error: fetchError } = await supabase
      .from('booking_cancellation_request')
      .select('*')
      .in('id', request_ids)
      .eq('tenant_id', tenantId)
      .eq('status', 'pending');

    if (fetchError) {
      console.error('[GroupApproval] Error fetching requests:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch cancellation requests' });
    }

    if (!pendingRequests || pendingRequests.length === 0) {
      return res.status(404).json({ error: 'No pending cancellation requests found' });
    }

    if (pendingRequests.length !== request_ids.length) {
      const foundIds = new Set(pendingRequests.map(r => r.id));
      const missing = request_ids.filter(id => !foundIds.has(id));
      return res.status(400).json({ error: `Some requests are not pending or not found: ${missing.join(', ')}` });
    }

    const groupRefs = [...new Set(pendingRequests.map(r => r.booking_group_reference).filter(Boolean))];
    if (groupRefs.length === 0) {
      return res.status(400).json({ error: 'All requests must have a booking_group_reference for group approval' });
    }
    if (groupRefs.length > 1) {
      return res.status(400).json({ error: `All requests must belong to the same booking group. Found multiple group references: ${groupRefs.join(', ')}` });
    }

    const bookingSources = [...new Set(pendingRequests.map(r => r.booking_source || 'booking'))];
    if (bookingSources.length > 1) {
      return res.status(400).json({ error: 'All requests in a group must have the same booking source. Cannot mix regular and complex event bookings.' });
    }

    let reviewerName = 'Admin';
    if (ctx.tenantUserId) {
      const { data: tu } = await supabase.from('tenant_user').select('email, name').eq('id', ctx.tenantUserId).single();
      if (tu) reviewerName = tu.email || tu.name || 'Admin';
    } else if (ctx.memberId) {
      const { data: m } = await supabase.from('member').select('email, first_name, last_name').eq('id', ctx.memberId).single();
      if (m) reviewerName = m.email || [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Admin';
    }
    let reversalResults = null;

    if (status === 'approved') {
      if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
        const parsed = parseFloat(custom_refund_amount);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'custom_refund_amount must be a positive number' });
        }
      }
      const reversalOptions = reversal_options || {};
      const effectiveCustomRefund = refund_allocation?.stripeAmount ?? custom_refund_amount;
      const result = await processGroupCancellation(pendingRequests, tenantId, reversalOptions, effectiveCustomRefund, credit_note_email, refund_allocation);
      if (!result.success) {
        const isValidationError = result.error && result.error.includes('custom_refund_amount');
        const statusCode = isValidationError ? 400 : 500;
        console.error('[GroupApproval] Group cancellation processing failed:', result.error);
        return res.status(statusCode).json({ error: 'Failed to process group cancellation: ' + (result.error || 'Unknown error') });
      }
      reversalResults = result.reversalResults;
    }

    const { data: updatedRows, error: updateError } = await supabase
      .from('booking_cancellation_request')
      .update({
        status,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
        review_notes: review_notes || null,
      })
      .in('id', request_ids)
      .eq('tenant_id', tenantId)
      .eq('status', 'pending')
      .select('id');

    if (updateError) {
      console.error('[GroupApproval] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request statuses' });
    }

    if (!updatedRows || updatedRows.length !== request_ids.length) {
      console.warn(`[GroupApproval] Expected to update ${request_ids.length} requests but only ${updatedRows?.length || 0} were still pending — possible concurrent approval`);
    }

    if (suppress_emails) {
      console.log(`[GroupApproval] Notification emails suppressed by reviewer for ${pendingRequests.length} request(s)`);
    } else {
      try {
        await sendGroupNotificationEmails({
          requests: pendingRequests,
          status,
          tenantId,
          reviewNotes: review_notes || null,
          reversalResults,
        });
      } catch (emailErr) {
        console.error('[GroupApproval] Email notification error (non-blocking):', emailErr.stack || emailErr.message, '| requestIds:', request_ids);
      }
    }

    console.log(`[GroupApproval] ${status} ${pendingRequests.length} group cancellation request(s)`);
    return res.json({ success: true, count: pendingRequests.length, reversalResults });
  } catch (err) {
    console.error('[GroupApproval] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Group cancellation orchestrator.
 *
 * Per-booking side-effects (status flip, training fund, program ticket
 * refunds) are run through the shared cancelBooking engine in
 * api/_lib/bookingCancellation.js so they stay in lock-step with the
 * single-booking and event-deletion flows. Steps that have to be consolidated
 * to one external call for the whole group — Stripe refund, Xero credit
 * note, voucher reinstatement, discount-code decrement, seat restore, Zoom
 * unregister — are skipped at the per-booking level and handled here once.
 */
async function processGroupCancellation(requests, tenantId, reversalOptions = {}, custom_refund_amount = null, credit_note_email = null, refund_allocation = null) {
  const reversalResults = {
    trainingFund: [],
    vouchers: [],
    discountCode: null,
    programTickets: [],
    stripeRefund: null,
    xeroCreditNote: null,
    replacements: [],
  };

  try {
    const bookingIds = requests.map(r => r.booking_id);
    const bookingSource = requests[0].booking_source || 'booking';
    const isComplex = isComplexSource(bookingSource);
    const bookingTable = getBookingTable(bookingSource);

    let bookings, bookingsError;
    if (isComplex) {
      const { data, error } = await supabase
        .from('complex_event_booking')
        .select('*')
        .in('id', bookingIds)
        .eq('tenant_id', tenantId);
      bookings = (data || []).map(normalizeComplexBooking);
      bookingsError = error;
    } else {
      const { data, error } = await supabase
        .from('booking')
        .select('*')
        .in('id', bookingIds)
        .eq('tenant_id', tenantId);
      bookings = data;
      bookingsError = error;
    }

    if (bookingsError || !bookings || bookings.length === 0) {
      return { success: false, error: 'Failed to fetch bookings for group' };
    }

    const orgIds = [...new Set(bookings.map(b => b.organization_id).filter(Boolean))];
    if (orgIds.length > 1) {
      return { success: false, error: 'All bookings in a group must belong to the same organization' };
    }

    const stripeIntents = [...new Set(bookings.map(b => b.stripe_payment_intent_id).filter(Boolean))];
    if (stripeIntents.length > 1) {
      return { success: false, error: `Group bookings have multiple Stripe payment intents (${stripeIntents.length}). Cannot process consolidated refund — use individual approval.` };
    }

    const xeroInvoices = [...new Set(bookings.map(b => b.accounting_invoice_id || b.xero_invoice_id).filter(Boolean))];
    if (xeroInvoices.length > 1) {
      return { success: false, error: `Group bookings have multiple Xero invoices (${xeroInvoices.length}). Cannot process consolidated credit note — use individual approval.` };
    }

    const firstBooking = bookings[0];
    const organizationId = firstBooking.organization_id;
    const groupRef = firstBooking.booking_group_reference || firstBooking.booking_reference;
    const groupRequestIds = requests.map(r => r.id).sort().join('-');

    // Pre-compute pro-rated training-fund allocation per booking. The shared
    // engine accepts a per-booking trainingFundAmount cap; we apportion the
    // group-level allocation across bookings by their original training-fund
    // share so the totals add up to refund_allocation.trainingFundAmount.
    const totalTrainingFundFromBookings = bookings.reduce((sum, b) => sum + (parseFloat(b.training_fund_amount) || 0), 0);
    let trainingFundRatio = null;
    if (refund_allocation && refund_allocation.trainingFundAmount !== undefined) {
      const allocatedTotal = parseFloat(refund_allocation.trainingFundAmount) || 0;
      if (allocatedTotal <= 0) {
        trainingFundRatio = 0;
      } else if (totalTrainingFundFromBookings > 0 && allocatedTotal < totalTrainingFundFromBookings) {
        trainingFundRatio = allocatedTotal / totalTrainingFundFromBookings;
      }
    }

    const newlyCancelledBookings = [];
    for (const booking of bookings) {
      if (booking.status === 'cancelled') {
        console.log(`[GroupApproval] Booking ${booking.id} already cancelled, skipping`);
        continue;
      }

      // Per-booking training-fund cap derived from the group allocation.
      let perBookingAllocation = null;
      if (trainingFundRatio !== null && parseFloat(booking.training_fund_amount) > 0) {
        const perBooking = trainingFundRatio === 0
          ? 0
          : Math.round((parseFloat(booking.training_fund_amount) || 0) * trainingFundRatio * 100) / 100;
        perBookingAllocation = { trainingFundAmount: perBooking };
      }

      const result = await cancelBooking({
        booking,
        source: bookingSource,
        tenantId,
        reason: CANCELLATION_REASON_REQUEST_APPROVED,
        refundAllocation: perBookingAllocation,
        reversalOptions,
        cancellationRequestId: requests.find(r => r.booking_id === booking.id)?.id || null,
        // Group level handles all of these consolidated steps below.
        skipStripeRefund: true,
        skipXeroCreditNote: true,
        skipDiscountCodeReversal: true,
        skipVoucherReinstatement: true,
        skipSeatRestore: true,
        skipZoomCancel: true,
      });

      if (!result.success) {
        return { success: false, error: `Failed to cancel booking ${booking.id}: ${result.error}` };
      }

      const tf = result.reversalResults?.trainingFund;
      if (tf) {
        reversalResults.trainingFund.push({ bookingId: booking.id, ...tf });
      }
      const pt = result.reversalResults?.programTicket;
      if (pt) {
        reversalResults.programTickets.push({ bookingId: booking.id, ...pt });
      }
      newlyCancelledBookings.push(booking);
    }

    // --- Restore available seats (consolidated for the whole group) ---
    if (newlyCancelledBookings.length > 0 && firstBooking.event_id) {
      if (isComplex) {
        try {
          await restoreComplexEventSeatsMultiple(newlyCancelledBookings, newlyCancelledBookings.length);
        } catch (err) {
          console.error(`[GroupApproval] Complex event seat restoration error (non-blocking):`, err.message);
        }
      } else {
        try {
          const { data: eventForSeats } = await supabase
            .from('event')
            .select('id, available_seats, is_unlimited_registration')
            .eq('id', firstBooking.event_id)
            .single();

          if (eventForSeats && eventForSeats.available_seats !== null && eventForSeats.available_seats !== undefined && !eventForSeats.is_unlimited_registration) {
            const { data: newSeatCount, error: rpcError } = await supabase
              .rpc('adjust_event_seats', { p_event_id: firstBooking.event_id, p_delta: newlyCancelledBookings.length });

            if (rpcError) {
              console.error(`[GroupApproval] RPC seat increment failed:`, rpcError.message);
              const newCount = eventForSeats.available_seats + newlyCancelledBookings.length;
              await supabase.from('event').update({ available_seats: newCount }).eq('id', firstBooking.event_id);
              console.log(`[GroupApproval] Fallback: Incremented seats by ${newlyCancelledBookings.length} to ${newCount}`);
            } else {
              console.log(`[GroupApproval] Seats restored by ${newlyCancelledBookings.length}, new count: ${newSeatCount}`);
            }
          }
        } catch (err) {
          console.error(`[GroupApproval] Seat restoration error (non-blocking):`, err.message);
        }
      }
    }

    // --- Cancel Zoom registrants (consolidated for the whole group) ---
    if (newlyCancelledBookings.length > 0 && firstBooking.event_id) {
      if (isComplex) {
        try {
          await cancelComplexEventZoomRegistrationsMultiple(newlyCancelledBookings, tenantId);
        } catch (err) {
          console.error(`[GroupApproval] Complex event Zoom cancellation error (non-blocking):`, err.message);
        }
      } else {
        try {
          const { data: eventForZoom } = await supabase
            .from('event')
            .select('id, zoom_webinar_id, location, backstage_event_id')
            .eq('id', firstBooking.event_id)
            .single();

          if (eventForZoom) {
            const webinar = await resolveEventZoomWebinar(eventForZoom);
            if (webinar && webinar.zoom_webinar_id) {
              for (const booking of newlyCancelledBookings) {
                if (booking.attendee_email) {
                  try {
                    await cancelZoomRegistrant(tenantId, webinar.zoom_webinar_id, booking.attendee_email);
                    console.log(`[GroupApproval] Zoom registrant cancelled for ${booking.attendee_email}`);
                  } catch (zoomErr) {
                    console.error(`[GroupApproval] Zoom cancellation error for ${booking.attendee_email} (non-blocking):`, zoomErr.message);
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error(`[GroupApproval] Zoom registrant cancellation error (non-blocking):`, err.message);
        }
      }
    }

    // --- Voucher reinstatement (single call for the whole group) ---
    const hasVoucher = bookings.some(b => parseFloat(b.voucher_amount) > 0);
    if (hasVoucher) {
      try {
        if (isComplex) {
          const bookingWithVoucher = bookings.find(b => b.voucher_id && parseFloat(b.voucher_amount) > 0);
          if (bookingWithVoucher) {
            await reinstateVoucherDirect(bookingWithVoucher, refund_allocation, reversalOptions, reversalResults, tenantId);
          }
        } else {
          await reinstateVoucherFromTransactions(firstBooking, refund_allocation, reversalOptions, reversalResults, tenantId);
        }
      } catch (err) {
        console.error('[GroupApproval] Voucher reinstatement error:', err);
      }
    }

    // --- Discount code reversal (single decrement for the whole group) ---
    const firstBookingWithDiscount = bookings.find(b => b.discount_code_id && parseFloat(b.discount_code_amount) > 0);
    if (firstBookingWithDiscount) {
      try {
        const { data: discountCode } = await supabase
          .from('discount_code')
          .select('*')
          .eq('id', firstBookingWithDiscount.discount_code_id)
          .single();

        if (discountCode) {
          const isExpired = discountCode.expires_at && new Date(discountCode.expires_at) < new Date();

          if (!isExpired) {
            await supabase
              .from('discount_code')
              .update({ current_usage_count: Math.max(0, (discountCode.current_usage_count || 1) - 1) })
              .eq('id', discountCode.id);

            if (organizationId) {
              const { data: usage } = await supabase
                .from('discount_code_usage')
                .select('id, usage_count')
                .eq('discount_code_id', discountCode.id)
                .eq('organization_id', organizationId)
                .maybeSingle();

              if (usage && usage.usage_count > 0) {
                await supabase
                  .from('discount_code_usage')
                  .update({ usage_count: usage.usage_count - 1 })
                  .eq('id', usage.id);
              }
            }

            reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: true, reversed: true };
            console.log(`[GroupApproval] Discount code ${discountCode.code} usage decremented`);
          } else {
            const replacementOption = reversalOptions.discountCodeReplacement;
            if (replacementOption && replacementOption.newExpiryDate) {
              const newCode = `REFUND-${discountCode.code}-${Date.now().toString(36).toUpperCase()}`;
              const { data: newDC, error: createErr } = await supabase
                .from('discount_code')
                .insert({
                  code: newCode,
                  type: discountCode.type,
                  value: discountCode.value,
                  description: `Replacement for expired code ${discountCode.code} (group cancellation of ${groupRef})`,
                  is_active: true,
                  expires_at: replacementOption.newExpiryDate,
                  max_usage_count: 1,
                  current_usage_count: 0,
                  organization_id: organizationId || null,
                  tenant_id: tenantId
                })
                .select()
                .single();

              if (createErr) {
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: false, expired: true, error: 'Failed to create replacement: ' + createErr.message };
              } else {
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: true, expired: true, replacementCreated: true, newCode: newDC.code, newCodeId: newDC.id };
                reversalResults.replacements.push({ type: 'discount_code', originalCode: discountCode.code, newCode: newDC.code, value: discountCode.value, discountType: discountCode.type, expiryDate: replacementOption.newExpiryDate });
                console.log(`[GroupApproval] Replacement discount code ${newCode} created for expired ${discountCode.code}`);
              }
            } else {
              reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: false, expired: true, skipped: true };
            }
          }
        }
      } catch (err) {
        console.error('[GroupApproval] Discount code reversal error:', err);
        reversalResults.discountCode = { success: false, error: err.message };
      }
    }

    // --- Consolidated Stripe refund (one refund covering the whole group) ---
    let totalCardAmount = 0;
    let stripePaymentIntentId = null;

    for (const booking of bookings) {
      if (booking.stripe_payment_intent_id && booking.payment_method === 'card') {
        const totalCost = parseFloat(booking.total_cost) || 0;
        const trainingFundAmt = parseFloat(booking.training_fund_amount) || 0;
        const voucherAmt = parseFloat(booking.voucher_amount) || 0;
        const discountAmt = parseFloat(booking.discount_code_amount) || 0;
        const accountAmt = parseFloat(booking.account_amount) || 0;
        const cardAmount = Math.max(0, totalCost - trainingFundAmt - voucherAmt - discountAmt - accountAmt);
        totalCardAmount += cardAmount;
        if (!stripePaymentIntentId) {
          stripePaymentIntentId = booking.stripe_payment_intent_id;
        }
      }
    }

    const totalGroupCost = bookings.reduce((sum, b) => sum + (parseFloat(b.total_cost) || 0), 0);
    let effectiveRefundAmount = null;
    if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
      const customAmt = parseFloat(custom_refund_amount);
      if (!Number.isFinite(customAmt) || customAmt <= 0) {
        return { success: false, error: 'custom_refund_amount must be a positive number' };
      }
      const maxAllowed = Math.min(totalCardAmount > 0 ? totalCardAmount : Infinity, totalGroupCost > 0 ? totalGroupCost : Infinity);
      if (customAmt > maxAllowed) {
        return { success: false, error: `custom_refund_amount (${customAmt}) exceeds maximum refundable amount (${maxAllowed.toFixed(2)})` };
      }
      effectiveRefundAmount = customAmt;
    }

    const effectiveCardAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : totalCardAmount;

    if (stripePaymentIntentId && effectiveCardAmount > 0) {
      try {
        const creds = await getStripeCredentials(tenantId, 'events');
        if (!creds || !creds.secret_key || !creds.is_enabled) {
          reversalResults.stripeRefund = {
            success: false,
            amount: effectiveCardAmount,
            requiresManualRefund: true,
            error: !creds?.is_enabled ? 'Stripe integration is disabled for this tenant' : 'Stripe not configured for this tenant',
          };
          console.warn(`[GroupApproval] Stripe not available — manual refund needed for £${totalCardAmount}`);
        } else {
          const stripe = new Stripe(creds.secret_key);
          const refundAmountPence = Math.round(effectiveCardAmount * 100);

          const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
          const amountReceived = paymentIntent.amount_received || 0;
          const existingRefunds = await stripe.refunds.list({ payment_intent: stripePaymentIntentId, limit: 100 });
          const amountRefunded = existingRefunds.data.reduce((sum, r) => sum + (r.status !== 'failed' ? r.amount : 0), 0);
          const refundableAmount = amountReceived - amountRefunded;

          if (refundableAmount <= 0) {
            reversalResults.stripeRefund = {
              success: true,
              amount: effectiveCardAmount,
              alreadyRefunded: true,
              paymentIntentId: stripePaymentIntentId,
            };
            console.log(`[GroupApproval] PaymentIntent ${stripePaymentIntentId} already fully refunded`);
          } else {
            const actualRefundPence = Math.min(refundAmountPence, refundableAmount);
            const idempotencyKey = `cancel-group-refund-${groupRef || groupRequestIds}`;
            const refund = await stripe.refunds.create({
              payment_intent: stripePaymentIntentId,
              amount: actualRefundPence,
              reason: 'requested_by_customer',
              metadata: {
                booking_group_reference: groupRef || '',
                booking_count: String(bookings.length),
                cancellation_request_ids: requests.map(r => r.id).join(','),
              },
            }, {
              idempotencyKey,
            });

            const actualRefundAmount = actualRefundPence / 100;
            reversalResults.stripeRefund = {
              success: true,
              amount: actualRefundAmount,
              refundId: refund.id,
              status: refund.status,
              paymentIntentId: stripePaymentIntentId,
              partialRefund: actualRefundPence < refundAmountPence,
              consolidated: true,
              bookingCount: bookings.length,
            };
            console.log(`[GroupApproval] Consolidated Stripe refund ${refund.id}: £${actualRefundAmount} for ${bookings.length} bookings`);
          }
        }
      } catch (err) {
        console.error('[GroupApproval] Stripe refund error:', err.message);
        reversalResults.stripeRefund = {
          success: false,
          amount: effectiveCardAmount,
          requiresManualRefund: true,
          error: err.message,
          paymentIntentId: stripePaymentIntentId,
        };
      }
    }

    // --- Consolidated Xero credit note (one credit note for the group) ---
    const bookingsWithXero = bookings.filter(b => b.accounting_invoice_id || b.xero_invoice_id);
    if (bookingsWithXero.length > 0) {
      try {
        const xeroInvoiceId = bookingsWithXero[0].accounting_invoice_id || bookingsWithXero[0].xero_invoice_id;
        const bookingsForThisInvoice = bookings.filter(b => (b.accounting_invoice_id || b.xero_invoice_id) === xeroInvoiceId);
        const fullCreditAmount = bookingsForThisInvoice.reduce((sum, b) => sum + (parseFloat(b.total_cost) || 0), 0);
        let totalCreditAmount = fullCreditAmount;
        if (refund_allocation && refund_allocation.invoiceAmount !== undefined) {
          const invoiceAlloc = parseFloat(refund_allocation.invoiceAmount);
          if (Number.isFinite(invoiceAlloc) && invoiceAlloc > 0) {
            totalCreditAmount = Math.min(invoiceAlloc, fullCreditAmount);
          }
        } else if (effectiveRefundAmount !== null) {
          totalCreditAmount = effectiveRefundAmount;
        }

        if (totalCreditAmount > 0) {
          const xeroBooking = bookingsWithXero[0];
          const attendeeNames = bookings
            .map(b => [b.attendee_first_name, b.attendee_last_name].filter(Boolean).join(' '))
            .filter(Boolean);
          const uniqueNames = [...new Set(attendeeNames)];
          const namesText = uniqueNames.length > 3
            ? `${uniqueNames.slice(0, 3).join(', ')} +${uniqueNames.length - 3} more`
            : uniqueNames.join(', ');

          const provider = await getAccountingProvider(tenantId);
          const result = await provider.createCreditNote({
            appTenantId: tenantId,
            invoiceId: xeroBooking.accounting_invoice_id || xeroBooking.xero_invoice_id,
            creditAmount: totalCreditAmount,
            description: `Group cancellation of ${bookings.length} tickets (${groupRef || 'group'}) — ${namesText}`.trim(),
            reference: `Cancel-Group: ${groupRef || groupRequestIds}`,
          });

          if (result.skipped) {
            reversalResults.xeroCreditNote = {
              success: false,
              skipped: true,
              reason: result.reason,
              amount: totalCreditAmount,
              invoiceNumber: result.invoiceNumber,
              requiresManualAction: true,
            };
            console.log(`[GroupApproval] Xero credit note skipped: ${result.reason}`);
          } else {
            reversalResults.xeroCreditNote = {
              success: true,
              amount: result.amount,
              creditNoteId: result.creditNoteId,
              creditNoteNumber: result.creditNoteNumber,
              allocated: result.allocated,
              invoiceNumber: result.invoiceNumber,
              alreadyExisted: result.alreadyExisted || false,
              consolidated: true,
              bookingCount: bookings.length,
            };
            console.log(`[GroupApproval] Consolidated Xero credit note ${result.creditNoteNumber}: £${result.amount} for ${bookings.length} bookings`);

            if (result.creditNoteId) {
              for (const booking of bookings) {
                const { error: cnUpdateError } = await supabase
                  .from(bookingTable)
                  .update(buildCreditNoteColumnUpdate(result))
                  .eq('id', booking.id);

                if (cnUpdateError) {
                  console.warn(`[GroupApproval] Failed to store credit note on booking ${booking.id}: ${cnUpdateError.message}`);
                }
              }

              if (credit_note_email) {
                try {
                  await provider.emailCreditNote({
                    appTenantId: tenantId,
                    creditNoteId: result.creditNoteId,
                    creditNoteNumber: result.creditNoteNumber,
                    toEmail: credit_note_email,
                    tenantId,
                  });
                  reversalResults.xeroCreditNote.emailed = true;
                  reversalResults.xeroCreditNote.emailedTo = credit_note_email;
                } catch (emailErr) {
                  console.error(`[GroupApproval] Failed to email credit note to ${credit_note_email}:`, emailErr.message);
                  reversalResults.xeroCreditNote.emailed = false;
                  reversalResults.xeroCreditNote.emailError = emailErr.message;
                }
              }
            }
          }
        }
      } catch (err) {
        const errCreditAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : totalGroupCost;
        console.error('[GroupApproval] Xero credit note error:', err.message);
        reversalResults.xeroCreditNote = {
          success: false,
          amount: errCreditAmount,
          requiresManualAction: true,
          error: err.message,
        };
      }
    }

    return { success: true, reversalResults };
  } catch (err) {
    console.error('[GroupApproval] Error processing group cancellation:', err);
    return { success: false, error: err.message };
  }
}

async function sendGroupNotificationEmails({ requests, status, tenantId, reviewNotes, reversalResults }) {
  if (!requests || requests.length === 0) return;

  const firstRequest = requests[0];
  const bookingIds = requests.map(r => r.booking_id);
  const bookingSource = firstRequest.booking_source || 'booking';
  const isComplex = isComplexSource(bookingSource);

  let bookings;
  if (isComplex) {
    const { data } = await supabase
      .from('complex_event_booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_paid')
      .in('id', bookingIds)
      .eq('tenant_id', tenantId);
    bookings = (data || []).map(b => ({ ...b, total_cost: b.total_paid }));
  } else {
    const { data } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_cost')
      .in('id', bookingIds)
      .eq('tenant_id', tenantId);
    bookings = data;
  }

  if (!bookings || bookings.length === 0) {
    console.warn('[GroupNotification] No bookings found, skipping emails');
    return;
  }

  const groupRef = bookings[0].booking_group_reference || bookings[0].booking_reference || '';

  let eventName = 'your event';
  const eventId = bookings[0].event_id || firstRequest.event_id;
  if (eventId) {
    let event = null;
    const { data: ev } = await supabase
      .from('event')
      .select('title')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .single();
    event = ev;
    if (!event && isComplex) {
      const { data: ce } = await supabase
        .from('complex_event')
        .select('title')
        .eq('id', eventId)
        .single();
      event = ce;
    }
    if (event?.title) eventName = event.title;
  }

  let bookerEmail = null;
  let bookerFirstName = null;
  const memberId = firstRequest.member_id;
  if (memberId) {
    const { data: member } = await supabase
      .from('member')
      .select('email, first_name')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();
    if (member) {
      bookerEmail = member.email;
      bookerFirstName = member.first_name;
    }
  }

  const isApproved = status === 'approved';
  const flow = isApproved ? CANCELLATION_FLOW_REQUEST_APPROVED : CANCELLATION_FLOW_REQUEST_REJECTED;
  const ticketCount = bookings.length;
  const attendeeNames = bookings
    .map(b => [b.attendee_first_name, b.attendee_last_name].filter(Boolean).join(' '))
    .filter(Boolean);
  const uniqueNames = [...new Set(attendeeNames)];

  const buildForRecipient = (recipientName, isBooker) => buildCancellationEmail({
    flow,
    isGroup: true,
    eventName,
    recipientName: recipientName || 'there',
    isBooker,
    bookingRef: groupRef,
    ticketCount,
    uniqueAttendeeNames: uniqueNames,
    reversalResults: isApproved ? reversalResults : null,
    reviewNotes,
  });

  const sentEmails = new Set();

  if (bookerEmail) {
    try {
      const { subject, html } = buildForRecipient(bookerFirstName || 'there', true);
      const inboxDelivery = await buildInboxDelivery({
        tenantId,
        email: bookerEmail,
        labelKey: 'events',
      });
      const result = await sendEmail({
        to: bookerEmail,
        subject,
        html,
        tenantId,
        inboxDelivery,
      });
      if (result?.success) {
        sentEmails.add(bookerEmail.toLowerCase());
        console.log(`[GroupNotification] Sent ${status} notification to booker: ${bookerEmail}`);
      }
    } catch (err) {
      console.error(`[GroupNotification] Failed to email booker ${bookerEmail}:`, err.message);
    }
  }

  for (const booking of bookings) {
    const attendeeEmail = booking.attendee_email;
    if (!attendeeEmail || sentEmails.has(attendeeEmail.toLowerCase())) continue;

    try {
      const { subject, html } = buildForRecipient(booking.attendee_first_name || 'there', false);
      const inboxDelivery = await buildInboxDelivery({
        tenantId,
        memberId: booking.member_id || null,
        email: attendeeEmail,
        labelKey: 'events',
      });
      const result = await sendEmail({
        to: attendeeEmail,
        subject,
        html,
        tenantId,
        inboxDelivery,
      });
      if (result?.success) {
        sentEmails.add(attendeeEmail.toLowerCase());
        console.log(`[GroupNotification] Sent ${status} notification to attendee: ${attendeeEmail}`);
      }
    } catch (err) {
      console.error(`[GroupNotification] Failed to email attendee ${attendeeEmail}:`, err.message);
    }
  }
}
