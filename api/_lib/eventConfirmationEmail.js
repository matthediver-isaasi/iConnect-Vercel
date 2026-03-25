import { supabase } from './database.js';
import { sendEmail } from './emailService.js';

export async function sendConfirmationEmailsFromTemplate(eventId, booking, attendee, personalizedZoomUrl = null, pricingDetails = null, tenantId = null) {
  if (!supabase) return [];

  const results = [];

  try {
    const { data: confirmationEmails, error: emailsError } = await supabase
      .from('event_email')
      .select('*')
      .eq('event_id', eventId)
      .in('email_type', ['confirmation', 'booking_confirmation'])
      .eq('is_enabled', true);

    if (emailsError || !confirmationEmails || confirmationEmails.length === 0) {
      console.log('[sendConfirmationEmailsFromTemplate] No confirmation emails configured for event');
      return results;
    }

    console.log(`[sendConfirmationEmailsFromTemplate] Found ${confirmationEmails.length} confirmation email(s) to send`);

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      console.error(`[sendConfirmationEmailsFromTemplate] Event not found | eventId: ${eventId} | tenantId: ${tenantId || 'not provided'} | error: ${eventError?.message || 'no data'}`);
      return results;
    }

    let zoomJoinUrl = personalizedZoomUrl;
    if (!zoomJoinUrl) {
      if (event.zoom_meeting_id) {
        const { data: zoomMeeting } = await supabase
          .from('zoom_meeting')
          .select('join_url')
          .eq('id', event.zoom_meeting_id)
          .single();
        zoomJoinUrl = zoomMeeting?.join_url;
      } else if (event.zoom_webinar_id) {
        const { data: zoomWebinar } = await supabase
          .from('zoom_webinar')
          .select('join_url')
          .eq('id', event.zoom_webinar_id)
          .single();
        zoomJoinUrl = zoomWebinar?.join_url;
      }
    }

    event.zoom_join_url = zoomJoinUrl;

    if (zoomJoinUrl) {
      console.log(`[sendConfirmationEmailsFromTemplate] Using Zoom link for ${attendee?.email || booking?.attendee_email}: ${zoomJoinUrl.substring(0, 50)}...`);
    }

    const bookingData = {
      id: booking?.id || '',
      attendee_first_name: attendee?.first_name || booking?.attendee_first_name || '',
      attendee_last_name: attendee?.last_name || booking?.attendee_last_name || '',
      attendee_email: attendee?.email || booking?.attendee_email || '',
      booking_reference: booking?.booking_reference || '',
      ticket_price: booking?.ticket_price || 0,
      total_cost: booking?.total_cost || 0,
      ticket_class_name: booking?.ticket_class_name || 'Standard',
      pricingDetails: pricingDetails || null
    };

    for (const emailConfig of confirmationEmails) {
      try {
        const subject = replacePlaceholders(emailConfig.subject, { event, booking: bookingData });
        const body = replacePlaceholders(emailConfig.body, { event, booking: bookingData });

        const emailResult = await sendEmail({
          to: bookingData.attendee_email,
          subject: subject,
          html: formatBodyAsHtml(body),
          tenantId: event.tenant_id
        });

        if (emailResult.success) {
          console.log(`[sendConfirmationEmailsFromTemplate] Sent confirmation to ${bookingData.attendee_email}`);
          results.push({ email: bookingData.attendee_email, success: true, ...emailResult });
        } else {
          console.error(`[sendConfirmationEmailsFromTemplate] Failed to send to ${bookingData.attendee_email}:`, emailResult.error);
          results.push({ email: bookingData.attendee_email, success: false, error: emailResult.error });
        }
      } catch (err) {
        console.error(`[sendConfirmationEmailsFromTemplate] Error sending confirmation:`, err.message);
        results.push({ email: bookingData.attendee_email, success: false, error: err.message });
      }
    }

  } catch (err) {
    console.error('[sendConfirmationEmailsFromTemplate] Error:', err.message);
  }

  return results;
}

export function replacePlaceholders(template, data) {
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
  if (pd?.freeTickets > 0) {
    result = result.replace(/\{\{#offer_discount\}\}([\s\S]*?)\{\{\/offer_discount\}\}/gi, '$1');
    const discountDesc = pd.discountDescription || `${pd.freeTickets} free ticket(s)`;
    result = result.replace(/\{\{offer_discount_description\}\}/gi, discountDesc);
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, discountDesc);
    const discountSaving = `£${(pd.freeTickets * ticketPrice).toFixed(2)}`;
    result = result.replace(/\{\{offer_discount_amount\}\}/gi, discountSaving);
    result = result.replace(/\[\[booking\.offer_discount_amount\]\]/gi, discountSaving);
  } else if (pd?.discount > 0) {
    result = result.replace(/\{\{#offer_discount\}\}([\s\S]*?)\{\{\/offer_discount\}\}/gi, '$1');
    const discountDesc = pd.discountDescription || 'Discount';
    result = result.replace(/\{\{offer_discount_description\}\}/gi, discountDesc);
    result = result.replace(/\[\[booking\.offer_discount_description\]\]/gi, discountDesc);
    const discountAmount = `£${pd.discount.toFixed(2)}`;
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

export function formatEventDate(dateStr) {
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

export function formatBodyAsHtml(body) {
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
