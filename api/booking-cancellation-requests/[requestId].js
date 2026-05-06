import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import {
  cancelBooking,
  CANCELLATION_REASON_REQUEST_APPROVED,
} from '../_lib/bookingCancellation.js';
import {
  isComplexSource,
  normalizeComplexBooking,
} from '../_lib/bookingLookup.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
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
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  const { status, review_notes, reversal_options, custom_refund_amount, refund_allocation, credit_note_email, suppress_emails } = req.body;

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('booking_cancellation_request')
      .select('*')
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Cancellation request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been ${request.status}` });
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
      // Effective Stripe refund amount: explicit custom value wins, otherwise
      // honour the allocation breakdown coming from the modal.
      const effectiveRefundAmount = (custom_refund_amount !== undefined && custom_refund_amount !== null)
        ? custom_refund_amount
        : (refund_allocation?.stripeAmount !== undefined ? refund_allocation.stripeAmount : null);
      if (effectiveRefundAmount !== undefined && effectiveRefundAmount !== null) {
        const parsed = parseFloat(effectiveRefundAmount);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'custom_refund_amount must be a positive number' });
        }
      }

      const bookingSource = request.booking_source || 'booking';
      const isComplex = isComplexSource(bookingSource);

      let booking, bookingError;
      if (isComplex) {
        const { data, error } = await supabase
          .from('complex_event_booking')
          .select('*')
          .eq('id', request.booking_id)
          .eq('tenant_id', tenantId)
          .single();
        booking = data ? normalizeComplexBooking(data) : null;
        bookingError = error;
      } else {
        const { data, error } = await supabase
          .from('booking')
          .select('*')
          .eq('id', request.booking_id)
          .eq('tenant_id', tenantId)
          .single();
        booking = data;
        bookingError = error;
      }

      if (bookingError || !booking) {
        return res.status(500).json({ error: 'Failed to process cancellation: Booking not found' });
      }

      const cancellationResult = await cancelBooking({
        booking,
        source: bookingSource,
        tenantId,
        reason: CANCELLATION_REASON_REQUEST_APPROVED,
        refundAllocation: refund_allocation || null,
        reversalOptions: reversal_options || {},
        customRefundAmount: effectiveRefundAmount,
        creditNoteEmail: credit_note_email || null,
        cancellationRequestId: request.id,
      });

      if (!cancellationResult.success) {
        const isValidationError = cancellationResult.error && cancellationResult.error.includes('custom_refund_amount');
        const statusCode = isValidationError ? 400 : 500;
        console.error('[CancellationRequest] Cancellation processing failed:', cancellationResult.error);
        return res.status(statusCode).json({ error: 'Failed to process cancellation: ' + (cancellationResult.error || 'Unknown error') });
      }
      reversalResults = cancellationResult.reversalResults;
    }

    const { data: updated, error: updateError } = await supabase
      .from('booking_cancellation_request')
      .update({
        status,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
        review_notes: review_notes || null,
      })
      .eq('id', requestId)
      .select()
      .single();

    if (updateError) {
      console.error('[CancellationRequest] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request status' });
    }

    if (suppress_emails) {
      console.log(`[CancellationRequest] Notification emails suppressed by reviewer | requestId: ${requestId}`);
    } else {
      try {
        await sendCancellationNotificationEmails({
          request,
          status,
          tenantId,
          reviewNotes: review_notes || null,
          reversalResults,
        });
      } catch (emailErr) {
        console.error('[CancellationRequest] Email notification error (non-blocking):', emailErr.stack || emailErr.message, '| bookingId:', request.booking_id, '| requestId:', requestId);
      }
    }

    return res.json({ request: updated, reversalResults });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function sendCancellationNotificationEmails({ request, status, tenantId, reviewNotes, reversalResults }) {
  const bookingId = request?.booking_id;
  const bookingSource = request?.booking_source || 'booking';
  const isComplex = isComplexSource(bookingSource);
  console.log(`[CancellationEmail] Starting email notification | bookingId: ${bookingId} | status: ${status} | source: ${bookingSource} | member_id: ${request?.member_id || 'null (guest/public)'}`);

  let booking, bookingError;
  if (isComplex) {
    const { data, error } = await supabase
      .from('complex_event_booking')
      .select('attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_paid')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();
    booking = data ? { ...data, total_cost: data.total_paid } : null;
    bookingError = error;
  } else {
    const result = await supabase
      .from('booking')
      .select('attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_cost')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();
    booking = result.data;
    bookingError = result.error;
  }

  if (bookingError || !booking) {
    console.warn(`[CancellationEmail] Booking not found, skipping email | bookingId: ${bookingId} | error: ${bookingError?.message || 'no data'}`);
    return;
  }

  const attendeeEmail = booking.attendee_email;
  console.log(`[CancellationEmail] Booking resolved | attendeeEmail: ${attendeeEmail || 'NONE'} | member_id: ${booking.member_id || 'null'} | ref: ${booking.booking_reference || 'none'}`);

  if (!attendeeEmail && !booking.member_id) {
    console.warn(`[CancellationEmail] No attendee email and no member_id — cannot send notification | bookingId: ${bookingId}`);
    return;
  }

  let eventName = 'your event';
  if (booking.event_id) {
    let event = null;
    const { data: ev } = await supabase
      .from('event')
      .select('title')
      .eq('id', booking.event_id)
      .eq('tenant_id', tenantId)
      .single();
    event = ev;
    if (!event && isComplex) {
      const { data: ce } = await supabase
        .from('complex_event')
        .select('title')
        .eq('id', booking.event_id)
        .single();
      event = ce;
    }
    if (event?.title) eventName = event.title;
  }

  let bookerEmail = null;
  let bookerFirstName = null;
  if (booking.member_id) {
    const { data: member } = await supabase
      .from('member')
      .select('email, first_name')
      .eq('id', booking.member_id)
      .eq('tenant_id', tenantId)
      .single();
    if (member) {
      bookerEmail = member.email;
      bookerFirstName = member.first_name;
    }
  }

  const attendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';
  const bookingRef = booking.booking_reference || booking.booking_group_reference || '';
  const isApproved = status === 'approved';

  const subject = isApproved
    ? `Booking Cancellation Confirmed — ${eventName}`
    : `Booking Cancellation Request Rejected — ${eventName}`;

  const financialLines = [];
  if (isApproved && reversalResults) {
    const rr = reversalResults;
    if (rr.trainingFund?.success) {
      financialLines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
    }
    for (const v of rr.vouchers || []) {
      if (v.reinstated) financialLines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
      if (v.replacementCreated) {
        const replacement = reversalResults.replacements?.find(r => r.type === 'voucher' && r.newCode === v.newVoucherCode);
        const expiryText = replacement?.expiryDate ? ` (expires ${replacement.expiryDate})` : '';
        financialLines.push(`Replacement voucher ${v.newVoucherCode} issued${expiryText}`);
      }
    }
    if (rr.discountCode?.reversed) {
      financialLines.push(`Discount code ${rr.discountCode.code} usage reversed`);
    }
    if (rr.discountCode?.replacementCreated) {
      financialLines.push(`Replacement discount code ${rr.discountCode.newCode} issued`);
    }
    if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
      financialLines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
    }
    if (rr.xeroCreditNote?.success) {
      financialLines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
    }
  }

  const buildEmailHtml = (recipientName, isBooker) => {
    const safeName = recipientName || 'there';
    let body = '';

    if (isApproved) {
      if (isBooker) {
        body += `<p>Hi ${safeName},</p>`;
        body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
      } else {
        body += `<p>Hi ${safeName},</p>`;
        body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled as requested.</p>`;
      }

      if (bookingRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
      }

      if (financialLines.length > 0) {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
        body += `<p style="margin: 0 0 10px 0; font-weight: 600; color: #333;">Financial Summary</p>`;
        body += `<ul style="margin: 0; padding-left: 20px; color: #555;">`;
        for (const line of financialLines) {
          body += `<li style="margin-bottom: 6px;">${line}</li>`;
        }
        body += `</ul>`;
        body += `</div>`;
      }

      body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
    } else {
      body += `<p>Hi ${safeName},</p>`;

      if (isBooker) {
        body += `<p>A cancellation request for a booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      } else {
        body += `<p>Your cancellation request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      }

      if (bookingRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
      }

      if (reviewNotes) {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
        body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
        body += `<p style="margin: 0; color: #555;">${String(reviewNotes).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
        body += `</div>`;
      }

      body += `<p style="color: #666; font-size: 14px;">Your booking remains active. If you have any questions, please get in touch.</p>`;
    }

    return body;
  };

  if (attendeeEmail) {
    try {
      console.log(`[CancellationEmail] Sending ${status} email to attendee: ${attendeeEmail} | bookingId: ${bookingId}`);
      const result = await sendEmail({
        to: attendeeEmail,
        subject,
        html: buildEmailHtml(booking.attendee_first_name || attendeeName, false),
        tenantId,
      });
      if (result?.success) {
        console.log(`[CancellationEmail] Sent ${status} notification to attendee: ${attendeeEmail}`);
      } else {
        console.error(`[CancellationEmail] Failed to email attendee ${attendeeEmail} | bookingId: ${bookingId} | error: ${result?.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(`[CancellationEmail] Exception emailing attendee ${attendeeEmail} | bookingId: ${bookingId}:`, err.stack || err.message);
    }
  } else {
    console.warn(`[CancellationEmail] No attendee email on booking | bookingId: ${bookingId}`);
  }

  if (bookerEmail && bookerEmail.toLowerCase() !== (attendeeEmail || '').toLowerCase()) {
    try {
      console.log(`[CancellationEmail] Sending ${status} email to booker: ${bookerEmail} | bookingId: ${bookingId}`);
      const result = await sendEmail({
        to: bookerEmail,
        subject,
        html: buildEmailHtml(bookerFirstName || 'there', true),
        tenantId,
      });
      if (result?.success) {
        console.log(`[CancellationEmail] Sent ${status} notification to booker: ${bookerEmail}`);
      } else {
        console.error(`[CancellationEmail] Failed to email booker ${bookerEmail} | bookingId: ${bookingId} | error: ${result?.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(`[CancellationEmail] Exception emailing booker ${bookerEmail} | bookingId: ${bookingId}:`, err.stack || err.message);
    }
  }

  console.log(`[CancellationEmail] Notification process complete | bookingId: ${bookingId}`);
}
