import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { pushPurchaseOrderToXero } from '../_lib/xero.js';
import { sendPoSubmissionNotification } from '../_lib/poNotificationEmail.js';

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

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = sessionMember.tenant_id;
  const memberId = sessionMember.id;

  if (!tenantId || !memberId) {
    return res.status(400).json({ error: 'Member context required' });
  }

  const { booking_id, purchase_order_number } = req.body;

  if (!booking_id) {
    return res.status(400).json({ error: 'booking_id is required' });
  }

  if (!purchase_order_number || !purchase_order_number.trim()) {
    return res.status(400).json({ error: 'purchase_order_number is required' });
  }

  try {
    const { data: booking, error: fetchError } = await supabase
      .from('complex_event_booking')
      .select('id, member_id, attendee_email, attendee_first_name, attendee_last_name, booking_reference, event_id, tenant_id, xero_invoice_id, booking_group_reference')
      .eq('id', booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const memberEmail = sessionMember.email?.toLowerCase();
    const isOwner = booking.member_id === memberId ||
      (memberEmail && (booking.attendee_email || '').toLowerCase() === memberEmail);

    if (!isOwner) {
      return res.status(403).json({ error: 'You can only update PO for your own bookings' });
    }

    const trimmedPO = purchase_order_number.trim();

    // The group shares one Xero invoice — apply the PO to every group row.
    const { error: updateError } = await supabase
      .from('complex_event_booking')
      .update({
        purchase_order_number: trimmedPO,
        po_to_follow: false,
      })
      .eq('booking_group_reference', booking.booking_group_reference)
      .eq('tenant_id', tenantId);

    if (updateError) {
      console.error('[ComplexEventBookings] PO update error:', updateError);
      return res.status(500).json({ error: 'Failed to update PO number' });
    }

    // The invoice is stored on one row in the group — fall back to a group lookup.
    let groupXeroInvoiceId = booking.xero_invoice_id;
    if (!groupXeroInvoiceId) {
      const { data: invoiceRow } = await supabase
        .from('complex_event_booking')
        .select('xero_invoice_id')
        .eq('booking_group_reference', booking.booking_group_reference)
        .eq('tenant_id', tenantId)
        .not('xero_invoice_id', 'is', null)
        .limit(1)
        .maybeSingle();
      groupXeroInvoiceId = invoiceRow?.xero_invoice_id || null;
    }

    const { xeroUpdated, xeroError } = await pushPurchaseOrderToXero({
      appTenantId: tenantId,
      xeroInvoiceId: groupXeroInvoiceId,
      purchaseOrderNumber: trimmedPO,
      contextLabel: `ComplexEventBooking ${booking_id}`,
    });

    try {
      let eventName = '';
      if (booking.event_id) {
        const { data: ev } = await supabase
          .from('complex_event')
          .select('title')
          .eq('id', booking.event_id)
          .maybeSingle();
        eventName = ev?.title || '';
      }

      let submitterName = [booking.attendee_first_name, booking.attendee_last_name]
        .filter(Boolean).join(' ').trim();
      let submitterEmail = booking.attendee_email || '';
      if (!submitterName || !submitterEmail) {
        const { data: memberRow } = await supabase
          .from('member')
          .select('first_name, last_name, email')
          .eq('id', memberId)
          .maybeSingle();
        if (memberRow) {
          if (!submitterName) {
            submitterName = [memberRow.first_name, memberRow.last_name].filter(Boolean).join(' ').trim();
          }
          if (!submitterEmail) submitterEmail = memberRow.email || '';
        }
      }

      await sendPoSubmissionNotification({
        tenantId,
        bookingReference: booking.booking_reference || booking.booking_group_reference,
        eventName,
        purchaseOrderNumber: trimmedPO,
        submitterName,
        submitterEmail,
        bookingType: 'complex_event',
      });
    } catch (notifyErr) {
      console.error('[ComplexEventBookings] PO notification email failed:', notifyErr.message);
    }

    return res.json({
      success: true,
      purchase_order_number: trimmedPO,
      xeroUpdated,
      xeroError,
    });
  } catch (err) {
    console.error('[ComplexEventBookings] PO update error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
