import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { getAccountingProvider } from '../_lib/accountingProvider.js';
import { sendConfirmationEmailsFromTemplate } from '../_lib/eventConfirmationEmail.js';
import { cancelZoomRegistrant, registerZoomWebinarAttendee, resolveEventZoomWebinar } from '../_lib/zoomClient.js';
import { BOOKING_SOURCE_COMPLEX, isComplexSource, normalizeComplexBooking, getBookingTable, swapComplexEventZoomRegistrations } from '../_lib/bookingLookup.js';

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
    return res.status(401).json({ error: 'Authentication required' });
  }

  let hasTransferAccess = false;
  if (ctx.tenantUserId) {
    hasTransferAccess = true;
  } else if (ctx.roleId) {
    hasTransferAccess = await hasFeatureAccess(ctx.roleId, 'commerce.event-cancellations');
  }
  if (!hasTransferAccess) {
    return res.status(403).json({ error: 'You do not have permission to approve or reject transfer requests' });
  }

  const tenantId = ctx.tenantId;
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  const { status, review_notes } = req.body;

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('booking_transfer_request')
      .select('*')
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Transfer request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been ${request.status}` });
    }

    const bookingSource = request.booking_source || 'booking';
    const isComplex = isComplexSource(bookingSource);
    const bookingTable = getBookingTable(bookingSource);

    let booking, bookingError;
    if (isComplex) {
      const { data, error } = await supabase
        .from('complex_event_booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, event_id, status, booking_reference, booking_group_reference, tenant_id, xero_invoice_id, total_paid, ticket_class_name')
        .eq('id', request.booking_id)
        .eq('tenant_id', tenantId)
        .single();
      booking = data ? { ...data, total_cost: data.total_paid, _source: BOOKING_SOURCE_COMPLEX } : null;
      bookingError = error;
    } else {
      const { data, error } = await supabase
        .from('booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, event_id, status, booking_reference, booking_group_reference, tenant_id, xero_invoice_id, ticket_price, total_cost, ticket_class_name')
        .eq('id', request.booking_id)
        .eq('tenant_id', tenantId)
        .single();
      booking = data;
      bookingError = error;
    }

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Associated booking not found' });
    }

    const isPublicTransfer = !request.target_member_id && request.target_email;

    let targetMember = null;
    if (request.target_member_id) {
      const { data: tm, error: targetError } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .eq('id', request.target_member_id)
        .eq('tenant_id', tenantId)
        .single();

      if (targetError || !tm) {
        return res.status(400).json({ error: 'Target member not found' });
      }
      targetMember = tm;
    } else if (isPublicTransfer) {
      if (status === 'approved') {
        const { data: memberCheck } = await supabase
          .from('member')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('email', request.target_email)
          .not('email', 'ilike', 'deleted_%@deleted.local')
          .maybeSingle();

        if (memberCheck) {
          return res.status(400).json({ error: 'The target email now belongs to an existing member. Please reject this request and create a new member transfer instead.' });
        }
      }
      targetMember = {
        id: null,
        first_name: request.target_first_name || '',
        last_name: request.target_last_name || '',
        email: request.target_email,
      };
    } else {
      return res.status(400).json({ error: 'Transfer request has no target member or target email' });
    }

    let reviewerName = 'Admin';
    if (ctx.tenantUserId) {
      const { data: tu } = await supabase.from('tenant_user').select('email, name').eq('id', ctx.tenantUserId).single();
      if (tu) reviewerName = tu.email || tu.name || 'Admin';
    } else if (ctx.memberId) {
      const { data: m } = await supabase.from('member').select('email, first_name, last_name').eq('id', ctx.memberId).single();
      if (m) reviewerName = m.email || [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Admin';
    }

    let eventData = null;
    const eventIdToLookup = booking.event_id || request.event_id;
    console.log(`[TransferRequest] Event lookup starting | booking.event_id: ${booking.event_id} | request.event_id: ${request.event_id} | tenantId: ${tenantId}`);
    if (eventIdToLookup) {
      let ev = null;
      let evErr = null;

      const tenantResult = await supabase
        .from('event')
        .select('id, title, start_date, end_date, location, venue, is_online, zoom_meeting_id, zoom_webinar_id, tenant_id')
        .eq('id', eventIdToLookup)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (tenantResult.data?.title) {
        ev = tenantResult.data;
      } else if (tenantResult.error?.code === '42703') {
        console.warn(`[TransferRequest] PostgREST schema cache stale, retrying event lookup without tenant_id filter | error: ${tenantResult.error.message}`);
        const fallbackResult = await supabase
          .from('event')
          .select('*')
          .eq('id', eventIdToLookup)
          .maybeSingle();
        ev = fallbackResult.data;
        evErr = fallbackResult.error;
      } else {
        evErr = tenantResult.error;
      }

      if (ev?.title) {
        eventData = ev;
        console.log(`[TransferRequest] Event resolved: ${ev.title} (${ev.id})`);
      } else if (isComplex) {
        const { data: ce } = await supabase
          .from('complex_event')
          .select('id, title, start_date, end_date, location')
          .eq('id', eventIdToLookup)
          .maybeSingle();
        if (ce?.title) {
          eventData = ce;
          console.log(`[TransferRequest] Complex event resolved: ${ce.title} (${ce.id})`);
        } else {
          console.warn(`[TransferRequest] Event lookup returned no data | eventId: ${eventIdToLookup} | error: ${evErr?.message || 'none'}`);
        }
      } else {
        console.warn(`[TransferRequest] Event lookup returned no data | eventId: ${eventIdToLookup} | error: ${evErr?.message || 'none'}`);
      }
    } else {
      console.warn(`[TransferRequest] No event_id available on booking or request | bookingId: ${booking.id} | requestId: ${request.id}`);
    }

    let zoomJoinUrl = null;

    if (status === 'approved') {
      const originalAttendeeEmail = booking.attendee_email;
      const originalAttendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';

      const { error: updateBookingError } = await supabase
        .from(bookingTable)
        .update({
          attendee_email: targetMember.email,
          attendee_first_name: targetMember.first_name,
          attendee_last_name: targetMember.last_name,
        })
        .eq('id', booking.id)
        .eq('tenant_id', tenantId);

      if (updateBookingError) {
        console.error('[TransferRequest] Failed to update booking:', updateBookingError);
        return res.status(500).json({ error: 'Failed to transfer booking' });
      }

      console.log(`[TransferRequest] Booking ${booking.id} transferred from ${originalAttendeeEmail} to ${targetMember.email}${isPublicTransfer ? ' (public)' : ''}`);

      if (!isPublicTransfer) {
        updateAccountingInvoiceDescription({
          booking,
          originalFirstName: booking.attendee_first_name,
          originalLastName: booking.attendee_last_name,
          originalEmail: originalAttendeeEmail,
          newFirstName: targetMember.first_name,
          newLastName: targetMember.last_name,
          newEmail: targetMember.email,
          tenantId,
        }).catch(err => {
          console.error('[TransferRequest] Accounting invoice update error (non-blocking):', err.message);
        });
      } else {
        console.log(`[TransferRequest] Skipping accounting invoice update for public transfer`);
      }

      if (isComplex) {
        try {
          const newAttendee = {
            first_name: targetMember.first_name,
            last_name: targetMember.last_name,
            email: targetMember.email,
          };
          const swapResult = await swapComplexEventZoomRegistrations(booking, originalAttendeeEmail, newAttendee, tenantId);
          if (swapResult.joinUrl) {
            zoomJoinUrl = swapResult.joinUrl;
          }
        } catch (err) {
          console.error(`[TransferRequest] Complex event Zoom swap error (non-blocking):`, err.message);
        }
      } else if (eventData) {
        try {
          const webinar = await resolveEventZoomWebinar(eventData);
          if (webinar && webinar.zoom_webinar_id) {
            await cancelZoomRegistrant(tenantId, webinar.zoom_webinar_id, originalAttendeeEmail).catch(err => {
              console.error(`[TransferRequest] Zoom cancel registrant error (non-blocking):`, err.message);
            });

            const regResult = await registerZoomWebinarAttendee(tenantId, webinar, {
              first_name: targetMember.first_name,
              last_name: targetMember.last_name,
              email: targetMember.email,
            });
            if (regResult.success && regResult.join_url) {
              zoomJoinUrl = regResult.join_url;
              console.log(`[TransferRequest] New attendee ${targetMember.email} registered with Zoom, join_url: ${zoomJoinUrl}`);
            } else if (!regResult.success) {
              console.error(`[TransferRequest] Zoom registration for new attendee failed (non-blocking):`, regResult.error);
            }
          }
        } catch (err) {
          console.error(`[TransferRequest] Zoom swap error (non-blocking):`, err.message);
        }
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('booking_transfer_request')
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
      console.error('[TransferRequest] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request status' });
    }

    try {
      await sendTransferNotificationEmails({
        request,
        booking,
        targetMember,
        status,
        tenantId,
        reviewNotes: review_notes || null,
        isPublicTransfer,
        eventData,
        zoomJoinUrl,
      });
    } catch (emailErr) {
      console.error('[TransferRequest] Email notification error (non-blocking):', emailErr.stack || emailErr.message, '| bookingId:', booking.id, '| requestId:', requestId);
    }

    return res.json({ request: updated });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function updateAccountingInvoiceDescription({ booking, originalFirstName, originalLastName, originalEmail, newFirstName, newLastName, newEmail, tenantId }) {
  const invoiceId = booking.accounting_invoice_id || booking.xero_invoice_id;
  if (!invoiceId) {
    console.log('[TransferInvoice] No accounting invoice linked to this booking — skipping');
    return;
  }

  const provider = await getAccountingProvider(tenantId);
  if (!provider || provider.name === 'none') {
    console.log('[TransferInvoice] No accounting provider configured — skipping');
    return;
  }

  console.log(`[TransferInvoice] Updating ${provider.name} invoice ${invoiceId} line description for transfer`);

  const result = await provider.updateInvoiceLineAttendeeDescription({
    appTenantId: tenantId,
    invoiceId,
    originalFirstName,
    originalLastName,
    originalEmail,
    newFirstName,
    newLastName,
    newEmail,
  });

  if (result?.skipped) {
    console.log(`[TransferInvoice] ${provider.name} invoice ${invoiceId} update skipped: ${result.reason}`);
  } else {
    console.log(`[TransferInvoice] ${provider.name} invoice ${result?.invoiceNumber || invoiceId} description updated successfully`);
  }
}

async function sendTransferNotificationEmails({ request, booking, targetMember, status, tenantId, reviewNotes, isPublicTransfer = false, eventData = null, zoomJoinUrl = null }) {
  console.log(`[TransferEmail] Starting email notification | bookingId: ${booking.id} | status: ${status} | targetMember: ${targetMember?.email || 'none'} | booking.event_id: ${booking.event_id} | request.event_id: ${request.event_id} | tenantId: ${tenantId} | eventData: ${eventData ? eventData.title : 'none passed'}`);

  let eventName = eventData?.title || 'an event';
  let event = eventData || null;

  if (!event) {
    const fallbackEventId = booking.event_id || request.event_id;
    if (fallbackEventId) {
      console.warn(`[TransferEmail] No pre-resolved event data, attempting fallback lookup | eventId: ${fallbackEventId} | tenantId: ${tenantId}`);

      const tenantResult = await supabase
        .from('event')
        .select('id, title, start_date, end_date, location, venue, is_online, zoom_meeting_id, zoom_webinar_id, tenant_id')
        .eq('id', fallbackEventId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      let fallbackEvent = tenantResult.data;
      let eventError = tenantResult.error;

      if (!fallbackEvent && tenantResult.error?.code === '42703') {
        console.warn(`[TransferEmail] PostgREST schema cache stale, retrying without tenant_id filter | error: ${tenantResult.error.message}`);
        const retryResult = await supabase
          .from('event')
          .select('*')
          .eq('id', fallbackEventId)
          .maybeSingle();
        fallbackEvent = retryResult.data;
        eventError = retryResult.error;
      }

      if (fallbackEvent?.title) {
        eventName = fallbackEvent.title;
        event = fallbackEvent;
        console.log(`[TransferEmail] Fallback event resolved | eventId: ${fallbackEventId} | title: ${eventName}`);
      } else {
        console.warn(`[TransferEmail] Fallback event lookup also failed | eventId: ${fallbackEventId} | error: ${eventError?.message || 'no data returned'}`);
      }
    } else {
      console.warn(`[TransferEmail] No event_id on booking or request | bookingId: ${booking.id}`);
    }
  }

  const originalAttendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';
  const originalAttendeeEmail = booking.attendee_email;
  const bookingRef = booking.booking_reference || booking.booking_group_reference || '';

  if (status === 'approved') {
    if (originalAttendeeEmail) {
      try {
        console.log(`[TransferEmail] Sending cancellation notification to original attendee: ${originalAttendeeEmail}`);
        const html = buildCancellationEmail(originalAttendeeName, eventName, bookingRef);
        const result = await sendEmail({
          to: originalAttendeeEmail,
          subject: `Booking Cancellation Confirmed — ${eventName}`,
          html,
          tenantId,
        });
        if (result?.success) {
          console.log(`[TransferEmail] Sent cancellation notification to original attendee: ${originalAttendeeEmail}`);
        } else {
          console.error(`[TransferEmail] Failed to email original attendee ${originalAttendeeEmail} | error: ${result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`[TransferEmail] Exception emailing original attendee ${originalAttendeeEmail}:`, err.stack || err.message);
      }
    }

    if (targetMember?.email) {
      try {
        console.log(`[TransferEmail] Sending confirmation to new attendee: ${targetMember.email} (public: ${isPublicTransfer})`);
        let sent = false;
        if (!isPublicTransfer && booking.event_id) {
          const attendee = {
            first_name: targetMember.first_name || '',
            last_name: targetMember.last_name || '',
            email: targetMember.email,
          };
          const results = await sendConfirmationEmailsFromTemplate(booking.event_id, booking, attendee, zoomJoinUrl, null, tenantId);
          sent = results && results.length > 0 && results.some(r => r.success);
          if (sent) {
            console.log(`[TransferEmail] Sent event confirmation template to new attendee: ${targetMember.email}`);
          }
        }
        if (!sent) {
          console.log(`[TransferEmail] Sending generic confirmation email to new attendee`);
          const html = buildGenericConfirmationEmail(targetMember.first_name || 'there', eventName, bookingRef, event, zoomJoinUrl);
          const result = await sendEmail({
            to: targetMember.email,
            subject: `Event Registration Confirmation — ${eventName}`,
            html,
            tenantId,
          });
          if (result?.success) {
            console.log(`[TransferEmail] Sent generic confirmation to new attendee: ${targetMember.email}`);
          } else {
            console.error(`[TransferEmail] Failed to email new attendee ${targetMember.email} | error: ${result?.error || 'Unknown error'}`);
          }
        }
      } catch (err) {
        console.error(`[TransferEmail] Exception emailing new attendee ${targetMember.email}:`, err.stack || err.message);
      }
    }
  } else {
    const { data: requester } = await supabase
      .from('member')
      .select('first_name, email')
      .eq('id', request.member_id)
      .maybeSingle();

    if (requester?.email) {
      try {
        console.log(`[TransferEmail] Sending rejection notification to requester: ${requester.email}`);
        const html = buildRejectionEmail(requester.first_name || 'there', eventName, bookingRef, reviewNotes);
        const result = await sendEmail({
          to: requester.email,
          subject: `Booking Transfer Request Rejected — ${eventName}`,
          html,
          tenantId,
        });
        if (result?.success) {
          console.log(`[TransferEmail] Sent rejection notification to requester: ${requester.email}`);
        } else {
          console.error(`[TransferEmail] Failed to email requester ${requester.email} | error: ${result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`[TransferEmail] Exception emailing requester ${requester.email}:`, err.stack || err.message);
      }
    }
  }

  console.log(`[TransferEmail] Notification process complete | bookingId: ${booking.id}`);
}

function buildCancellationEmail(name, eventName, bookingRef) {
  const safeName = name || 'there';
  let body = '';
  body += `<p>Hi ${safeName},</p>`;
  body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled.</p>`;

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  return body;
}

function buildGenericConfirmationEmail(name, eventName, bookingRef, eventDetails, zoomJoinUrl = null) {
  const safeName = name || 'there';
  let body = '';
  body += `<p>Hi ${safeName},</p>`;
  body += `<p>You have been registered to attend <strong>${eventName}</strong>.</p>`;

  if (eventDetails) {
    body += `<div style="margin: 16px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
    body += `<p style="margin: 0 0 8px 0; font-weight: 600; color: #333;">Event Details</p>`;
    if (eventDetails.start_date) {
      try {
        const startDate = new Date(eventDetails.start_date);
        const dateStr = startDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const timeStr = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        body += `<p style="margin: 0 0 4px 0; color: #555;">Date: ${dateStr} at ${timeStr}</p>`;
      } catch (e) { /* skip */ }
    }
    if (eventDetails.location || eventDetails.venue) {
      const loc = [eventDetails.venue, eventDetails.location].filter(Boolean).join(', ');
      body += `<p style="margin: 0 0 4px 0; color: #555;">Location: ${loc}</p>`;
    }
    if (zoomJoinUrl) {
      body += `<p style="margin: 0 0 4px 0; color: #555;">Join Link: <a href="${zoomJoinUrl}">${zoomJoinUrl}</a></p>`;
    }
    body += `</div>`;
  }

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  return body;
}

function buildRejectionEmail(name, eventName, bookingRef, reviewNotes) {
  const safeName = name || 'there';
  let body = '';
  body += `<p>Hi ${safeName},</p>`;
  body += `<p>Your transfer request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  if (reviewNotes) {
    body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
    body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
    body += `<p style="margin: 0; color: #555;">${String(reviewNotes).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    body += `</div>`;
  }

  body += `<p style="color: #666; font-size: 14px;">Your booking remains unchanged. If you have any questions, please get in touch.</p>`;
  return body;
}
