import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  if (!session.tenantId || !session.identityId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { bookingId } = req.query;
  if (!bookingId) {
    return res.status(400).json({ error: 'Booking ID required' });
  }

  try {
    const { data: booking, error: fetchError } = await supabase
      .from('agent_booking')
      .select('*')
      .eq('id', bookingId)
      .eq('tenant_id', session.tenantId)
      .eq('identity_id', session.identityId)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (req.method === 'GET') {
      return res.json({ booking });
    }

    if (req.method === 'PATCH') {
      const { status, cancellation_reason } = req.body;

      const updateData = {};
      if (status) {
        updateData.status = status;
        if (status === 'cancelled') {
          updateData.cancelled_at = new Date().toISOString();
          updateData.cancelled_by = 'agent';
          if (cancellation_reason) {
            updateData.cancellation_reason = cancellation_reason;
          }
        }
      }

      const { data: updated, error: updateError } = await supabase
        .from('agent_booking')
        .update(updateData)
        .eq('id', bookingId)
        .select()
        .single();

      if (updateError) {
        console.error('[Booking Update] Error:', updateError);
        return res.status(500).json({ error: 'Failed to update booking' });
      }

      return res.json({ booking: updated });
    }

    if (req.method === 'DELETE') {
      const { error: deleteError } = await supabase
        .from('agent_booking')
        .delete()
        .eq('id', bookingId);

      if (deleteError) {
        console.error('[Booking Delete] Error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete booking' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Booking] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
