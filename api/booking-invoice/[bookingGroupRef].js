import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';
import { fetchXeroInvoicePdf } from '../_lib/xero.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  // Check authentication
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
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

    // Get logged-in member's organization to check authorization
    const { data: member } = await supabase
      .from('member')
      .select('organization_id')
      .eq('id', session.data.memberId)
      .single();

    // Verify authorization - member must be the one who made the booking OR from the same organization
    const isSameMember = booking.member_id === session.data.memberId;
    const isSameOrg = member?.organization_id && booking.organization_id && member.organization_id === booking.organization_id;
    
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
