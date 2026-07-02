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
    formSubmissionId,
    meetingTemplateId,
    agentIdentityId,
    overrideDateTime,
    recipientEmail,
    recipientFirstName,
    recipientLastName
  } = req.body;

  if (!formSubmissionId) {
    return res.status(400).json({ error: 'formSubmissionId is required' });
  }

  if (!meetingTemplateId) {
    return res.status(400).json({ error: 'meetingTemplateId is required' });
  }

  if (!agentIdentityId) {
    return res.status(400).json({ error: 'agentIdentityId is required' });
  }

  if (!overrideDateTime) {
    return res.status(400).json({ error: 'overrideDateTime is required' });
  }

  const parsedDate = new Date(overrideDateTime);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date/time format' });
  }

  try {
    const { data: formSubmission, error: fsError } = await supabase
      .from('form_submission')
      .select('id, submission_data')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (fsError || !formSubmission) {
      console.error('[dd-meeting-requests/create-booked] Form submission fetch error:', fsError);
      return res.status(404).json({ error: 'Form submission not found' });
    }

    const submissionData = formSubmission.submission_data || {};
    const fallbackEmail = recipientEmail || submissionData['Applicant Email'] || submissionData.email || submissionData.Email || 'migrated@manual-override.local';
    const fallbackFirstName = recipientFirstName || submissionData['Applicant first name'] || submissionData.first_name || submissionData.firstName || submissionData.First_Name || null;
    const fallbackLastName = recipientLastName || submissionData['Applicant last name'] || submissionData.last_name || submissionData.lastName || submissionData.Last_Name || null;

    const { data: meetingTemplate, error: templateError } = await supabase
      .from('meeting_template')
      .select('id, name, duration_minutes')
      .eq('id', meetingTemplateId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (templateError || !meetingTemplate) {
      console.error('[dd-meeting-requests/create-booked] Template fetch error:', templateError);
      return res.status(404).json({ error: 'Meeting template not found' });
    }

    const { data: existingBooked } = await supabase
      .from('dd_meeting_request')
      .select('id')
      .eq('form_submission_id', formSubmissionId)
      .eq('meeting_template_id', meetingTemplateId)
      .eq('tenant_id', tenantContext.tenantId)
      .eq('status', 'booked')
      .limit(1);

    if (existingBooked && existingBooked.length > 0) {
      return res.status(400).json({ error: 'A meeting for this template is already booked for this submission' });
    }

    const durationMinutes = meetingTemplate.duration_minutes || 30;
    const startsAt = parsedDate.toISOString();
    const endsAt = new Date(parsedDate.getTime() + durationMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const newRequest = {
      tenant_id: tenantContext.tenantId,
      form_submission_id: formSubmissionId,
      meeting_template_id: meetingTemplateId,
      agent_identity_id: agentIdentityId,
      recipient_email: fallbackEmail,
      recipient_first_name: fallbackFirstName,
      recipient_last_name: fallbackLastName,
      status: 'booked',
      booked_at: startsAt,
      manual_override: true,
      manual_override_at: now,
      created_at: now,
      updated_at: now
    };

    const { data: createdRequest, error: insertError } = await supabase
      .from('dd_meeting_request')
      .insert(newRequest)
      .select()
      .single();

    if (insertError) {
      console.error('[dd-meeting-requests/create-booked] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create meeting request' });
    }

    const { data: pendingRequests } = await supabase
      .from('dd_meeting_request')
      .select('id')
      .eq('form_submission_id', formSubmissionId)
      .eq('meeting_template_id', meetingTemplateId)
      .eq('tenant_id', tenantContext.tenantId)
      .neq('id', createdRequest.id)
      .in('status', ['pending', 'not_sent']);

    if (pendingRequests && pendingRequests.length > 0) {
      const pendingIds = pendingRequests.map(r => r.id);
      await supabase
        .from('dd_meeting_request')
        .update({
          status: 'cancelled',
          cancelled_reason: 'Another request was manually marked as booked',
          updated_at: now
        })
        .in('id', pendingIds)
        .eq('tenant_id', tenantContext.tenantId);
    }

    console.log(`[dd-meeting-requests/create-booked] Created booked meeting request ${createdRequest.id} for form submission ${formSubmissionId}`);

    return res.status(200).json({ 
      success: true,
      message: 'Meeting request created and marked as booked',
      meetingRequestId: createdRequest.id,
      bookedAt: startsAt,
      endsAt: endsAt
    });

  } catch (error) {
    console.error('[dd-meeting-requests/create-booked] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
