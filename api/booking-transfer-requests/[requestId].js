import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { sendEmail } from '../_lib/emailService.js';

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

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const tenantId = tenantUser.tenant_id;
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

    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, event_id, status, booking_reference, booking_group_reference, tenant_id')
      .eq('id', request.booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Associated booking not found' });
    }

    const { data: targetMember, error: targetError } = await supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('id', request.target_member_id)
      .eq('tenant_id', tenantId)
      .single();

    if (targetError || !targetMember) {
      return res.status(400).json({ error: 'Target member not found' });
    }

    const reviewerName = tenantUser.email || tenantUser.name || 'Admin';

    if (status === 'approved') {
      const originalAttendeeEmail = booking.attendee_email;
      const originalAttendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';

      const { error: updateBookingError } = await supabase
        .from('booking')
        .update({
          attendee_email: targetMember.email,
          attendee_first_name: targetMember.first_name,
          attendee_last_name: targetMember.last_name,
          member_id: targetMember.id,
        })
        .eq('id', booking.id)
        .eq('tenant_id', tenantId);

      if (updateBookingError) {
        console.error('[TransferRequest] Failed to update booking:', updateBookingError);
        return res.status(500).json({ error: 'Failed to transfer booking' });
      }

      console.log(`[TransferRequest] Booking ${booking.id} transferred from ${originalAttendeeEmail} to ${targetMember.email}`);
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

    sendTransferNotificationEmails({
      request,
      booking,
      targetMember,
      status,
      tenantId,
      reviewNotes: review_notes || null,
    }).catch(err => {
      console.error('[TransferRequest] Email notification error (non-blocking):', err.message);
    });

    return res.json({ request: updated });
  } catch (err) {
    console.error('[TransferRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function sendTransferNotificationEmails({ request, booking, targetMember, status, tenantId, reviewNotes }) {
  let eventName = 'an event';
  if (booking.event_id) {
    const { data: event } = await supabase
      .from('event')
      .select('title')
      .eq('id', booking.event_id)
      .maybeSingle();
    if (event?.title) {
      eventName = event.title;
    }
  }

  const originalAttendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';
  const originalAttendeeEmail = booking.attendee_email;
  const bookingRef = booking.booking_reference || booking.booking_group_reference || '';

  if (status === 'approved') {
    if (originalAttendeeEmail) {
      try {
        const html = buildOriginalAttendeeEmail(originalAttendeeName, eventName, bookingRef);
        const result = await sendEmail({
          to: originalAttendeeEmail,
          subject: `Booking Transferred — ${eventName}`,
          html,
          tenantId,
        });
        if (result?.success) {
          console.log(`[TransferEmail] Sent transfer notification to original attendee: ${originalAttendeeEmail}`);
        } else {
          console.error(`[TransferEmail] Failed to email original attendee ${originalAttendeeEmail}: ${result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`[TransferEmail] Failed to email original attendee ${originalAttendeeEmail}:`, err.message);
      }
    }

    if (targetMember.email) {
      try {
        const html = buildNewAttendeeEmail(targetMember.first_name || 'there', eventName, bookingRef);
        const result = await sendEmail({
          to: targetMember.email,
          subject: `Event Registration Confirmation — ${eventName}`,
          html,
          tenantId,
        });
        if (result?.success) {
          console.log(`[TransferEmail] Sent registration confirmation to new attendee: ${targetMember.email}`);
        } else {
          console.error(`[TransferEmail] Failed to email new attendee ${targetMember.email}: ${result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`[TransferEmail] Failed to email new attendee ${targetMember.email}:`, err.message);
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
          console.error(`[TransferEmail] Failed to email requester ${requester.email}: ${result?.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(`[TransferEmail] Failed to email requester ${requester.email}:`, err.message);
      }
    }
  }
}

function buildOriginalAttendeeEmail(name, eventName, bookingRef) {
  let body = '';
  body += `<p>Hi ${name},</p>`;
  body += `<p>Your ticket for <strong>${eventName}</strong> has been transferred to another member.</p>`;

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  body += `<p style="color: #666; font-size: 14px;">If you have any questions about this transfer, please don't hesitate to get in touch.</p>`;
  return body;
}

function buildNewAttendeeEmail(name, eventName, bookingRef) {
  let body = '';
  body += `<p>Hi ${name},</p>`;
  body += `<p>You have been registered to attend <strong>${eventName}</strong>.</p>`;
  body += `<p>A ticket has been transferred to you. Please find the event details below.</p>`;

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  return body;
}

function buildRejectionEmail(name, eventName, bookingRef, reviewNotes) {
  let body = '';
  body += `<p>Hi ${name},</p>`;
  body += `<p>Your transfer request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;

  if (bookingRef) {
    body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  }

  if (reviewNotes) {
    body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
    body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
    body += `<p style="margin: 0; color: #555;">${reviewNotes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    body += `</div>`;
  }

  body += `<p style="color: #666; font-size: 14px;">Your booking remains unchanged. If you have any questions, please get in touch.</p>`;
  return body;
}
