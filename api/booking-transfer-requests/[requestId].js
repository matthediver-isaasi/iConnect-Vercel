import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { getValidXeroAccessToken } from '../_lib/xero.js';

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
    return res.status(403).json({ error: 'Admin access required to approve or reject transfer requests' });
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

    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, event_id, status, booking_reference, booking_group_reference, tenant_id, xero_invoice_id')
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

    let reviewerName = 'Admin';
    if (ctx.tenantUserId) {
      const { data: tu } = await supabase.from('tenant_user').select('email, name').eq('id', ctx.tenantUserId).single();
      if (tu) reviewerName = tu.email || tu.name || 'Admin';
    } else if (ctx.memberId) {
      const { data: m } = await supabase.from('member').select('email, first_name, last_name').eq('id', ctx.memberId).single();
      if (m) reviewerName = m.email || [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Admin';
    }

    if (status === 'approved') {
      const originalAttendeeEmail = booking.attendee_email;
      const originalAttendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';

      const { error: updateBookingError } = await supabase
        .from('booking')
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

      console.log(`[TransferRequest] Booking ${booking.id} transferred from ${originalAttendeeEmail} to ${targetMember.email}`);

      updateXeroInvoiceDescription({
        booking,
        originalFirstName: booking.attendee_first_name,
        originalLastName: booking.attendee_last_name,
        originalEmail: originalAttendeeEmail,
        newFirstName: targetMember.first_name,
        newLastName: targetMember.last_name,
        newEmail: targetMember.email,
        tenantId,
      }).catch(err => {
        console.error('[TransferRequest] Xero invoice update error (non-blocking):', err.message);
      });
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

async function updateXeroInvoiceDescription({ booking, originalFirstName, originalLastName, originalEmail, newFirstName, newLastName, newEmail, tenantId }) {
  if (!booking.xero_invoice_id) {
    console.log('[TransferXero] No Xero invoice linked to this booking — skipping');
    return;
  }

  console.log(`[TransferXero] Updating invoice ${booking.xero_invoice_id} description for transfer`);

  const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);

  if (!accessToken || !xeroTenantId) {
    console.error('[TransferXero] Missing Xero token or tenant ID — skipping');
    return;
  }

  const invoiceResponse = await fetch(
    `https://api.xero.com/api.xro/2.0/Invoices/${booking.xero_invoice_id}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': xeroTenantId,
        'Accept': 'application/json'
      }
    }
  );

  if (!invoiceResponse.ok) {
    const errText = await invoiceResponse.text();
    console.error(`[TransferXero] Failed to fetch invoice: ${invoiceResponse.status} ${errText.substring(0, 300)}`);
    return;
  }

  const invoiceData = await invoiceResponse.json();
  const invoice = invoiceData?.Invoices?.[0];

  if (!invoice || !invoice.LineItems || invoice.LineItems.length === 0) {
    console.error('[TransferXero] Invoice has no line items — skipping');
    return;
  }

  if (invoice.Status === 'PAID' || invoice.Status === 'VOIDED') {
    console.log(`[TransferXero] Invoice status is ${invoice.Status} — cannot update description`);
    return;
  }

  const originalName = [originalFirstName, originalLastName].filter(Boolean).join(' ').trim();
  const newName = [newFirstName, newLastName].filter(Boolean).join(' ').trim();

  let descriptionUpdated = false;
  const updatedLineItems = invoice.LineItems.map(item => {
    if (!item.Description) return item;

    const lines = item.Description.split('\n');
    const updatedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (originalName && trimmed === originalName) {
        descriptionUpdated = true;
        return newName || newEmail;
      }
      if (originalEmail && trimmed === originalEmail) {
        descriptionUpdated = true;
        return newName || newEmail;
      }

      return line;
    });

    return { ...item, Description: updatedLines.join('\n') };
  });

  if (!descriptionUpdated) {
    console.log('[TransferXero] Original attendee not found in any line item description — skipping');
    return;
  }

  const updatePayload = {
    Invoices: [{
      InvoiceID: booking.xero_invoice_id,
      LineItems: updatedLineItems.map(li => ({
        LineItemID: li.LineItemID,
        Description: li.Description,
        Quantity: li.Quantity,
        UnitAmount: li.UnitAmount,
        AccountCode: li.AccountCode,
        TaxType: li.TaxType,
        Tracking: li.Tracking,
      })),
    }]
  };

  console.log(`[TransferXero] Updating invoice description: replacing "${originalName || originalEmail}" with "${newName || newEmail}"`);

  const updateResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(updatePayload)
  });

  if (!updateResponse.ok) {
    const errText = await updateResponse.text();
    console.error(`[TransferXero] Failed to update invoice: ${updateResponse.status} ${errText.substring(0, 300)}`);
    return;
  }

  const updateData = await updateResponse.json();
  const updatedInvoice = updateData?.Invoices?.[0];
  console.log(`[TransferXero] Invoice ${updatedInvoice?.InvoiceNumber || booking.xero_invoice_id} description updated successfully`);
}

async function sendTransferNotificationEmails({ request, booking, targetMember, status, tenantId, reviewNotes }) {
  let eventName = 'an event';
  let eventDetails = null;
  if (booking.event_id) {
    const { data: event } = await supabase
      .from('event')
      .select('title, start_date, end_date, location, venue')
      .eq('id', booking.event_id)
      .maybeSingle();
    if (event?.title) {
      eventName = event.title;
      eventDetails = event;
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
        const html = buildNewAttendeeEmail(targetMember.first_name || 'there', eventName, bookingRef, eventDetails);
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

function buildNewAttendeeEmail(name, eventName, bookingRef, eventDetails) {
  let body = '';
  body += `<p>Hi ${name},</p>`;
  body += `<p>You have been registered to attend <strong>${eventName}</strong>.</p>`;
  body += `<p>A ticket has been transferred to you.</p>`;

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
    body += `</div>`;
  }

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
