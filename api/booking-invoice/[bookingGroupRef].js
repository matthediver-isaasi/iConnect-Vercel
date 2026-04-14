import { getSessionMember } from '../_lib/session.js';
import { fetchXeroInvoicePdf } from '../_lib/xero.js';
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
      .select('xero_invoice_id, xero_invoice_number, member_id, organization_id')
      .eq('booking_group_reference', bookingGroupRef)
      .eq('tenant_id', sessionMember.tenant_id)
      .not('xero_invoice_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error fetching booking:', error);
      return res.status(500).json({ error: 'Failed to fetch booking' });
    }

    booking = regularBooking;

    if (!booking || !booking.xero_invoice_id) {
      const { data: complexBooking, error: complexError } = await supabase
        .from('complex_event_booking')
        .select('xero_invoice_id, xero_invoice_number, member_id, organization_id')
        .eq('booking_group_reference', bookingGroupRef)
        .eq('tenant_id', sessionMember.tenant_id)
        .not('xero_invoice_id', 'is', null)
        .limit(1)
        .maybeSingle();

      if (complexError) {
        console.error('Error fetching complex event booking:', complexError);
      }

      if (complexBooking && complexBooking.xero_invoice_id) {
        booking = complexBooking;
      }
    }

    if (!booking || !booking.xero_invoice_id) {
      return res.status(404).json({ error: 'Invoice not found for this booking' });
    }

    const isSameMember = booking.member_id === sessionMember.id;
    const isSameOrg = sessionMember.organization_id && booking.organization_id && sessionMember.organization_id === booking.organization_id;
    
    if (!isSameMember && !isSameOrg) {
      return res.status(403).json({ error: 'Not authorized to view this invoice' });
    }

    const appTenantId = sessionMember.tenant_id;
    if (!appTenantId) {
      console.error('[booking-invoice] Cannot determine tenant for Xero PDF fetch');
      return res.status(500).json({ error: 'Cannot determine tenant context for invoice' });
    }

    const pdfBuffer = await fetchXeroInvoicePdf(booking.xero_invoice_id, appTenantId);

    const inline = req.query.inline === 'true';
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    
    if (inline) {
      res.setHeader('Content-Disposition', `inline; filename="invoice-${booking.xero_invoice_number || bookingGroupRef}.pdf"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${booking.xero_invoice_number || bookingGroupRef}.pdf"`);
    }
    
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error serving invoice PDF:', error);
    return res.status(500).json({ error: 'Failed to fetch invoice from Xero' });
  }
}
