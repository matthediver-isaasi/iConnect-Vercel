import crypto from 'crypto';
import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    console.log('[Password Reset] Request for:', normalizedEmail);

    // Use centralized tenant resolver (handles both subdomains and custom domains)
    const tenantFromHost = await resolveTenantFromRequest(req);
    
    if (tenantFromHost) {
      console.log('[Password Reset] Resolved tenant:', tenantFromHost.id, tenantFromHost.name, tenantFromHost.slug);
    } else {
      console.log('[Password Reset] No tenant resolved from host');
    }

    // Build member query - ALWAYS require tenant context for security
    if (!tenantFromHost) {
      console.log('[Password Reset] No tenant context - cannot process reset request');
      // Still return success to prevent email enumeration
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    const { data: members, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name, tenant_id')
      .eq('email', normalizedEmail)
      .eq('tenant_id', tenantFromHost.id)
      .limit(1);

    if (memberError) {
      console.error('[Password Reset] Error looking up member:', memberError);
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    if (!members || members.length === 0) {
      console.log('[Password Reset] No member found for:', normalizedEmail, 'in tenant:', tenantFromHost.slug);
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    const member = members[0];
    console.log('[Password Reset] Found member:', member.id, 'tenant:', member.tenant_id);

    // Use tenant info from resolver
    const tenantName = tenantFromHost.name || 'ICONN';
    const tenantSlug = tenantFromHost.slug;

    // Check for tenant_identity record (unified auth system)
    let identity = null;
    const { data: existingIdentity } = await supabase
      .from('tenant_identity')
      .select('id, email')
      .eq('email', normalizedEmail)
      .single();

    if (existingIdentity) {
      identity = existingIdentity;
    } else {
      // Create tenant_identity if it doesn't exist
      console.log('[Password Reset] Creating tenant_identity for:', normalizedEmail);
      const { data: newIdentity, error: createError } = await supabase
        .from('tenant_identity')
        .insert({
          email: normalizedEmail,
          is_temporary: true
        })
        .select()
        .single();

      if (createError) {
        console.error('[Password Reset] Failed to create identity:', createError);
        return res.status(500).json({ success: false, error: 'Failed to process request' });
      }
      identity = newIdentity;

      // Create tenant_membership for this member
      if (member.tenant_id) {
        await supabase
          .from('tenant_membership')
          .insert({
            identity_id: identity.id,
            tenant_id: member.tenant_id,
            membership_type: 'member',
            member_id: member.id,
            status: 'active'
          });
      }
    }

    // Generate reset token
    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Get tenant_id from host or member
    const tenantId = tenantFromHost?.id || member.tenant_id;
    
    if (!tenantId) {
      console.error('[Password Reset] No tenant context available');
      return res.status(500).json({ success: false, error: 'Failed to process request' });
    }

    // Store reset token in tenant_membership_credentials (per-tenant password isolation)
    // This ensures the password reset only affects this tenant's credentials
    const { data: existingTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identity.id)
      .eq('tenant_id', tenantId)
      .single();

    if (existingTenantCreds) {
      const { error: updateError } = await supabase
        .from('tenant_membership_credentials')
        .update({ 
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        })
        .eq('id', existingTenantCreds.id);

      if (updateError) {
        console.error('[Password Reset] Failed to update tenant credentials:', updateError);
        return res.status(500).json({ success: false, error: 'Failed to process request' });
      }
      console.log('[Password Reset] Updated reset token in tenant_membership_credentials');
    } else {
      // Create new tenant-specific credentials record
      const { error: insertError } = await supabase
        .from('tenant_membership_credentials')
        .insert({
          identity_id: identity.id,
          tenant_id: tenantId,
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        });

      if (insertError) {
        console.error('[Password Reset] Failed to create tenant credentials:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to process request' });
      }
      console.log('[Password Reset] Created tenant_membership_credentials with reset token');
    }

    // Also update legacy tables for backwards compatibility during migration
    try {
      // Update tenant_identity (for old code paths)
      await supabase
        .from('tenant_identity')
        .update({ 
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        })
        .eq('id', identity.id);

      // Update member_credentials
      const { data: existingCreds } = await supabase
        .from('member_credentials')
        .select('id')
        .eq('member_id', member.id)
        .limit(1);

      if (existingCreds && existingCreds.length > 0) {
        await supabase
          .from('member_credentials')
          .update({ 
            reset_token: resetToken,
            reset_token_expires: expiresAt.toISOString()
          })
          .eq('id', existingCreds[0].id);
      }
    } catch (legacyError) {
      console.error('[Password Reset] Legacy table update failed (non-critical):', legacyError);
      // Continue anyway - we have the token in tenant_membership_credentials
    }

    // Build reset URL using the original request host (preserves custom domains)
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    
    // Use the original host (which could be a custom domain like graduatefutures.org)
    // This ensures users get reset links for the domain they're using
    let resetHost = host;
    if (!host || host.includes('localhost') || host.includes('.repl.')) {
      // Fallback to subdomain format for local development
      resetHost = tenantSlug ? `${tenantSlug}.iconn.app` : 'iconn.app';
    }
    
    const resetUrl = `${protocol}://${resetHost}/Login?mode=set-password&token=${resetToken}&email=${encodeURIComponent(normalizedEmail)}`;
    console.log(`[Password Reset] Link for ${normalizedEmail}: ${resetUrl}`);

    // Send password reset email
    console.log('[Password Reset] Preparing to send email to:', normalizedEmail, 'with subject:', `${tenantName} Password Reset Request`);
    
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
          <p>Hi${member.first_name ? ` ${member.first_name}` : ''},</p>
          <p>We received a request to reset your password. No worries - we've got you covered! Just click the button below to create a new password:</p>
          <p style="margin: 30px 0; text-align: center;">
            <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              Reset Password
            </a>
          </p>
          <p>This link will expire in 1 hour, so be sure to update your password soon.</p>
          <p>If you didn't request this reset, you can safely ignore this email.</p>
          <p style="margin-top: 30px;">The ${tenantName} Team</p>
        </div>
      `;

      console.log('[Password Reset] Calling sendEmail...');
      const emailResult = await sendEmail({
        to: normalizedEmail,
        subject: `${tenantName} Password Reset Request`,
        html: emailHtml,
        tenantId: member.tenant_id
      });

      console.log('[Password Reset] sendEmail result:', JSON.stringify(emailResult));
      
      if (emailResult.success) {
        console.log(`[Password Reset] Email successfully sent to ${normalizedEmail}`);
      } else {
        console.error(`[Password Reset] Failed to send email: ${emailResult.error}`);
      }
    } catch (mailError) {
      console.error('[Password Reset] Exception sending email:', mailError.message || mailError);
    }

    res.json({ 
      success: true, 
      message: 'If an account exists, a reset link will be sent.'
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ success: false, error: 'Failed to process request' });
  }
}
