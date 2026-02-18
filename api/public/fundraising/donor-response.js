import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { sendTenantEmail } from '../../_lib/tenantEmailService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const sessionToken = req.query.session_token;
    if (!sessionToken) {
      return res.status(400).json({ error: 'Session token is required' });
    }

    const { data: tokenRecord, error: tokenError } = await supabase
      .from('fundraising_login_token')
      .select('*')
      .eq('token', sessionToken)
      .eq('tenant_id', tenant.id)
      .eq('type', 'session')
      .single();

    if (tokenError || !tokenRecord) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const { donation_id, team_member_id, response_type, message } = req.body;

    if (!donation_id || !team_member_id || !response_type || !message?.trim()) {
      return res.status(400).json({ error: 'donation_id, team_member_id, response_type, and message are required' });
    }

    if (!['public', 'private'].includes(response_type)) {
      return res.status(400).json({ error: 'response_type must be public or private' });
    }

    const { data: member, error: memberError } = await supabase
      .from('fundraising_team_member')
      .select('id, email, tenant_id, campaign_id, first_name, last_name')
      .eq('id', team_member_id)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    if (member.email?.toLowerCase() !== tokenRecord.email?.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (member.tenant_id !== tenant.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { data: donation, error: donationError } = await supabase
      .from('fundraising_donation')
      .select('id, donor_name, donor_email, team_member_id, campaign_id, tenant_id, amount, currency')
      .eq('id', donation_id)
      .single();

    if (donationError || !donation) {
      return res.status(404).json({ error: 'Donation not found' });
    }

    if (donation.tenant_id !== tenant.id || donation.team_member_id !== team_member_id) {
      return res.status(403).json({ error: 'Not authorized to respond to this donation' });
    }

    const { data: response, error: insertError } = await supabase
      .from('fundraising_donor_response')
      .insert({
        tenant_id: tenant.id,
        donation_id,
        team_member_id,
        response_type,
        message: message.trim()
      })
      .select()
      .single();

    if (insertError) {
      console.error('[Donor Response] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save response' });
    }

    if (response_type === 'private' && donation.donor_email) {
      const { data: campaign } = await supabase
        .from('fundraising_campaign')
        .select('name')
        .eq('id', donation.campaign_id)
        .single();

      const campaignName = campaign?.name || 'Fundraising Campaign';
      const fundraiserName = `${member.first_name} ${member.last_name}`;

      try {
        await sendTenantEmail({
          tenantId: tenant.id,
          to: donation.donor_email,
          subject: `A message from ${fundraiserName} - ${campaignName}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333; margin-bottom: 8px;">${fundraiserName} sent you a message</h2>
              <p style="color: #666; font-size: 14px; margin-bottom: 20px;">
                Thank you for your donation of ${donation.currency === 'GBP' ? '£' : donation.currency === 'USD' ? '$' : '€'}${parseFloat(donation.amount).toFixed(2)} to ${campaignName}.
              </p>
              <div style="background: #f9f9f9; border-left: 4px solid #4f46e5; padding: 16px; border-radius: 4px; margin-bottom: 20px;">
                <p style="margin: 0; color: #333; white-space: pre-wrap;">${message.trim()}</p>
              </div>
              <p style="color: #999; font-size: 12px;">This is a personal message from your fundraiser. Please do not reply to this email.</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('[Donor Response] Email send failed:', emailErr);
      }
    }

    return res.status(201).json(response);
  } catch (err) {
    console.error('[Donor Response] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
