import bcrypt from 'bcryptjs';
import { supabase } from '../../_lib/database.js';
import { createSession } from '../../_lib/session.js';

// Public, tokenised team-member invitation endpoint (Task #3392).
//
// GET  -> returns the invite context (inviter, organization, tenant branding,
//         invitee email, validity state). If a member already exists with the
//         invitee's email, `existingAccount: true` tells the client to send
//         the visitor to the login page instead of the signup form.
// POST -> body { first_name, last_name, password }. Atomically claims the
//         still-pending token, creates the member record (email lowercased),
//         links the organization carried by the invite, stores credentials and
//         signs the new member in. Expired / used / superseded tokens return a
//         friendly state instead of an error.

function isExpired(row) {
  return !!row.expires_at && new Date(row.expires_at).getTime() < Date.now();
}

function effectiveStatus(row) {
  if (row.status === 'pending' && isExpired(row)) return 'expired';
  return row.status;
}

async function findExistingMember(row) {
  const { data } = await supabase
    .from('member')
    .select('id, email, organization_id')
    .eq('tenant_id', row.tenant_id)
    .ilike('email', row.email)
    .maybeSingle();
  return data || null;
}

async function buildContext(row) {
  const [{ data: tenant }, orgResult, existingMember] = await Promise.all([
    supabase.from('tenant').select('name, logo_url, primary_color').eq('id', row.tenant_id).maybeSingle(),
    row.organization_id
      ? supabase.from('organization').select('id, name').eq('id', row.organization_id).maybeSingle()
      : Promise.resolve({ data: null }),
    findExistingMember(row),
  ]);
  return {
    status: effectiveStatus(row),
    email: row.email,
    inviter_name: row.inviter_name || null,
    organization: orgResult?.data ? { name: orgResult.data.name || null } : null,
    tenant: tenant
      ? { name: tenant.name || null, logo_url: tenant.logo_url || null, primary_color: tenant.primary_color || null }
      : null,
    expires_at: row.expires_at || null,
    existingAccount: !!existingMember,
  };
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  const { data: row, error: tokenErr } = await supabase
    .from('team_member_invitation')
    .select('id, token, tenant_id, email, organization_id, invited_by_member_id, inviter_name, status, expires_at, accepted_at, member_id')
    .eq('token', token)
    .maybeSingle();

  if (tokenErr || !row) {
    return res.status(404).json({ error: 'This invitation link is invalid or has been removed.' });
  }

  if (req.method === 'GET') {
    return res.json(await buildContext(row));
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // POST — complete signup against the token.
  const status = effectiveStatus(row);
  if (status !== 'pending') {
    return res.json({ ...(await buildContext(row)), alreadyHandled: status !== 'expired' });
  }

  const firstName = (req.body?.first_name || '').toString().trim();
  const lastName = (req.body?.last_name || '').toString().trim();
  const password = (req.body?.password || '').toString();

  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'First and last name are required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const email = row.email.toLowerCase();

  // Existing account with this email — direct the visitor to log in instead of
  // duplicating the account.
  const existingMember = await findExistingMember(row);
  if (existingMember) {
    return res.json({ ...(await buildContext(row)), existingAccount: true });
  }

  // Atomically claim the token: only move it from 'pending'.
  const acceptedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('team_member_invitation')
    .update({ status: 'accepted', accepted_at: acceptedAt })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (claimErr) {
    console.error('[TeamInvite] Failed to claim token:', claimErr.message);
    return res.status(500).json({ error: 'Could not complete signup. Please try again.' });
  }
  if (!claimed) {
    const { data: fresh } = await supabase
      .from('team_member_invitation')
      .select('id, token, tenant_id, email, organization_id, invited_by_member_id, inviter_name, status, expires_at, accepted_at, member_id')
      .eq('id', row.id)
      .maybeSingle();
    return res.json({ ...(await buildContext(fresh || row)), alreadyHandled: true });
  }

  // All auth records (member, identity, per-tenant credentials, tenant
  // membership, legacy credentials) are REQUIRED. On any failure, undo every
  // row this request created and roll the token back to pending so a retry
  // works — never return success or a session for an account that can't log in.
  const created = { memberId: null, identityId: null, tenantCredId: null, membershipId: null, legacyCredId: null };
  const rollback = async () => {
    try {
      if (created.legacyCredId) await supabase.from('member_credentials').delete().eq('id', created.legacyCredId);
      if (created.membershipId) await supabase.from('tenant_membership').delete().eq('id', created.membershipId);
      if (created.tenantCredId) await supabase.from('tenant_membership_credentials').delete().eq('id', created.tenantCredId);
      if (created.memberId) await supabase.from('member').delete().eq('id', created.memberId);
      if (created.identityId) await supabase.from('tenant_identity').delete().eq('id', created.identityId);
    } catch (e) {
      console.error('[TeamInvite] Rollback failed:', e.message);
    }
    await supabase
      .from('team_member_invitation')
      .update({ status: 'pending', accepted_at: null })
      .eq('id', row.id)
      .eq('status', 'accepted');
  };
  const failSignup = async (logMsg) => {
    console.error('[TeamInvite] ' + logMsg);
    await rollback();
    return res.status(500).json({ error: 'Could not create your account. Please try again.' });
  };

  try {
    // 1) Create the member record (email lowercased — Task #3392; login lookup
    //    depends on lowercase storage).
    const { data: member, error: memberErr } = await supabase
      .from('member')
      .insert({
        tenant_id: row.tenant_id,
        email,
        first_name: firstName,
        last_name: lastName,
        organization_id: row.organization_id || null,
        login_enabled: true,
      })
      .select('*')
      .maybeSingle();

    if (memberErr || !member) {
      return await failSignup(`Failed to create member: ${memberErr?.message}`);
    }
    created.memberId = member.id;

    const passwordHash = await bcrypt.hash(password, 12);

    // 2) Identity (required): reuse an existing tenant_identity for this email
    //    or create one.
    let identityId = null;
    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (identity) {
      identityId = identity.id;
    } else {
      const { data: newIdentity, error: identityErr } = await supabase
        .from('tenant_identity')
        .insert({ email, first_name: firstName, last_name: lastName, is_temporary: false })
        .select('id')
        .maybeSingle();
      if (identityErr || !newIdentity) {
        return await failSignup(`Failed to create identity: ${identityErr?.message}`);
      }
      identityId = newIdentity.id;
      created.identityId = identityId;
    }

    const { error: linkErr } = await supabase.from('member').update({ identity_id: identityId }).eq('id', member.id);
    if (linkErr) {
      return await failSignup(`Failed to link member to identity: ${linkErr.message}`);
    }
    member.identity_id = identityId;

    // 3) Per-tenant credentials (required — primary password storage).
    const { data: existingTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identityId)
      .eq('tenant_id', row.tenant_id)
      .maybeSingle();
    if (existingTenantCreds) {
      const { error: credUpdErr } = await supabase
        .from('tenant_membership_credentials')
        .update({ password_hash: passwordHash, failed_attempts: 0, locked_until: null })
        .eq('id', existingTenantCreds.id);
      if (credUpdErr) {
        return await failSignup(`Failed to update tenant credentials: ${credUpdErr.message}`);
      }
    } else {
      const { data: newCred, error: credInsErr } = await supabase
        .from('tenant_membership_credentials')
        .insert({ identity_id: identityId, tenant_id: row.tenant_id, password_hash: passwordHash })
        .select('id')
        .maybeSingle();
      if (credInsErr || !newCred) {
        return await failSignup(`Failed to create tenant credentials: ${credInsErr?.message}`);
      }
      created.tenantCredId = newCred.id;
    }

    // 4) tenant_membership (required) so the login resolver can find this member.
    const { data: existingMembership } = await supabase
      .from('tenant_membership')
      .select('id')
      .eq('identity_id', identityId)
      .eq('tenant_id', row.tenant_id)
      .maybeSingle();
    if (!existingMembership) {
      const { data: newMembership, error: membershipErr } = await supabase
        .from('tenant_membership')
        .insert({
          identity_id: identityId,
          tenant_id: row.tenant_id,
          member_id: member.id,
          role: 'member',
          membership_type: 'member',
          status: 'active',
          is_default: true,
        })
        .select('id')
        .maybeSingle();
      if (membershipErr || !newMembership) {
        return await failSignup(`Failed to create tenant membership: ${membershipErr?.message}`);
      }
      created.membershipId = newMembership.id;
    }

    // 5) Legacy member_credentials (required for the login fallback path).
    const { data: legacyCred, error: legacyCredErr } = await supabase
      .from('member_credentials')
      .insert({
        member_id: member.id,
        email,
        password_hash: passwordHash,
        is_temp_password: false,
        password_set_at: acceptedAt,
      })
      .select('id')
      .maybeSingle();
    if (legacyCredErr || !legacyCred) {
      return await failSignup(`Failed to create legacy credentials: ${legacyCredErr?.message}`);
    }
    created.legacyCredId = legacyCred.id;

    // Link the created member onto the consumed invite.
    await supabase
      .from('team_member_invitation')
      .update({ member_id: member.id })
      .eq('id', row.id);

    // 6) Sign the new member in (same session shape as /api/auth/login).
    let signedIn = false;
    try {
      await createSession(res, {
        memberId: member.id,
        memberEmail: email,
        organizationId: member.organization_id || null,
        tenantId: row.tenant_id,
        roleId: member.role_id || null,
        identityId: identityId,
        userType: 'member',
      }, { req });
      signedIn = true;
    } catch (sessionErr) {
      console.error('[TeamInvite] Failed to create session:', sessionErr.message);
    }

    return res.json({
      success: true,
      status: 'accepted',
      signedIn,
      email,
    });
  } catch (err) {
    console.error('[TeamInvite] Signup failed:', err);
    await rollback();
    return res.status(500).json({ error: 'Could not complete signup. Please try again.' });
  }
}
