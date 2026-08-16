import bcrypt from 'bcryptjs';
import { createBearerSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

/**
 * Token-based login for native/mobile clients (e.g. the Event Check-in app).
 *
 * This is an ADDITIVE sibling of the web cookie login flows
 * (tenant-identity-login.js / tenant-switch.js). It reuses the exact same
 * unified-identity authentication, per-tenant password isolation, lockout
 * logic, and session shapes — but issues an opaque bearer token instead of
 * setting a cookie, and resolves the tenant explicitly from the request
 * (there is no subdomain to infer it from on a native client).
 *
 * Request body: { email, password, tenantId? }
 * Responses:
 *  - Multiple organisations and no tenantId  -> { success, requiresTenantSelection, organisations[] }
 *  - Resolved                                -> { success, token, expiresAt, user, tenant, hasMultipleTenants }
 */
export default async function handler(req, res) {
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
    return res.status(503).json({ success: false, error: 'Database not configured' });
  }

  try {
    const { email, password, tenantId: explicitTenantId } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase();

    // 1. Authenticate against the unified identity system.
    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (identityError || !identity) {
      console.log('[Mobile Login] No identity found for:', normalizedEmail);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Per-tenant password isolation: tenant-specific credentials take
    // precedence over the shared identity password when a tenant is specified.
    let tenantCreds = null;
    if (explicitTenantId) {
      const { data } = await supabase
        .from('tenant_membership_credentials')
        .select('*')
        .eq('identity_id', identity.id)
        .eq('tenant_id', explicitTenantId)
        .single();
      tenantCreds = data;
    }

    const passwordHash = tenantCreds?.password_hash || identity.password_hash;
    const credSource = tenantCreds?.password_hash ? tenantCreds : identity;
    const usedTenantSpecificCreds = !!tenantCreds?.password_hash;

    if (!passwordHash) {
      return res.status(401).json({ success: false, error: 'Password not set', needsPasswordSetup: true });
    }

    if (credSource.locked_until && new Date(credSource.locked_until) > new Date()) {
      return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
    }

    const isValid = await bcrypt.compare(password, passwordHash);

    if (!isValid) {
      const newFailedAttempts = (credSource.failed_attempts || 0) + 1;
      const updates = { failed_attempts: newFailedAttempts };
      if (newFailedAttempts >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      if (usedTenantSpecificCreds && tenantCreds) {
        await supabase.from('tenant_membership_credentials').update(updates).eq('id', tenantCreds.id);
      } else {
        await supabase.from('tenant_identity').update(updates).eq('id', identity.id);
      }
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Reset failed attempts on success.
    if (usedTenantSpecificCreds && tenantCreds) {
      await supabase
        .from('tenant_membership_credentials')
        .update({ failed_attempts: 0, locked_until: null, last_login: new Date().toISOString() })
        .eq('id', tenantCreds.id);
    } else {
      await supabase
        .from('tenant_identity')
        .update({ failed_attempts: 0, locked_until: null, last_login: new Date().toISOString() })
        .eq('id', identity.id);
    }

    // 2. Resolve the organisations (active memberships) for this identity.
    // Unlike the admin web login, mobile check-in also serves member-level staff
    // whose role grants the events.event-checkin feature, so we offer ALL active
    // memberships and let the endpoint's RBAC make the final decision.
    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identity.id)
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .order('last_accessed', { ascending: false, nullsFirst: false });

    if (membershipError || !memberships || memberships.length === 0) {
      console.log('[Mobile Login] No active memberships for:', normalizedEmail);
      return res.status(403).json({ success: false, error: 'No active organisation memberships found.' });
    }

    // 3. Resolve the explicit tenant.
    let selectedMembership;
    if (explicitTenantId) {
      selectedMembership = memberships.find(m => m.tenant_id === explicitTenantId);
      if (!selectedMembership) {
        return res.status(403).json({ success: false, error: 'You do not have access to this organisation.' });
      }
    } else if (memberships.length === 1) {
      selectedMembership = memberships[0];
    } else {
      // Multiple organisations and no explicit choice: ask the app to pick one.
      return res.json({
        success: true,
        requiresTenantSelection: true,
        identity: {
          id: identity.id,
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name
        },
        organisations: memberships.map(m => ({
          id: m.tenant_id,
          name: m.tenant?.name,
          slug: m.tenant?.slug,
          logo_url: m.tenant?.logo_url,
          role: m.role,
          membership_type: m.membership_type,
          is_default: m.is_default
        }))
      });
    }

    const tenantId = selectedMembership.tenant_id;

    await supabase
      .from('tenant_membership')
      .update({ last_accessed: new Date().toISOString() })
      .eq('id', selectedMembership.id);

    // 4. Build the session, mirroring the web's tenant_user vs member shapes so
    // all downstream RBAC (getTenantContext, hasAdminAccess, hasFeatureAccess)
    // behaves identically to a cookie session. Admin access is conveyed by an
    // owner/admin role (or legacy membership_type='owner').
    const isAdmin =
      selectedMembership.role === 'owner' ||
      selectedMembership.role === 'admin' ||
      selectedMembership.membership_type === 'owner';

    let sessionData;
    let userPayload;

    if (isAdmin) {
      // Use the actual tenant_user.id when one exists (portal SSO compatibility),
      // otherwise fall back to identity.id — the unified-identity path in
      // getSessionTenantUser resolves either form.
      const { data: tenantUserRecord } = await supabase
        .from('tenant_user')
        .select('id, email')
        .eq('identity_id', identity.id)
        .eq('tenant_id', tenantId)
        .single();

      const effectiveTenantUserId = tenantUserRecord?.id || identity.id;

      sessionData = {
        identityId: identity.id,
        tenantUserId: effectiveTenantUserId,
        tenantUserEmail: identity.email,
        tenantId,
        membershipId: selectedMembership.id,
        membershipRole: selectedMembership.role,
        userType: 'tenant_user'
      };

      userPayload = {
        id: effectiveTenantUserId,
        email: identity.email,
        first_name: identity.first_name,
        last_name: identity.last_name,
        role: selectedMembership.role,
        userType: 'tenant_user'
      };
    } else {
      // Member-level staff: resolve the member record for this tenant.
      let member = null;
      if (selectedMembership.member_id) {
        const { data } = await supabase
          .from('member')
          .select('*')
          .eq('id', selectedMembership.member_id)
          .single();
        member = data;
      }
      if (!member) {
        const { data } = await supabase
          .from('member')
          .select('*')
          .eq('identity_id', identity.id)
          .eq('tenant_id', tenantId)
          .single();
        member = data;
      }

      if (!member) {
        return res.status(404).json({ success: false, error: 'Member record not found for this organisation.' });
      }

      if (member.login_enabled === false) {
        return res.status(403).json({ success: false, error: 'Login is disabled for this account.' });
      }

      // Membership pause (Task #3586): paused members cannot log in via mobile.
      if (member.membership_paused === true) {
        return res.status(403).json({ success: false, error: 'Your membership is currently paused. Please contact an administrator.' });
      }

      sessionData = {
        memberId: member.id,
        memberEmail: member.email,
        tenantId,
        identityId: identity.id,
        membershipId: selectedMembership.id,
        userType: 'member'
      };

      userPayload = {
        id: member.id,
        email: member.email,
        first_name: member.first_name,
        last_name: member.last_name,
        role_id: member.role_id || null,
        userType: 'member'
      };
    }

    const created = await createBearerSession(sessionData);
    if (!created) {
      return res.status(500).json({ success: false, error: 'Failed to issue token' });
    }

    console.log('[Mobile Login] Success for:', normalizedEmail, 'tenant:', selectedMembership.tenant?.name, 'type:', sessionData.userType);

    return res.json({
      success: true,
      token: created.token,
      expiresAt: created.expiresAt,
      tokenType: 'Bearer',
      user: userPayload,
      tenant: selectedMembership.tenant
        ? {
            id: selectedMembership.tenant.id,
            name: selectedMembership.tenant.name,
            slug: selectedMembership.tenant.slug,
            logo_url: selectedMembership.tenant.logo_url
          }
        : { id: tenantId },
      hasMultipleTenants: memberships.length > 1
    });
  } catch (error) {
    console.error('[Mobile Login] Error:', error);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
}
