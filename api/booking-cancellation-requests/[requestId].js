import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

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

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const tenantId = tenantUser.tenant_id;
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
      .from('booking_cancellation_request')
      .select('*')
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Cancellation request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been ${request.status}` });
    }

    const reviewerName = tenantUser.email || tenantUser.name || 'Admin';

    if (status === 'approved') {
      const cancellationResult = await processCancellation(request, tenantId);
      if (!cancellationResult.success) {
        console.error('[CancellationRequest] Cancellation processing failed:', cancellationResult.error);
        return res.status(500).json({ error: 'Failed to process cancellation: ' + (cancellationResult.error || 'Unknown error') });
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('booking_cancellation_request')
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
      console.error('[CancellationRequest] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request status' });
    }

    return res.json({ request: updated });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processCancellation(request, tenantId) {
  try {
    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('*')
      .eq('id', request.booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return { success: false, error: 'Booking not found' };
    }

    if (booking.status === 'cancelled') {
      return { success: true, alreadyCancelled: true };
    }

    const { error: updateError } = await supabase
      .from('booking')
      .update({ status: 'cancelled' })
      .eq('id', booking.id);

    if (updateError) {
      return { success: false, error: 'Failed to update booking status' };
    }

    console.log(`[CancellationRequest] Booking ${booking.id} cancelled`);

    if (booking.event_id && booking.member_id) {
      const { data: event } = await supabase
        .from('event')
        .select('program_tag, title')
        .eq('id', booking.event_id)
        .single();

      if (event?.program_tag) {
        const { data: member } = await supabase
          .from('member')
          .select('id, email, organization_id')
          .eq('id', booking.member_id)
          .single();

        if (member?.organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, program_ticket_balances')
            .eq('id', member.organization_id)
            .single();

          if (org) {
            const currentBalances = org.program_ticket_balances || {};
            const currentBalance = currentBalances[event.program_tag] || 0;

            await supabase
              .from('organization')
              .update({
                program_ticket_balances: { ...currentBalances, [event.program_tag]: currentBalance + 1 },
                last_synced: new Date().toISOString()
              })
              .eq('id', org.id);

            await supabase.from('program_ticket_transaction').insert({
              organization_id: org.id,
              program_name: event.program_tag,
              transaction_type: 'refund',
              quantity: 1,
              booking_reference: booking.booking_reference || booking.backstage_order_id || booking.id,
              event_name: event.title || 'Unknown Event',
              member_email: member.email || booking.attendee_email || 'unknown',
              notes: `Ticket refunded via approved cancellation request`
            });

            console.log(`[CancellationRequest] Program ticket refunded for ${event.program_tag}`);
          }
        }
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[CancellationRequest] Error processing cancellation:', err);
    return { success: false, error: err.message };
  }
}
