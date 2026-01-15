import bcrypt from 'bcryptjs';
import { supabase } from '../_lib/database.js';
import { createSession } from '../_lib/session.js';

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
    const { token, email, password } = req.body;

    if (!token || !email || !password) {
      return res.status(400).json({ success: false, error: 'Token, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    // First find identity by email
    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (identityError || !identity) {
      return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });
    }

    // Check token in tenant_membership_credentials first (new per-tenant system)
    let tenantCreds = null;
    let tenantId = null;
    
    const { data: tenantCredsData } = await supabase
      .from('tenant_membership_credentials')
      .select('*, tenant:tenant_id(id, name, slug)')
      .eq('identity_id', identity.id)
      .eq('reset_token', token)
      .single();
    
    if (tenantCredsData) {
      console.log('[Set Admin Password] Found token in tenant_membership_credentials');
      tenantCreds = tenantCredsData;
      tenantId = tenantCredsData.tenant_id;
      
      if (tenantCreds.reset_token_expires && new Date(tenantCreds.reset_token_expires) < new Date()) {
        return res.status(400).json({ success: false, error: 'Setup link has expired. Please contact your administrator.' });
      }
    } else {
      // Fall back to checking tenant_identity for backwards compatibility
      if (identity.reset_token !== token) {
        return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });
      }
      
      if (identity.reset_token_expires && new Date(identity.reset_token_expires) < new Date()) {
        return res.status(400).json({ success: false, error: 'Setup link has expired. Please contact your administrator.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Get membership to determine tenant_id if not already set
    const { data: membership } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identity.id)
      .eq('membership_type', 'owner')
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .limit(1)
      .single();

    if (!tenantId && membership) {
      tenantId = membership.tenant_id;
    }

    // Save password to tenant_membership_credentials (per-tenant password isolation)
    if (tenantId) {
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
            password_hash: passwordHash,
            reset_token: null,
            reset_token_expires: null,
            failed_attempts: 0,
            locked_until: null
          })
          .eq('id', existingTenantCreds.id);

        if (tenantCredError) {
          console.error('[Set Admin Password] Tenant creds update error:', tenantCredError);
          return res.status(500).json({ success: false, error: 'Failed to set password' });
        }
        console.log('[Set Admin Password] Updated password in tenant_membership_credentials');
      } else {
        const { error: insertError } = await supabase
          .from('tenant_membership_credentials')
          .insert({
            identity_id: identity.id,
            tenant_id: tenantId,
            password_hash: passwordHash
          });

        if (insertError) {
          console.error('[Set Admin Password] Tenant creds insert error:', insertError);
          return res.status(500).json({ success: false, error: 'Failed to set password' });
        }
        console.log('[Set Admin Password] Created password in tenant_membership_credentials');
      }
    }

    // Clear reset tokens on tenant_identity (but DO NOT update password_hash - that would break tenant isolation)
    // Only update shared password if this user has NO tenant-specific credentials anywhere
    const { data: anyTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identity.id)
      .limit(1);
    
    const hasAnyTenantSpecificCreds = anyTenantCreds && anyTenantCreds.length > 0;
    
    const identityUpdate = { 
      is_temporary: false,
      reset_token: null,
      reset_token_expires: null,
      updated_at: new Date().toISOString()
    };
    
    // Only update shared password if user has NO tenant-specific credentials (first-time legacy migration)
    if (!hasAnyTenantSpecificCreds) {
      identityUpdate.password_hash = passwordHash;
      console.log('[Set Admin Password] Updated shared identity password (no tenant-specific creds exist yet)');
    } else {
      console.log('[Set Admin Password] NOT updating shared identity password (tenant-specific creds exist for isolation)');
    }
    
    const { error: updateError } = await supabase
      .from('tenant_identity')
      .update(identityUpdate)
      .eq('id', identity.id);

    if (updateError) {
      console.error('[Set Admin Password] Identity update error (non-critical):', updateError);
    }

    console.log(`[Set Admin Password] Password set for identity ${identity.id} (${identity.email})`);

    if (membership?.tenant) {
      const sessionData = {
        identityId: identity.id,
        tenantUserId: identity.id,
        tenantId: membership.tenant_id,
        email: identity.email,
        firstName: identity.first_name,
        lastName: identity.last_name,
        role: membership.role,
        userType: 'tenant_user'
      };

      await createSession(res, sessionData);

      return res.json({
        success: true,
        authenticated: true,
        tenantUser: {
          id: identity.id,
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name,
          role: membership.role
        },
        tenant: {
          id: membership.tenant.id,
          name: membership.tenant.name,
          slug: membership.tenant.slug
        }
      });
    }

    return res.json({ success: true, message: 'Password set successfully. Please log in.' });
  } catch (error) {
    console.error('[Set Admin Password] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to set password' });
  }
}
