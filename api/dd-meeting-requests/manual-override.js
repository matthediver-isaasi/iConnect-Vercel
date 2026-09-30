import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { 
    meetingRequestId, 
    overrideDateTime 
  } = req.body;

  if (!meetingRequestId) {
    return res.status(400).json({ error: 'meetingRequestId is required' });
  }

  if (!overrideDateTime) {
    return res.status(400).json({ error: 'overrideDateTime is required' });
  }

  const parsedDate = new Date(overrideDateTime);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date/time format' });
  }

  try {
    const { data: meetingRequest, error: fetchError } = await supabase
      .from('dd_meeting_request')
      .select(`
        *,
        meeting_template:meeting_template_id (
          id, name, duration_minutes
        )
      `)
      .eq('id', meetingRequestId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (fetchError || !meetingRequest) {
      console.error('[dd-meeting-requests/manual-override] Fetch error:', fetchError);
      return res.status(404).json({ error: 'Meeting request not found' });
    }

    if (meetingRequest.status === 'booked') {
      return res.status(400).json({ error: 'This meeting request is already booked' });
    }

    const durationMinutes = meetingRequest.meeting_template?.duration_minutes || 30;
    const startsAt = parsedDate.toISOString();
    const endsAt = new Date(parsedDate.getTime() + durationMinutes * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('dd_meeting_request')
      .update({
        status: 'booked',
        booked_at: startsAt,
        manual_override: true,
        manual_override_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', meetingRequestId)
      .eq('tenant_id', tenantContext.tenantId);

    if (updateError) {
      console.error('[dd-meeting-requests/manual-override] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update meeting request' });
    }

    const { data: relatedRequests } = await supabase
      .from('dd_meeting_request')
      .select('id')
      .eq('form_submission_id', meetingRequest.form_submission_id)
      .eq('meeting_template_id', meetingRequest.meeting_template_id)
      .eq('tenant_id', tenantContext.tenantId)
      .neq('id', meetingRequestId)
      .eq('status', 'pending');

    if (relatedRequests && relatedRequests.length > 0) {
      const relatedIds = relatedRequests.map(r => r.id);
      await supabase
        .from('dd_meeting_request')
        .update({
          status: 'cancelled',
          cancelled_reason: 'Another request was manually marked as booked',
          updated_at: new Date().toISOString()
        })
        .in('id', relatedIds)
        .eq('tenant_id', tenantContext.tenantId);
    }

    console.log(`[dd-meeting-requests/manual-override] Manual override completed for request ${meetingRequestId} with booked time ${startsAt}`);

    return res.status(200).json({ 
      success: true,
      message: 'Meeting request manually marked as booked',
      meetingRequestId,
      bookedAt: startsAt,
      endsAt: endsAt
    });

  } catch (error) {
    console.error('[dd-meeting-requests/manual-override] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
