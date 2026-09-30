import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import {
  buildCancellationEmail,
  CANCELLATION_FLOW_REQUEST_APPROVED,
  CANCELLATION_FLOW_REQUEST_REJECTED,
} from '../_lib/cancellationEmail.js';
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

  // event_name = deleted-event title snapshot (task #3344); 42703 retry keeps
  // stale environments without the column working.
  let booking, bookingError;
  if (isComplex) {
    const cols = 'attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_paid';
    let { data, error } = await supabase
      .from('complex_event_booking')
      .select(cols + ', event_name')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();
    if (error && error.code === '42703') {
      ({ data, error } = await supabase.from('complex_event_booking').select(cols).eq('id', bookingId).eq('tenant_id', tenantId).single());
    }
    booking = data ? { ...data, total_cost: data.total_paid } : null;
    bookingError = error;
  } else {
    const cols = 'attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_cost';
    let result = await supabase
      .from('booking')
      .select(cols + ', event_name')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .single();
    if (result.error && result.error.code === '42703') {
      result = await supabase.from('booking').select(cols).eq('id', bookingId).eq('tenant_id', tenantId).single();
    }
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
  // Event row hard-deleted (task #3344): fall back to the snapshotted title.
  if (eventName === 'your event' && booking.event_name) eventName = booking.event_name;

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
  const flow = isApproved ? CANCELLATION_FLOW_REQUEST_APPROVED : CANCELLATION_FLOW_REQUEST_REJECTED;

  const buildForRecipient = (recipientName, isBooker) => buildCancellationEmail({
    flow,
    isGroup: false,
    eventName,
    recipientName,
    isBooker,
    bookingRef,
    attendeeName,
    reversalResults: isApproved ? reversalResults : null,
    reviewNotes,
  });

  if (attendeeEmail) {
    try {
      console.log(`[CancellationEmail] Sending ${status} email to attendee: ${attendeeEmail} | bookingId: ${bookingId}`);
      const { subject, html } = buildForRecipient(booking.attendee_first_name || attendeeName, false);
      const result = await sendEmail({
        to: attendeeEmail,
        subject,
        html,
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
      const { subject, html } = buildForRecipient(bookerFirstName || 'there', true);
      const result = await sendEmail({
        to: bookerEmail,
        subject,
        html,
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
