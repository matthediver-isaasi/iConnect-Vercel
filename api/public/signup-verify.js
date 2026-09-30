/**
 * POST /api/public/signup-verify
 *
 * Step 2 of the self-serve signup flow. Consumes the verification token,
 * provisions the tenant with plan_code='free' and onboarding_status='pending',
 * creates a tenant_user session, and returns the portal URL + admin path so
 * the client can redirect into the onboarding wizard.
 */

import { supabase } from '../_lib/database.js';
import {
  checkSlugAvailability,
  checkExistingIdentity,
  checkLegacyAccount,
  provisionTenant,
  getTenantPortalUrl,
} from '../_lib/provisionTenantService.js';
import { createSession } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const { token, email } = req.body || {};
  if (!token || !email) return res.status(400).json({ error: 'Token and email are required' });

  const { data: signup, error: lookupError } = await supabase
    .from('tenant_signup')
    .select('*')
    .eq('verification_token', token)
    .ilike('email', email.toLowerCase())
    .single();

  if (lookupError || !signup) {
    return res.status(400).json({ error: 'Invalid or expired verification link' });
  }

  if (signup.status === 'consumed' && signup.provisioned_tenant_id) {
    return res.status(409).json({ error: 'This signup link has already been used. Please log in.' });
  }

  if (signup.status !== 'pending' || new Date(signup.verification_expires) < new Date()) {
    return res.status(400).json({ error: 'This verification link has expired. Please sign up again.' });
  }

  // Re-check slug + existing identity at provision-time (state may have moved since signup-start)
  if (!(await checkSlugAvailability(signup.slug))) {
    await supabase.from('tenant_signup').update({ status: 'expired' }).eq('id', signup.id);
    return res.status(409).json({ error: 'That subdomain has just been taken. Please sign up again with a different one.' });
  }

  const existingIdentity = await checkExistingIdentity(signup.email, null);
  if (!existingIdentity) {
    const legacy = await checkLegacyAccount(signup.email, null);
    if (legacy.exists) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
    }
  }

  try {
    const result = await provisionTenant({
      tenantName: signup.tenant_name,
      slug: signup.slug,
      adminEmail: signup.email,
      adminFirstName: signup.admin_first_name,
      adminLastName: signup.admin_last_name,
      // We pre-hashed in signup-start, but provisionTenant expects the raw
      // password so it can hash again. For password-only signups we have to
      // re-hash; signup-start stored the hash so it never lives in cleartext.
      // To avoid double-hashing, pass null here and inject the stored hash
      // directly post-creation? Simpler: write directly via DB instead.
      // For v1 we accept the small wrinkle: re-bcrypting the existing hash
      // would break logins, so we pass an internal flag via env-less channel.
      // Workaround: re-derive by storing the raw password in transit only
      // (signup row keeps the bcrypt hash), and on verify we don't have the
      // raw password — so we must DB-write the credentials directly.
      // → Implemented below: provision with no password, then patch.
      password: null,
      googleId: null,
      linkExistingAccount: !!existingIdentity,
      isPlatformProvision: false,
      generateSetupToken: false,
      existingIdentity,
      planCode: 'free',
      onboardingStatus: 'pending',
    });

    if (!result?.success) {
      return res.status(500).json({ error: 'Provisioning failed. Please try again.' });
    }

    // Backfill credentials with the bcrypt hash we captured in signup-start.
    if (signup.password_hash) {
      const identityId = result.identity?.id || null;
      const tenantId = result.tenant.id;
      if (identityId) {
        await supabase.from('tenant_membership_credentials').upsert({
          identity_id: identityId,
          tenant_id: tenantId,
          email: signup.email,
          password_hash: signup.password_hash,
          is_temporary: false,
        }, { onConflict: 'identity_id,tenant_id' });
      } else if (result.tenantUser?.id) {
        await supabase.from('tenant_user_credentials').upsert({
          tenant_user_id: result.tenantUser.id,
          email: signup.email,
          password_hash: signup.password_hash,
          is_temporary: false,
        }, { onConflict: 'tenant_user_id' });
      }
    }

    await supabase
      .from('tenant_signup')
      .update({
        status: 'consumed',
        verified_at: new Date().toISOString(),
        consumed_at: new Date().toISOString(),
        provisioned_tenant_id: result.tenant.id,
      })
      .eq('id', signup.id);

    // Create a session so the user lands directly in the wizard
    try {
      await createSession(res, {
        tenantUserId: result.tenantUser.id,
        tenantId: result.tenant.id,
        email: signup.email,
      });
    } catch (sessErr) {
      console.error('[signup-verify] session create failed (non-fatal):', sessErr.message);
    }

    return res.status(200).json({
      ok: true,
      tenant: {
        id: result.tenant.id,
        slug: result.tenant.slug,
        name: result.tenant.name,
        portalUrl: getTenantPortalUrl(result.tenant.slug),
        adminPath: '/admin/onboarding',
      },
    });
  } catch (err) {
    console.error('[signup-verify] provision error:', err);
    return res.status(500).json({ error: err.message || 'Provisioning failed' });
  }
}
