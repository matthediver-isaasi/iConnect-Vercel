import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { sendEmail } from '../_lib/emailService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = tenantUser._sessionTenantId || tenantUser.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    const { 
      formSubmissionId,
      meetingTemplateId,
      agentIdentityId,
      recipientEmail,
      recipientFirstName,
      recipientLastName,
      sendImmediately = true
    } = req.body;

    if (!formSubmissionId || !meetingTemplateId || !agentIdentityId || !recipientEmail) {
      return res.status(400).json({ 
        error: 'formSubmissionId, meetingTemplateId, agentIdentityId, and recipientEmail are required' 
      });
    }

    // Validate form_submission_id belongs to this tenant
    const { data: formSubmission, error: fsError } = await supabase
      .from('form_submission')
      .select('id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();

    if (fsError || !formSubmission) {
      return res.status(404).json({ error: 'Form submission not found' });
    }

    const { data: existingBooked } = await supabase
      .from('dd_meeting_request')
      .select('id')
      .eq('form_submission_id', formSubmissionId)
      .eq('meeting_template_id', meetingTemplateId)
      .eq('status', 'booked')
      .eq('tenant_id', tenantId)
      .limit(1);

    if (existingBooked && existingBooked.length > 0) {
      return res.status(400).json({ 
        error: 'A meeting has already been booked for this submission and meeting type' 
      });
    }

    const { data: template } = await supabase
      .from('meeting_template')
      .select('id, name, slug, duration_minutes, meeting_type, email_template_id')
      .eq('id', meetingTemplateId)
      .eq('tenant_id', tenantId)
      .single();

    if (!template) {
      return res.status(404).json({ error: 'Meeting template not found' });
    }

    const { data: agent } = await supabase
      .from('tenant_identity')
      .select('id, first_name, last_name, email')
      .eq('id', agentIdentityId)
      .single();

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { data: agentMembership } = await supabase
      .from('tenant_membership')
      .select('booking_slug')
      .eq('identity_id', agentIdentityId)
      .eq('tenant_id', tenantId)
      .single();

    if (!agentMembership?.booking_slug) {
      return res.status(400).json({ error: 'Agent has no booking slug configured' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = `https://${tenant?.slug || 'app'}.iconn.app`;
    const bookingUrl = `${baseUrl}/book/${encodeURIComponent(agentMembership.booking_slug)}?meeting=${encodeURIComponent(template.slug)}`;

    const normalizedEmail = recipientEmail.toLowerCase();
    
    const { data: newRequest, error: insertError } = await supabase
      .from('dd_meeting_request')
      .insert({
        tenant_id: tenantId,
        form_submission_id: formSubmissionId,
        stage_meeting_request_id: null,
        meeting_template_id: meetingTemplateId,
        agent_identity_id: agentIdentityId,
        recipient_email: normalizedEmail,
        recipient_first_name: recipientFirstName || null,
        recipient_last_name: recipientLastName || null,
        status: 'pending',
        sent_at: sendImmediately ? new Date().toISOString() : null,
        booking_url: bookingUrl,
        is_original: false
      })
      .select()
      .single();
    
    // Update the booking URL to include the tracking ID for precise linkage
    if (newRequest && !insertError) {
      const bookingUrlWithTracking = `${bookingUrl}&dd_request=${newRequest.id}`;
      await supabase
        .from('dd_meeting_request')
        .update({ booking_url: bookingUrlWithTracking })
        .eq('id', newRequest.id);
    }

    if (insertError) {
      console.error('[DD Meeting Requests] Failed to create alternative request:', insertError);
      return res.status(500).json({ error: 'Failed to create meeting request' });
    }

    if (sendImmediately && template.email_template_id) {
      const { data: emailTemplate } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', template.email_template_id)
        .eq('tenant_id', tenantId)
        .single();

      if (emailTemplate) {
        const agentName = [agent.first_name, agent.last_name].filter(Boolean).join(' ') || 'Team Member';
        const recipientName = recipientFirstName || 'there';
        // Use the booking URL with tracking ID
        const finalBookingUrl = newRequest ? `${bookingUrl}&dd_request=${newRequest.id}` : bookingUrl;

        let subject = emailTemplate.subject || 'Meeting Invitation';
        let body = emailTemplate.body || '';

        subject = subject
          .replace(/\{\{recipient_name\}\}/gi, recipientName)
          .replace(/\{\{recipient_email\}\}/gi, normalizedEmail)
          .replace(/\{\{meeting_type\}\}/gi, template.name)
          .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
          .replace(/\{\{agent_name\}\}/gi, agentName)
          .replace(/\{\{booking_url\}\}/gi, finalBookingUrl)
          .replace(/\{\{booking_link\}\}/gi, `<a href="${finalBookingUrl}">Book a meeting</a>`);

        body = body
          .replace(/\{\{recipient_name\}\}/gi, recipientName)
          .replace(/\{\{recipient_email\}\}/gi, normalizedEmail)
          .replace(/\{\{meeting_type\}\}/gi, template.name)
          .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
          .replace(/\{\{agent_name\}\}/gi, agentName)
          .replace(/\{\{booking_url\}\}/gi, finalBookingUrl)
          .replace(/\{\{booking_link\}\}/gi, `<a href="${finalBookingUrl}">Book a meeting</a>`);

        try {
          await sendEmail({
            to: normalizedEmail,
            subject,
            html: body,
            from: emailTemplate.from_email,
            replyTo: emailTemplate.reply_to,
            tenantId
          });
        } catch (emailError) {
          console.error('[DD Meeting Requests] Failed to send email for alternative:', emailError);
        }
      }
    }

    return res.status(201).json({ 
      success: true, 
      meetingRequest: newRequest,
      message: sendImmediately ? 'Meeting invitation sent successfully' : 'Meeting request created' 
    });
  } catch (error) {
    console.error('[DD Meeting Requests] Add alternative error:', error);
    return res.status(500).json({ error: 'Failed to add alternative meeting request' });
  }
}
