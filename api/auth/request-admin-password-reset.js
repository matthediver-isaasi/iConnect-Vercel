import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';

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

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is required' 
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('id, email, first_name, last_name')
      .ilike('email', normalizedEmail)
      .single();

    if (identityError || !identity) {
      console.log('[Admin Password Reset] No identity found for:', normalizedEmail);
      return res.json({ 
        success: true, 
        message: 'If an account exists, a reset link will be sent.' 
      });
    }

    const { data: memberships } = await supabase
      .from('tenant_membership')
      .select('id, tenant_id, membership_type, tenant:tenant_id(name, slug, admin_domain)')
      .eq('identity_id', identity.id)
      .eq('membership_type', 'owner')
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .limit(1);

    if (!memberships || memberships.length === 0) {
      console.log('[Admin Password Reset] No admin (owner type) memberships for:', normalizedEmail);
      return res.json({ 
        success: true, 
        message: 'If an account exists, a reset link will be sent.' 
      });
    }

    const resetToken = crypto.randomUUID();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

    // Get tenant_id from the owner membership for tenant-specific credentials
    const tenantId = memberships[0]?.tenant_id;
    
    if (!tenantId) {
      console.error('[Admin Password Reset] No tenant_id found for owner membership');
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to process request' 
      });
    }

    // Store reset token in tenant_membership_credentials for per-tenant password isolation
    const { data: existingTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .single();

    if (existingTenantCreds) {
      const { error: tenantCredError } = await supabase
        .from('tenant_membership_credentials')
        .update({
          reset_token: resetToken,
          reset_token_expires: resetExpires.toISOString()
        })
        .eq('id', existingTenantCreds.id);

      if (tenantCredError) {
        console.error('[Admin Password Reset] Tenant creds update error:', tenantCredError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to process request' 
        });
      }
      console.log('[Admin Password Reset] Updated reset token in tenant_membership_credentials');
    } else {
      const { error: insertError } = await supabase
        .from('tenant_membership_credentials')
        .insert({
          identity_id: identity.id,
          tenant_id: tenantId,
          reset_token: resetToken,
          reset_token_expires: resetExpires.toISOString()
        });

      if (insertError) {
        console.error('[Admin Password Reset] Tenant creds insert error:', insertError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to process request' 
        });
      }
      console.log('[Admin Password Reset] Created tenant_membership_credentials with reset token');
    }

    // Also update tenant_identity for backwards compatibility
    const { error: updateError } = await supabase
      .from('tenant_identity')
      .update({
        reset_token: resetToken,
        reset_token_expires: resetExpires.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', identity.id);

    if (updateError) {
      console.error('[Admin Password Reset] Identity update error (non-critical):', updateError);
    }

    const tenant = memberships[0]?.tenant;
    const host = req.headers.host || 'iconn.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const adminHost = tenant?.admin_domain || (tenant?.slug ? `${tenant.slug}.iconn.app` : host);
    const resetUrl = `${protocol}://${adminHost}/admin/login?setup=${resetToken}&email=${encodeURIComponent(normalizedEmail)}`;

    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
          <p>Hi${identity.first_name ? ` ${identity.first_name}` : ''},</p>
          <p>We received a request to reset your admin password. Click the button below to create a new password:</p>
          <p style="margin: 30px 0; text-align: center;">
            <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              Reset Password
            </a>
          </p>
          <p>This link will expire in 1 hour.</p>
          <p>If you didn't request this reset, you can safely ignore this email.</p>
        </div>
      `;

      await sendEmail({
        to: normalizedEmail,
        subject: 'Reset Your Admin Password',
        html: emailHtml,
        tenantId
      });

      console.log(`[Admin Password Reset] Email sent to ${normalizedEmail}`);
    } catch (emailError) {
      console.error('[Admin Password Reset] Failed to send email:', emailError);
    }

    return res.json({ 
      success: true, 
      message: 'If an account exists, a reset link will be sent.' 
    });
  } catch (err) {
    console.error('[Admin Password Reset] Error:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Server error' 
    });
  }
}
