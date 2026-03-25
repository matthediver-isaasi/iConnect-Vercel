import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
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

    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, event_id, status, booking_reference, booking_group_reference, tenant_id, xero_invoice_id, ticket_price, total_cost, ticket_class_name')
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

    try {
      await sendTransferNotificationEmails({
        request,
        booking,
        targetMember,
        status,
        tenantId,
        reviewNotes: review_notes || null,
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
  console.log(`[TransferEmail] Starting email notification | bookingId: ${booking.id} | status: ${status} | targetMember: ${targetMember?.email || 'none'}`);

  let eventName = 'an event';
  let event = null;
  if (booking.event_id) {
    const { data: eventData } = await supabase
      .from('event')
      .select('id, title, start_date, end_date, location, venue, is_online, zoom_meeting_id, zoom_webinar_id, tenant_id')
      .eq('id', booking.event_id)
      .maybeSingle();
    if (eventData?.title) {
      eventName = eventData.title;
      event = eventData;
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
        console.log(`[TransferEmail] Sending confirmation to new attendee: ${targetMember.email}`);
        let sent = false;
        if (booking.event_id) {
          sent = await sendEventConfirmationEmail(booking, targetMember, event, tenantId);
        }
        if (!sent) {
          console.log(`[TransferEmail] No event confirmation template configured, sending generic email`);
          const html = buildGenericConfirmationEmail(targetMember.first_name || 'there', eventName, bookingRef, event);
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

async function sendEventConfirmationEmail(booking, targetMember, event, tenantId) {
  if (!booking.event_id) return false;

  const { data: confirmationEmails, error: emailsError } = await supabase
    .from('event_email')
    .select('*')
    .eq('event_id', booking.event_id)
    .in('email_type', ['confirmation', 'booking_confirmation'])
    .eq('is_enabled', true);

  if (emailsError || !confirmationEmails || confirmationEmails.length === 0) {
    return false;
  }

  console.log(`[TransferEmail] Found ${confirmationEmails.length} event confirmation email(s) to send`);

  let zoomJoinUrl = null;
  if (event?.zoom_meeting_id) {
    const { data: zoomMeeting } = await supabase
      .from('zoom_meeting')
      .select('join_url')
      .eq('id', event.zoom_meeting_id)
      .single();
    zoomJoinUrl = zoomMeeting?.join_url;
  } else if (event?.zoom_webinar_id) {
    const { data: zoomWebinar } = await supabase
      .from('zoom_webinar')
      .select('join_url')
      .eq('id', event.zoom_webinar_id)
      .single();
    zoomJoinUrl = zoomWebinar?.join_url;
  }

  const eventData = { ...event, zoom_join_url: zoomJoinUrl };

  const bookingData = {
    id: booking.id || '',
    attendee_first_name: targetMember.first_name || '',
    attendee_last_name: targetMember.last_name || '',
    attendee_email: targetMember.email || '',
    booking_reference: booking.booking_reference || '',
    ticket_price: booking.ticket_price || 0,
    total_cost: booking.total_cost || 0,
    ticket_class_name: booking.ticket_class_name || 'Standard',
    pricingDetails: null,
  };

  let anySent = false;
  for (const emailConfig of confirmationEmails) {
    try {
      const subject = replacePlaceholders(emailConfig.subject, { event: eventData, booking: bookingData });
      const body = replacePlaceholders(emailConfig.body, { event: eventData, booking: bookingData });

      const emailResult = await sendEmail({
        to: targetMember.email,
        subject,
        html: formatBodyAsHtml(body),
        tenantId: event?.tenant_id || tenantId,
      });

      if (emailResult?.success) {
        console.log(`[TransferEmail] Sent event confirmation to new attendee: ${targetMember.email}`);
        anySent = true;
      } else {
        console.error(`[TransferEmail] Event confirmation failed for ${targetMember.email}: ${emailResult?.error || 'Unknown'}`);
      }
    } catch (err) {
      console.error(`[TransferEmail] Exception sending event confirmation:`, err.stack || err.message);
    }
  }

  return anySent;
}

function replacePlaceholders(template, data) {
  const { event, booking } = data;
  let result = template || '';

  result = result.replace(/\{\{event_name\}\}/gi, event?.title || '');
  result = result.replace(/\{\{event_date\}\}/gi, formatEventDate(event?.start_date));
  result = result.replace(/\{\{event_location\}\}/gi, event?.is_online ? 'Online Event' : (event?.location || ''));
  result = result.replace(/\{\{attendee_first_name\}\}/gi, booking?.attendee_first_name || '');
  result = result.replace(/\{\{attendee_last_name\}\}/gi, booking?.attendee_last_name || '');

  result = result.replace(/\[\[member\.first_name\]\]/gi, booking?.attendee_first_name || '');
  result = result.replace(/\[\[member\.last_name\]\]/gi, booking?.attendee_last_name || '');
  result = result.replace(/\[\[member\.email\]\]/gi, booking?.attendee_email || '');
  result = result.replace(/\[\[attendee\.first_name\]\]/gi, booking?.attendee_first_name || '');
  result = result.replace(/\[\[attendee\.last_name\]\]/gi, booking?.attendee_last_name || '');
  result = result.replace(/\[\[attendee\.email\]\]/gi, booking?.attendee_email || '');

  result = result.replace(/\[\[event\.name\]\]/gi, event?.title || '');
  result = result.replace(/\[\[event\.title\]\]/gi, event?.title || '');
  result = result.replace(/\[\[event\.date\]\]/gi, formatEventDate(event?.start_date));
  result = result.replace(/\[\[event\.location\]\]/gi, event?.is_online ? 'Online Event' : (event?.location || ''));

  result = result.replace(/\{\{booking_id\}\}/gi, booking?.id || '');
  result = result.replace(/\[\[booking\.id\]\]/gi, booking?.id || '');
  result = result.replace(/\{\{booking_reference\}\}/gi, booking?.booking_reference || '');
  result = result.replace(/\[\[booking\.reference\]\]/gi, booking?.booking_reference || '');
  result = result.replace(/\[\[booking\.booking_reference\]\]/gi, booking?.booking_reference || '');
  result = result.replace(/\{\{ticket_class\}\}/gi, booking?.ticket_class_name || 'Standard');
  result = result.replace(/\[\[booking\.ticket_class\]\]/gi, booking?.ticket_class_name || 'Standard');

  const ticketPrice = Number(booking?.ticket_price || 0);
  const totalCost = Number(booking?.total_cost || 0);
  result = result.replace(/\{\{ticket_price\}\}/gi, ticketPrice > 0 ? `£${ticketPrice.toFixed(2)}` : 'Free');
  result = result.replace(/\[\[booking\.ticket_price\]\]/gi, ticketPrice > 0 ? `£${ticketPrice.toFixed(2)}` : 'Free');
  result = result.replace(/\{\{total_cost\}\}/gi, totalCost > 0 ? `£${totalCost.toFixed(2)}` : 'Free');
  result = result.replace(/\[\[booking\.total_cost\]\]/gi, totalCost > 0 ? `£${totalCost.toFixed(2)}` : 'Free');

  const pd = booking?.pricingDetails;
  if (pd?.freeTickets > 0 || pd?.discount > 0) {
    result = result.replace(/\{\{#offer_discount\}\}([\s\S]*?)\{\{\/offer_discount\}\}/gi, '$1');
    const discountDesc = pd.discountDescription || (pd.freeTickets > 0 ? `${pd.freeTickets} free ticket(s)` : 'Discount');
    result = result.replace(/\{\{offer_discount_description\}\}/gi, discountDesc);
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, discountDesc);
    const discountAmount = pd.freeTickets > 0 ? `£${(pd.freeTickets * ticketPrice).toFixed(2)}` : `£${pd.discount.toFixed(2)}`;
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, discountAmount);
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, discountAmount);
  } else {
    result = result.replace(/\{\{#offer_discount\}\}[\s\S]*?\{\{\/offer_discount\}\}/gi, '');
    result = result.replace(/\{\{offer_discount_description\}\}/gi, '');
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, '');
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, '');
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, '');
  }

  const zoomLink = event?.zoom_join_url || booking?.zoom_join_url || '';
  if (zoomLink) {
    result = result.replace(/\{\{#zoom_link\}\}([\s\S]*?)\{\{\/zoom_link\}\}/gi, '$1');
    result = result.replace(/\{\{zoom_link\}\}/gi, zoomLink);
    result = result.replace(/\[\[zoom_link\]\]/gi, zoomLink);
  } else {
    result = result.replace(/\{\{#zoom_link\}\}[\s\S]*?\{\{\/zoom_link\}\}/gi, '');
    result = result.replace(/\{\{zoom_link\}\}/gi, '');
    result = result.replace(/\[\[zoom_link\]\]/gi, '');
  }

  return result;
}

function formatEventDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return dateStr;
  }
}

function formatBodyAsHtml(body) {
  if (!body) return '';
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(body);
  if (hasHtmlTags) {
    return `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${body}</div>`;
  }
  let html = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1">$1</a>');
  return `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${html}</div>`;
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

function buildGenericConfirmationEmail(name, eventName, bookingRef, eventDetails) {
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
