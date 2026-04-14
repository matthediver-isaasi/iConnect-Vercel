import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

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
      .select('id, member_id, attendee_email, tenant_id')
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

    const { error: updateError } = await supabase
      .from('complex_event_booking')
      .update({
        purchase_order_number: purchase_order_number.trim(),
        po_to_follow: false,
      })
      .eq('id', booking_id)
      .eq('tenant_id', tenantId);

    if (updateError) {
      console.error('[ComplexEventBookings] PO update error:', updateError);
      return res.status(500).json({ error: 'Failed to update PO number' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[ComplexEventBookings] PO update error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
