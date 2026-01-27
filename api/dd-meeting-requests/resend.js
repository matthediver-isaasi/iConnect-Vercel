import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext || !tenantContext.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = tenantContext.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    const { meetingRequestId } = req.body;
    if (!meetingRequestId) {
      return res.status(400).json({ error: 'meetingRequestId is required' });
    }

    const { data: meetingRequest, error: mrError } = await supabase
      .from('dd_meeting_request')
      .select(`
        *,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes, meeting_type, email_template_id
        ),
        agent:agent_identity_id (
          id, first_name, last_name, email
        )
      `)
      .eq('id', meetingRequestId)
      .eq('tenant_id', tenantId)
      .single();

    if (mrError || !meetingRequest) {
      return res.status(404).json({ error: 'Meeting request not found' });
    }

    if (meetingRequest.status === 'booked') {
      return res.status(400).json({ error: 'Cannot resend - meeting already booked' });
    }

    const template = meetingRequest.meeting_template;
    if (!template?.email_template_id) {
      return res.status(400).json({ error: 'No email template configured for this meeting type' });
    }

    const { data: emailTemplate, error: templateError } = await supabase
      .from('email_template')
      .select('*')
      .eq('id', template.email_template_id)
      .eq('tenant_id', tenantId)
      .single();

    if (templateError || !emailTemplate) {
      return res.status(400).json({ error: 'Email template not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = `https://${tenant?.slug || 'app'}.iconn.app`;

    // Note: booking_slug is on tenant_identity, not tenant_membership
    const { data: agentMembership } = await supabase
      .from('tenant_membership')
      .select('identity:identity_id(booking_slug)')
      .eq('identity_id', meetingRequest.agent_identity_id)
      .eq('tenant_id', tenantId)
      .single();

    const agentBookingSlug = agentMembership?.identity?.booking_slug;
    if (!agentBookingSlug) {
      return res.status(400).json({ error: 'Agent has no booking slug configured' });
    }

    const bookingUrl = `${baseUrl}/book/${encodeURIComponent(agentBookingSlug)}?meeting=${encodeURIComponent(template.slug)}&dd_request=${encodeURIComponent(meetingRequestId)}`;
    const agentName = [meetingRequest.agent?.first_name, meetingRequest.agent?.last_name].filter(Boolean).join(' ') || 'Team Member';
    const recipientName = meetingRequest.recipient_first_name || 'there';

    let subject = emailTemplate.subject || 'Meeting Invitation';
    let body = emailTemplate.body || '';

    subject = subject
      .replace(/\{\{recipient_name\}\}/gi, recipientName)
      .replace(/\{\{recipient_email\}\}/gi, meetingRequest.recipient_email)
      .replace(/\{\{meeting_type\}\}/gi, template.name)
      .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
      .replace(/\{\{agent_name\}\}/gi, agentName)
      .replace(/\{\{booking_url\}\}/gi, bookingUrl)
      .replace(/\{\{booking_link\}\}/gi, `<a href="${bookingUrl}">Book a meeting</a>`);

    body = body
      .replace(/\{\{recipient_name\}\}/gi, recipientName)
      .replace(/\{\{recipient_email\}\}/gi, meetingRequest.recipient_email)
      .replace(/\{\{meeting_type\}\}/gi, template.name)
      .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
      .replace(/\{\{agent_name\}\}/gi, agentName)
      .replace(/\{\{booking_url\}\}/gi, bookingUrl)
      .replace(/\{\{booking_link\}\}/gi, `<a href="${bookingUrl}">Book a meeting</a>`);

    await sendEmail({
      to: meetingRequest.recipient_email,
      subject,
      html: body,
      from: emailTemplate.from_email,
      replyTo: emailTemplate.reply_to,
      tenantId
    });

    const { error: updateError } = await supabase
      .from('dd_meeting_request')
      .update({
        last_resent_at: new Date().toISOString(),
        resend_count: (meetingRequest.resend_count || 0) + 1,
        booking_url: bookingUrl
      })
      .eq('id', meetingRequestId)
      .eq('tenant_id', tenantId);

    if (updateError) {
      console.error('[DD Meeting Requests] Failed to update resend info:', updateError);
    }

    return res.status(200).json({ success: true, message: 'Meeting invitation resent successfully' });
  } catch (error) {
    console.error('[DD Meeting Requests] Resend error:', error);
    return res.status(500).json({ error: 'Failed to resend meeting invitation' });
  }
}
