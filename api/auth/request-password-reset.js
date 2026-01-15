import crypto from 'crypto';
import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';

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

    // Extract tenant context from request host (subdomain)
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    let tenantSlugFromHost = null;
    let tenantFromHost = null;
    
    // Parse subdomain from host (e.g., bnms.iconn.app -> bnms)
    const hostParts = host.split('.');
    if (hostParts.length >= 3 && hostParts[1] === 'iconn' && hostParts[2] === 'app') {
      tenantSlugFromHost = hostParts[0];
      console.log('[Password Reset] Detected tenant slug from host:', tenantSlugFromHost);
      
      // Look up tenant by slug
      const { data: tenant } = await supabase
        .from('tenant')
        .select('id, name, slug')
        .eq('slug', tenantSlugFromHost)
        .single();
      
      if (tenant) {
        tenantFromHost = tenant;
        console.log('[Password Reset] Resolved tenant:', tenant.id, tenant.name);
      }
    }

    // Build member query - if we have a tenant context, filter by it
    let memberQuery = supabase
      .from('member')
      .select('id, email, first_name, tenant_id')
      .eq('email', normalizedEmail);
    
    if (tenantFromHost) {
      // Filter to the specific tenant from subdomain
      memberQuery = memberQuery.eq('tenant_id', tenantFromHost.id);
    }
    
    const { data: members, error: memberError } = await memberQuery.limit(1);

    if (memberError) {
      console.error('[Password Reset] Error looking up member:', memberError);
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    if (!members || members.length === 0) {
      console.log('[Password Reset] No member found for:', normalizedEmail, 'in tenant:', tenantFromHost?.slug || 'any');
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    const member = members[0];
    console.log('[Password Reset] Found member:', member.id, 'tenant:', member.tenant_id);

    // Get tenant for branding (use host tenant if available, otherwise look up from member)
    let tenantName = tenantFromHost?.name || 'Graduate Futures';
    let tenantSlug = tenantFromHost?.slug || null;
    
    if (!tenantFromHost && member.tenant_id) {
      const { data: tenant } = await supabase
        .from('tenant')
        .select('name, slug')
        .eq('id', member.tenant_id)
        .single();
      if (tenant) {
        tenantName = tenant.name;
        tenantSlug = tenant.slug;
      }
    }

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

    // Update tenant_identity with reset token
    const { error: updateError } = await supabase
      .from('tenant_identity')
      .update({ 
        reset_token: resetToken,
        reset_token_expires: expiresAt.toISOString()
      })
      .eq('id', identity.id);

    if (updateError) {
      console.error('[Password Reset] Failed to set reset token:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to process request' });
    }

    // Also update member_credentials for backwards compatibility
    try {
      const { data: existingCreds } = await supabase
        .from('member_credentials')
        .select('id')
        .eq('member_id', member.id)
        .limit(1);

      if (existingCreds && existingCreds.length > 0) {
        const { error: credUpdateError } = await supabase
          .from('member_credentials')
          .update({ 
            reset_token: resetToken,
            reset_token_expires: expiresAt.toISOString()
          })
          .eq('id', existingCreds[0].id);
        
        if (credUpdateError) {
          console.error('[Password Reset] Failed to update member_credentials:', credUpdateError);
        }
      } else {
        const { error: credInsertError } = await supabase
          .from('member_credentials')
          .insert({
            member_id: member.id,
            email: normalizedEmail,
            reset_token: resetToken,
            reset_token_expires: expiresAt.toISOString()
          });
        
        if (credInsertError) {
          console.error('[Password Reset] Failed to insert member_credentials:', credInsertError);
        }
      }
    } catch (credError) {
      console.error('[Password Reset] member_credentials operation failed:', credError);
      // Continue anyway - we have the token in tenant_identity
    }

    // Build reset URL (reuse host from earlier)
    const protocol = host.includes('localhost') ? 'http' : 'https';
    
    // Use tenant slug subdomain if available
    let resetHost = host;
    if (tenantSlug && !host.includes('localhost')) {
      resetHost = `${tenantSlug}.iconn.app`;
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
        html: emailHtml
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
