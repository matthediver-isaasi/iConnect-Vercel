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

  // Check authentication - also validates member still exists
  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { bookingGroupRef } = req.query;

  if (!bookingGroupRef) {
    return res.status(400).json({ error: 'Booking group reference required' });
  }

  try {
    // Fetch booking with Xero invoice ID and verify ownership
    const { data: booking, error } = await supabase
      .from('booking')
      .select('xero_invoice_id, xero_invoice_number, member_id, organization_id')
      .eq('booking_group_reference', bookingGroupRef)
      .not('xero_invoice_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error fetching booking:', error);
      return res.status(500).json({ error: 'Failed to fetch booking' });
    }

    if (!booking || !booking.xero_invoice_id) {
      return res.status(404).json({ error: 'Invoice not found for this booking' });
    }

    // Verify authorization - member must be the one who made the booking OR from the same organization
    const isSameMember = booking.member_id === sessionMember.id;
    const isSameOrg = sessionMember.organization_id && booking.organization_id && sessionMember.organization_id === booking.organization_id;
    
    if (!isSameMember && !isSameOrg) {
      return res.status(403).json({ error: 'Not authorized to view this invoice' });
    }

    // Fetch PDF directly from Xero (single source of truth)
    const pdfBuffer = await fetchXeroInvoicePdf(booking.xero_invoice_id);

    // Check if inline preview is requested
    const inline = req.query.inline === 'true';
    
    // Set headers for PDF download or inline viewing
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
