import crypto from 'crypto';
import { supabase } from '../../../_lib/database.js';
import { getSessionTenantUser } from '../../../_lib/session.js';
import { sendEmail } from '../../../_lib/emailService.js';

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

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenantId = tenantUser._sessionTenantId || tenantUser.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ error: 'No tenant context' });
  }

  try {
    const membershipId = req.query.id;

    if (!membershipId) {
      return res.status(400).json({ error: 'Membership ID is required' });
    }

    const { data: membership, error: membershipError } = await supabase
      .from('tenant_membership')
      .select(`
        id,
        identity_id,
        role,
        tenant_id,
        tenant_identity:identity_id (
          id,
          email,
          first_name,
          last_name
        )
      `)
      .eq('id', membershipId)
      .eq('tenant_id', tenantId)
      .single();

    if (membershipError || !membership) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    const identity = membership.tenant_identity;
    if (!identity) {
      return res.status(404).json({ error: 'Identity not found' });
    }

    const resetToken = crypto.randomUUID();
    const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { error: updateError } = await supabase
      .from('tenant_identity')
      .update({
        reset_token: resetToken,
        reset_token_expires: resetExpires.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', identity.id);

    if (updateError) {
      console.error('[Resend Invite] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to generate new invite' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('name, slug, admin_domain')
      .eq('id', tenantId)
      .single();

    const tenantName = tenant?.name || 'the admin portal';
    const host = req.headers.host || 'iconn.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const adminHost = tenant?.admin_domain || (tenant?.slug ? `${tenant.slug}.iconn.app` : host);
    const setPasswordUrl = `${protocol}://${adminHost}/admin/login?setup=${resetToken}&email=${encodeURIComponent(identity.email)}`;

    const inviterName = tenantUser.first_name && tenantUser.last_name 
      ? `${tenantUser.first_name} ${tenantUser.last_name}` 
      : tenantUser.email;

    const roleLabel = membership.role === 'owner' ? 'Owner' : 
                      membership.role === 'admin' ? 'Admin' : 
                      membership.role === 'billing' ? 'Billing Manager' : 'Viewer';

    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
          <p>Hi${identity.first_name ? ` ${identity.first_name}` : ''},</p>
          <p>${inviterName} has sent you a new invitation link for <strong>${tenantName}</strong>.</p>
          <p>Click the button below to set up your password and access the admin portal as a <strong>${roleLabel}</strong>:</p>
          <p style="margin: 30px 0; text-align: center;">
            <a href="${setPasswordUrl}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              Set Up Your Account
            </a>
          </p>
          <p>This invitation link will expire in 7 days.</p>
          <p>If you didn't expect this invitation, you can safely ignore this email.</p>
        </div>
      `;

      await sendEmail({
        to: identity.email,
        subject: `New invitation to ${tenantName}`,
        html: emailHtml,
        tenantId
      });

      console.log(`[Resend Invite] Email sent to ${identity.email}`);
    } catch (emailError) {
      console.error('[Resend Invite] Failed to send email:', emailError);
      return res.status(500).json({ error: 'Failed to send invitation email' });
    }

    return res.json({ 
      success: true, 
      message: 'Invitation resent successfully' 
    });
  } catch (err) {
    console.error('[Resend Invite] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
