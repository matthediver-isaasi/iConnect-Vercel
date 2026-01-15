import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { sendEmail } from '../_lib/emailService.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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
    if (req.method === 'GET') {
      const { data: memberships, error } = await supabase
        .from('tenant_membership')
        .select(`
          id,
          identity_id,
          role,
          membership_type,
          status,
          created_at,
          updated_at,
          tenant_identity:identity_id (
            id,
            email,
            first_name,
            last_name,
            last_login
          )
        `)
        .eq('tenant_id', tenantId)
        .eq('membership_type', 'owner')
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[Tenant Team] List error:', error);
        return res.status(500).json({ error: 'Failed to fetch team members' });
      }

      const teamMembers = (memberships || []).map(m => ({
        id: m.id,
        identity_id: m.identity_id,
        role: m.role,
        status: m.status,
        created_at: m.created_at,
        email: m.tenant_identity?.email,
        first_name: m.tenant_identity?.first_name,
        last_name: m.tenant_identity?.last_name,
        last_login: m.tenant_identity?.last_login,
        is_current_user: m.identity_id === tenantUser._sessionIdentityId
      }));

      return res.json({ members: teamMembers });
    }

    if (req.method === 'POST') {
      const { email, first_name, last_name, role = 'admin' } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const validRoles = ['owner', 'admin', 'billing', 'viewer'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      let identity = null;
      const { data: existingIdentity } = await supabase
        .from('tenant_identity')
        .select('*')
        .eq('email', normalizedEmail)
        .single();

      const resetToken = crypto.randomUUID();
      const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      if (existingIdentity) {
        identity = existingIdentity;

        const { data: existingMembership } = await supabase
          .from('tenant_membership')
          .select('id')
          .eq('identity_id', identity.id)
          .eq('tenant_id', tenantId)
          .eq('membership_type', 'owner')
          .single();

        if (existingMembership) {
          return res.status(400).json({ error: 'This user is already a team member' });
        }

        const { error: updateError } = await supabase
          .from('tenant_identity')
          .update({
            reset_token: resetToken,
            reset_token_expires: resetExpires.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', identity.id);

        if (updateError) {
          console.error('[Tenant Team] Update identity reset token error:', updateError);
          return res.status(500).json({ error: 'Failed to prepare invitation for existing user' });
        }

        identity.reset_token = resetToken;
      } else {
        const { data: newIdentity, error: identityError } = await supabase
          .from('tenant_identity')
          .insert({
            email: normalizedEmail,
            first_name: first_name || '',
            last_name: last_name || '',
            password_hash: null,
            is_temporary: true,
            reset_token: resetToken,
            reset_token_expires: resetExpires.toISOString()
          })
          .select()
          .single();

        if (identityError) {
          console.error('[Tenant Team] Create identity error:', identityError);
          return res.status(500).json({ error: 'Failed to create user' });
        }

        identity = newIdentity;
      }

      const { data: membership, error: membershipError } = await supabase
        .from('tenant_membership')
        .insert({
          identity_id: identity.id,
          tenant_id: tenantId,
          role: role,
          membership_type: 'owner',
          status: 'active',
          is_default: false
        })
        .select()
        .single();

      if (membershipError) {
        console.error('[Tenant Team] Create membership error:', membershipError);
        return res.status(500).json({ error: 'Failed to add team member' });
      }

      const isNewUser = !existingIdentity;

      const { data: tenant } = await supabase
        .from('tenant')
        .select('name, slug, admin_domain')
        .eq('id', tenantId)
        .single();

      const tenantName = tenant?.name || 'the admin portal';
      const tenantSlug = tenant?.slug;

      const host = req.headers.host || 'iconn.app';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const adminHost = tenant?.admin_domain || (tenantSlug ? `${tenantSlug}.iconn.app` : host);
      const setPasswordUrl = `${protocol}://${adminHost}/admin/login?setup=${identity.reset_token}&email=${encodeURIComponent(normalizedEmail)}`;

      const inviterName = tenantUser.first_name && tenantUser.last_name 
        ? `${tenantUser.first_name} ${tenantUser.last_name}` 
        : tenantUser.email;

      const roleLabel = role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : role === 'billing' ? 'Billing Manager' : 'Viewer';

      try {
        const emailSubject = isNewUser 
          ? `You've been invited to ${tenantName}`
          : `You've been added to ${tenantName}`;

        const emailHtml = isNewUser ? `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
            <p>Hi${first_name ? ` ${first_name}` : ''},</p>
            <p>${inviterName} has invited you to join <strong>${tenantName}</strong> as a <strong>${roleLabel}</strong>.</p>
            <p>Click the button below to set up your password and access the admin portal:</p>
            <p style="margin: 30px 0; text-align: center;">
              <a href="${setPasswordUrl}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
                Set Up Your Account
              </a>
            </p>
            <p>This invitation link will expire in 7 days.</p>
            <p>If you didn't expect this invitation, you can safely ignore this email.</p>
          </div>
        ` : `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
            <p>Hi${identity.first_name ? ` ${identity.first_name}` : ''},</p>
            <p>${inviterName} has added you to <strong>${tenantName}</strong> as a <strong>${roleLabel}</strong>.</p>
            <p>Since you already have an account, you can log in with your existing password:</p>
            <p style="margin: 30px 0; text-align: center;">
              <a href="${protocol}://${adminHost}/admin/login" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
                Go to Admin Portal
              </a>
            </p>
            <p>Or if you'd like to reset your password, use this link (expires in 7 days):</p>
            <p style="text-align: center;">
              <a href="${setPasswordUrl}" style="color: #4f46e5; text-decoration: underline;">
                Reset Password
              </a>
            </p>
          </div>
        `;

        await sendEmail({
          to: normalizedEmail,
          subject: emailSubject,
          html: emailHtml
        });

        console.log(`[Tenant Team] Invitation email sent to ${normalizedEmail} (isNewUser: ${isNewUser})`);
      } catch (emailError) {
        console.error('[Tenant Team] Failed to send invitation email:', emailError);
      }

      return res.json({
        success: true,
        member: {
          id: membership.id,
          identity_id: identity.id,
          role: membership.role,
          status: membership.status,
          created_at: membership.created_at,
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name,
          is_new_user: isNewUser
        }
      });
    }

    if (req.method === 'PATCH') {
      const { membership_id, role, status } = req.body;

      if (!membership_id) {
        return res.status(400).json({ error: 'Membership ID is required' });
      }

      const { data: membership } = await supabase
        .from('tenant_membership')
        .select('*')
        .eq('id', membership_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!membership) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (membership.identity_id === tenantUser._sessionIdentityId && role && role !== membership.role) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }

      const updateData = { updated_at: new Date().toISOString() };
      if (role) {
        const validRoles = ['owner', 'admin', 'billing', 'viewer'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        updateData.role = role;
      }
      if (status) {
        const validStatuses = ['active', 'inactive'];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        updateData.status = status;
      }

      const { data: updated, error } = await supabase
        .from('tenant_membership')
        .update(updateData)
        .eq('id', membership_id)
        .select()
        .single();

      if (error) {
        console.error('[Tenant Team] Update error:', error);
        return res.status(500).json({ error: 'Failed to update team member' });
      }

      return res.json({ success: true, membership: updated });
    }

    if (req.method === 'DELETE') {
      const { membership_id } = req.body;

      if (!membership_id) {
        return res.status(400).json({ error: 'Membership ID is required' });
      }

      const { data: membership } = await supabase
        .from('tenant_membership')
        .select('*')
        .eq('id', membership_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!membership) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (membership.identity_id === tenantUser._sessionIdentityId) {
        return res.status(400).json({ error: 'You cannot remove yourself from the team' });
      }

      const { data: allOwners } = await supabase
        .from('tenant_membership')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('membership_type', 'owner')
        .eq('role', 'owner');

      if ((allOwners?.length || 0) <= 1 && membership.role === 'owner') {
        return res.status(400).json({ error: 'Cannot remove the last owner' });
      }

      const { error } = await supabase
        .from('tenant_membership')
        .delete()
        .eq('id', membership_id);

      if (error) {
        console.error('[Tenant Team] Delete error:', error);
        return res.status(500).json({ error: 'Failed to remove team member' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Tenant Team] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
