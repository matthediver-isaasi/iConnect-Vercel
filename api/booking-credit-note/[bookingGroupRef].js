import { getSessionMember } from '../_lib/session.js';
import { fetchXeroCreditNotePdf } from '../_lib/xero.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { bookingGroupRef } = req.query;

  if (!bookingGroupRef) {
    return res.status(400).json({ error: 'Booking group reference required' });
  }

  try {
    let booking = null;

    const { data: regularBooking, error } = await supabase
      .from('booking')
      .select('xero_credit_note_id, xero_credit_note_number, member_id, organization_id')
      .eq('booking_group_reference', bookingGroupRef)
      .eq('tenant_id', sessionMember.tenant_id)
      .not('xero_credit_note_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error fetching booking for credit note:', error);
      return res.status(500).json({ error: 'Failed to fetch booking' });
    }

    booking = regularBooking;

    if (!booking || !booking.xero_credit_note_id) {
      const { data: complexBooking, error: complexError } = await supabase
        .from('complex_event_booking')
        .select('xero_credit_note_id, xero_credit_note_number, member_id, organization_id')
        .eq('booking_group_reference', bookingGroupRef)
        .eq('tenant_id', sessionMember.tenant_id)
        .not('xero_credit_note_id', 'is', null)
        .limit(1)
        .maybeSingle();

      if (complexError) {
        console.error('Error fetching complex event booking for credit note:', complexError);
      }

      if (complexBooking && complexBooking.xero_credit_note_id) {
        booking = complexBooking;
      }
    }

    if (!booking || !booking.xero_credit_note_id) {
      return res.status(404).json({ error: 'Credit note not found for this booking' });
    }

    const isSameMember = booking.member_id === sessionMember.id;
    const isSameOrg = sessionMember.organization_id && booking.organization_id && sessionMember.organization_id === booking.organization_id;

    if (!isSameMember && !isSameOrg) {
      return res.status(403).json({ error: 'Not authorized to view this credit note' });
    }

    const appTenantId = sessionMember.tenant_id;
    if (!appTenantId) {
      console.error('[booking-credit-note] Cannot determine tenant for Xero PDF fetch');
      return res.status(500).json({ error: 'Cannot determine tenant context for credit note' });
    }

    const pdfBuffer = await fetchXeroCreditNotePdf(booking.xero_credit_note_id, appTenantId);

    const inline = req.query.inline === 'true';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);

    if (inline) {
      res.setHeader('Content-Disposition', `inline; filename="credit-note-${booking.xero_credit_note_number || bookingGroupRef}.pdf"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="credit-note-${booking.xero_credit_note_number || bookingGroupRef}.pdf"`);
    }

    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error serving credit note PDF:', error);
    return res.status(500).json({ error: 'Failed to fetch credit note from Xero' });
  }
}
