import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { sendEmail } from '../_lib/emailService.js';
import crypto from 'crypto';

const TEAM_ROLES = ['owner', 'admin', 'billing', 'viewer'];
const isTeamMembership = m => m.membership_type === 'owner' || TEAM_ROLES.includes(m.role);
const isUniqueViolation = error => error?.code === '23505';

async function findMembership(identityId, tenantId) {
  const result = await supabase.from('tenant_membership')
    .select('*').eq('identity_id', identityId).eq('tenant_id', tenantId).maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

// Legacy tenant_user sessions can bypass a demoted membership if their row
// remains active. Revoke both identity-linked rows and pre-migration rows
// linked only by the same email, without touching another identity or tenant.
async function revokeLegacyTeamUsers(identityId, tenantId) {
  const { data: identity, error: identityError } = await supabase.from('tenant_identity')
    .select('email').eq('id', identityId).single();
  if (identityError || !identity?.email) throw identityError || new Error('Identity not found');

  const { data: linked, error: linkedError } = await supabase.from('tenant_user')
    .select('id, status').eq('tenant_id', tenantId).eq('identity_id', identityId);
  if (linkedError) throw linkedError;
  const { data: emailOnly, error: emailError } = await supabase.from('tenant_user')
    .select('id, status').eq('tenant_id', tenantId).is('identity_id', null)
    .ilike('email', identity.email);
  if (emailError) throw emailError;

  for (const row of [...(linked || []), ...(emailOnly || [])]) {
    if (row.status !== 'active') continue;
    const { data: revoked, error } = await supabase.from('tenant_user')
      .update({ status: 'inactive' })
      .eq('id', row.id).eq('tenant_id', tenantId).eq('status', 'active')
      .select('id').maybeSingle();
    if (error || !revoked) throw error || new Error('Legacy team access changed during revocation');
  }
}

async function revokeTeamMembership(membership, tenantId, remove = false) {
  // Suspend unified admin access first. If a later legacy write fails, leave
  // this row inactive (fail closed) rather than reactivating an admin session.
  const { data: suspended, error: suspendError } = await supabase.from('tenant_membership')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', membership.id).eq('tenant_id', tenantId)
    .eq('role', membership.role).eq('membership_type', membership.membership_type)
    .eq('status', membership.status).select('id').maybeSingle();
  if (suspendError || !suspended) throw suspendError || new Error('Team membership changed during revocation');

  await revokeLegacyTeamUsers(membership.identity_id, tenantId);

  if (membership.member_id) {
    // Keep an already-inactive portal membership inactive; active linked rows
    // retain portal access only after legacy admin entitlement is revoked.
    const { data: demoted, error } = await supabase.from('tenant_membership')
      .update({ role: 'member', membership_type: 'member', status: membership.status, updated_at: new Date().toISOString() })
      .eq('id', membership.id).eq('tenant_id', tenantId).eq('status', 'inactive')
      .eq('role', membership.role).eq('membership_type', membership.membership_type)
      .select().maybeSingle();
    if (error || !demoted) throw error || new Error('Team membership changed during demotion');
    return demoted;
  }
  if (remove) {
    const { error } = await supabase.from('tenant_membership').delete()
      .eq('id', membership.id).eq('tenant_id', tenantId).eq('status', 'inactive');
    if (error) throw error;
    return null;
  }
  return { ...membership, status: 'inactive' };
}

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
  if (req.method !== 'GET' && !['owner', 'admin'].includes(tenantUser.role)) {
    return res.status(403).json({ error: 'Team management requires admin access' });
  }

  try {
    if (req.method === 'GET') {
      // Note: membership_type column may not exist in all deployments
      // The column was added in unify-user-identity.sql migration
      // We query all memberships for this tenant and filter in code if needed
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
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[Tenant Team] List error:', error);
        return res.status(500).json({ error: 'Failed to fetch team members' });
      }

      const teamMembers = (memberships || []).filter(isTeamMembership).map(m => ({
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

      if (!TEAM_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      let identity = null;
      const { data: foundIdentity, error: lookupError } = await supabase
        .from('tenant_identity')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();
      if (lookupError) {
        console.error('[Tenant Team] Identity lookup error:', lookupError);
        return res.status(500).json({ error: 'Failed to look up user' });
      }
      let existingIdentity = foundIdentity;
      let hasTenantPassword = false;

      const resetToken = crypto.randomUUID();
      const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      if (existingIdentity) {
        identity = existingIdentity;
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
          if (isUniqueViolation(identityError)) {
            const retry = await supabase.from('tenant_identity').select('*')
              .eq('email', normalizedEmail).maybeSingle();
            if (retry.error || !retry.data) {
              console.error('[Tenant Team] Identity race lookup error:', retry.error);
              return res.status(500).json({ error: 'Failed to look up user' });
            }
            existingIdentity = retry.data;
            identity = retry.data;
          } else {
            console.error('[Tenant Team] Create identity error:', identityError);
            return res.status(500).json({ error: 'Failed to create user' });
          }
        } else {
          identity = newIdentity;
        }
      }

      if (existingIdentity && !identity.password_hash && !identity.google_id) {
        const { data: tenantCreds, error: credsError } = await supabase
          .from('tenant_membership_credentials')
          .select('password_hash').eq('identity_id', identity.id).eq('tenant_id', tenantId).maybeSingle();
        if (credsError) {
          console.error('[Tenant Team] Credential lookup error:', credsError);
          return res.status(500).json({ error: 'Failed to look up account credentials' });
        }
        hasTenantPassword = !!tenantCreds?.password_hash;
      }

      let membership;
      try {
        membership = await findMembership(identity.id, tenantId);
      } catch (error) {
        console.error('[Tenant Team] Membership lookup error:', error);
        return res.status(500).json({ error: 'Failed to look up team membership' });
      }
      if (membership && isTeamMembership(membership)) {
        return res.status(400).json({ error: 'This user is already a team member' });
      }
      if (membership) {
        if (membership.role !== 'member' || membership.membership_type !== 'member' || membership.status !== 'active') {
          return res.status(409).json({ error: 'This membership cannot be promoted; review its current status' });
        }
        // Compare-and-set: concurrent invitations cannot overwrite the winning role.
        const { data: promoted, error: promotionError } = await supabase
          .from('tenant_membership')
          .update({ role, membership_type: 'owner', updated_at: new Date().toISOString() })
          .eq('id', membership.id).eq('identity_id', identity.id).eq('tenant_id', tenantId)
          .eq('role', 'member').eq('membership_type', 'member').eq('status', 'active')
          .select().maybeSingle();
        if (promotionError) {
          console.error('[Tenant Team] Promotion error:', promotionError);
          return res.status(500).json({ error: 'Failed to add team member' });
        }
        if (!promoted) {
          // The row changed after our read. Never overwrite the new authoritative state.
          return res.status(409).json({ error: 'Membership changed during invitation. Refresh the team and try again.' });
        }
        membership = promoted;
      } else {
        const { data: inserted, error: membershipError } = await supabase
          .from('tenant_membership')
          .insert({
            identity_id: identity.id, tenant_id: tenantId, role,
            membership_type: 'owner', status: 'active', is_default: false
          }).select().single();
        if (membershipError) {
          if (isUniqueViolation(membershipError)) {
            try {
              const winner = await findMembership(identity.id, tenantId);
              if (winner && isTeamMembership(winner)) {
                return res.status(400).json({ error: 'This user is already a team member' });
              }
            } catch (error) {
              console.error('[Tenant Team] Membership race lookup error:', error);
              return res.status(500).json({ error: 'Failed to look up team membership' });
            }
            return res.status(409).json({ error: 'Membership changed during invitation. Refresh the team and try again.' });
          }
          console.error('[Tenant Team] Create membership error:', membershipError);
          return res.status(500).json({ error: 'Failed to add team member' });
        }
        membership = inserted;
      }

      // Only a successful grant may rotate the shared reset token.
      if (existingIdentity && !identity.password_hash && !identity.google_id && !hasTenantPassword) {
        const { error: updateError } = await supabase.from('tenant_identity')
          .update({ reset_token: resetToken, reset_token_expires: resetExpires.toISOString(), updated_at: new Date().toISOString() })
          .eq('id', identity.id);
        if (updateError) {
          console.error('[Tenant Team] Update identity reset token error:', updateError);
          return res.status(500).json({ error: 'Team access granted but failed to prepare invitation' });
        }
        identity.reset_token = resetToken;
      }

      const isNewUser = !existingIdentity;

      const { data: tenant } = await supabase
        .from('tenant')
        .select('name, slug')
        .eq('id', tenantId)
        .single();

      const tenantName = tenant?.name || 'the admin portal';
      const tenantSlug = tenant?.slug;

      const host = req.headers.host || 'iconn.app';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const adminHost = tenantSlug ? `${tenantSlug}.iconn.app` : host;
      const invitationToken = existingIdentity ? (!identity.password_hash && !identity.google_id && !hasTenantPassword ? resetToken : null) : resetToken;
      const setPasswordUrl = `${protocol}://${adminHost}/admin/login?setup=${invitationToken}&email=${encodeURIComponent(normalizedEmail)}`;

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
            <p>${invitationToken ? 'Set up your account or log in to access the admin portal:' : 'You can log in with your existing account:'}</p>
            <p style="margin: 30px 0; text-align: center;">
              <a href="${protocol}://${adminHost}/admin/login" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
                Go to Admin Portal
              </a>
            </p>
            ${invitationToken ? '<p>To set your password, use this link (expires in 7 days):</p>' : ''}
            ${invitationToken ? `
            <p style="text-align: center;">
              <a href="${setPasswordUrl}" style="color: #4f46e5; text-decoration: underline;">
                Set Password
              </a>
            </p>` : ''}
          </div>
        `;

        // Admin/team invitation — platform→tenant-owner system message,
        // must come from mail.iconn.app.
        await sendEmail({
          to: normalizedEmail,
          subject: emailSubject,
          html: emailHtml,
          tenantId,
          systemEmail: true,
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

      if (!membership || !isTeamMembership(membership)) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (membership.identity_id === tenantUser._sessionIdentityId && role && role !== membership.role) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }

      const updateData = { updated_at: new Date().toISOString() };
      if (role) {
        if (!TEAM_ROLES.includes(role)) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        updateData.role = role;
      }
      if (status) {
        const validStatuses = ['active', 'inactive'];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        if (status === 'inactive' && membership.member_id) {
          // A shared row also supplies portal membership: revoke team access only.
          updateData.role = 'member';
          updateData.membership_type = 'member';
          updateData.status = 'active';
        } else {
          updateData.status = status;
        }
      }

      if (status === 'inactive') {
        if (membership.identity_id === tenantUser._sessionIdentityId) {
          return res.status(400).json({ error: 'You cannot deactivate your own team access' });
        }
        if (membership.status !== 'active') {
          return res.status(409).json({ error: 'Team membership is already inactive' });
        }
        if (membership.role === 'owner') {
          const { data: owners, error: ownersError } = await supabase.from('tenant_membership')
            .select('id').eq('tenant_id', tenantId).eq('role', 'owner').eq('status', 'active');
          if (ownersError) return res.status(500).json({ error: 'Failed to verify team owners' });
          if ((owners || []).length <= 1) return res.status(400).json({ error: 'Cannot deactivate the last owner' });
        }
        try {
          const updated = await revokeTeamMembership(membership, tenantId);
          return res.json({ success: true, membership: updated });
        } catch (error) {
          console.error('[Tenant Team] Revoke error:', error);
          return res.status(500).json({ error: 'Failed to revoke team access; membership may remain inactive' });
        }
      }

      const { data: updated, error } = await supabase
        .from('tenant_membership')
        .update(updateData)
        .eq('id', membership_id).eq('tenant_id', tenantId)
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

      if (!membership || !isTeamMembership(membership)) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (membership.identity_id === tenantUser._sessionIdentityId) {
        return res.status(400).json({ error: 'You cannot remove yourself from the team' });
      }

      const { data: allOwners, error: ownersError } = await supabase
        .from('tenant_membership')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('role', 'owner').eq('status', 'active');
      if (ownersError) return res.status(500).json({ error: 'Failed to verify team owners' });

      if ((allOwners?.length || 0) <= 1 && membership.role === 'owner') {
        return res.status(400).json({ error: 'Cannot remove the last owner' });
      }

      try {
        await revokeTeamMembership(membership, tenantId, true);
      } catch (error) {
        console.error('[Tenant Team] Delete error:', error);
        return res.status(500).json({ error: 'Failed to revoke team access; membership may remain inactive' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Tenant Team] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
