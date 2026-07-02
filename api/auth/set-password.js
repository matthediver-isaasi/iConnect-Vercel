import bcrypt from 'bcryptjs';
import { createSession } from '../_lib/session.js';
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
    const { email, password, token } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    // Resolve tenant from request for tenant-specific password storage
    const requestTenant = await resolveTenantFromRequest(req);
    const requestTenantId = requestTenant?.id || null;
    console.log('[Auth SetPassword] Tenant context:', requestTenantId, requestTenant?.slug);

    // Find member - filter by tenant if available
    // Use ilike for case-insensitive email matching
    let memberQuery = supabase
      .from('member')
      .select('id, email, tenant_id, organization_id')
      .ilike('email', email.toLowerCase());
    
    if (requestTenantId) {
      memberQuery = memberQuery.eq('tenant_id', requestTenantId);
    }
    
    const { data: member, error: memberError } = await memberQuery.single();

    if (memberError || !member) {
      console.log('[Auth SetPassword] Member not found for:', email, 'tenant:', requestTenantId);
      return res.status(404).json({ success: false, error: 'Member not found' });
    }

    // Determine the tenant to use for credentials
    const tenantId = requestTenantId || member.tenant_id;
    if (!tenantId) {
      console.error('[Auth SetPassword] No tenant context available');
      return res.status(400).json({ success: false, error: 'Unable to determine tenant context' });
    }

    // Get identity for this email
    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    let tenantCredsRecord = null;

    if (token) {
      console.log(`[Auth] Validating token for member ${member.id}, token prefix: ${token.substring(0, 8)}...`);
      
      let tokenValid = false;
      let tokenExpiry = null;
      
      // First check tenant_membership_credentials (new per-tenant system)
      if (identity) {
        const { data: tenantCreds } = await supabase
          .from('tenant_membership_credentials')
          .select('id, reset_token, reset_token_expires')
          .eq('identity_id', identity.id)
          .eq('tenant_id', tenantId)
          .eq('reset_token', token)
          .single();
        
        if (tenantCreds) {
          console.log('[Auth] Found token in tenant_membership_credentials');
          tokenValid = true;
          tokenExpiry = tenantCreds.reset_token_expires;
          tenantCredsRecord = tenantCreds;
        }
      }
      
      // Fall back to tenant_identity for backwards compatibility
      if (!tokenValid && identity) {
        const { data: identityWithToken } = await supabase
          .from('tenant_identity')
          .select('id, reset_token, reset_token_expires')
          .eq('id', identity.id)
          .eq('reset_token', token)
          .single();
        
        if (identityWithToken) {
          console.log('[Auth] Found token in tenant_identity (legacy)');
          tokenValid = true;
          tokenExpiry = identityWithToken.reset_token_expires;
        }
      }
      
      // Fall back to member_credentials for backwards compatibility
      if (!tokenValid) {
        const { data: credentials } = await supabase
          .from('member_credentials')
          .select('id, reset_token, reset_token_expires')
          .eq('member_id', member.id)
          .eq('reset_token', token)
          .single();
        
        if (credentials) {
          console.log('[Auth] Found token in member_credentials (legacy)');
          tokenValid = true;
          tokenExpiry = credentials.reset_token_expires;
        }
      }
      
      if (!tokenValid) {
        console.error('[Auth] Token validation failed - token not found');
        return res.status(401).json({ success: false, error: 'Invalid or expired reset token. Please request a new password reset.' });
      }

      if (tokenExpiry && new Date(tokenExpiry) < new Date()) {
        console.log('[Auth] Token expired at:', tokenExpiry);
        return res.status(401).json({ success: false, error: 'Reset token has expired. Please request a new one.' });
      }
      
      console.log('[Auth] Token validated successfully');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Handle identity - create if doesn't exist
    let identityId = identity?.id;

    if (!identity) {
      // Create new identity
      const { data: fullMemberData } = await supabase
        .from('member')
        .select('first_name, last_name, organization_id')
        .eq('id', member.id)
        .single();

      const { data: newIdentity, error: identityInsertError } = await supabase
        .from('tenant_identity')
        .insert({
          email: email.toLowerCase(),
          first_name: fullMemberData?.first_name,
          last_name: fullMemberData?.last_name,
          is_temporary: false
        })
        .select()
        .single();
      
      if (identityInsertError) {
        console.error('[Auth] Failed to create identity:', identityInsertError);
        return res.status(500).json({ success: false, error: 'Failed to create account' });
      }
      identityId = newIdentity.id;
      console.log('[Auth] Created new identity for:', email);
    }

    // Save password to tenant_membership_credentials (per-tenant password isolation)
    // This is the primary password storage - each tenant has its own password
    const { data: existingTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .single();

    if (existingTenantCreds) {
      const { error: updateError } = await supabase
        .from('tenant_membership_credentials')
        .update({ 
          password_hash: passwordHash,
          reset_token: null,
          reset_token_expires: null,
          failed_attempts: 0,
          locked_until: null
        })
        .eq('id', existingTenantCreds.id);
      
      if (updateError) {
        console.error('[Auth] Failed to update tenant credentials:', updateError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Updated tenant-specific password for:', email, 'tenant:', tenantId);
    } else {
      const { error: insertError } = await supabase
        .from('tenant_membership_credentials')
        .insert({
          identity_id: identityId,
          tenant_id: tenantId,
          password_hash: passwordHash
        });
      
      if (insertError) {
        console.error('[Auth] Failed to create tenant credentials:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Created tenant-specific password for:', email, 'tenant:', tenantId);
    }

    // Clear reset tokens on tenant_identity (but DO NOT update password_hash - that would break tenant isolation)
    // Only update shared password if this user has NO tenant-specific credentials anywhere
    const { data: anyTenantCreds } = await supabase
      .from('tenant_membership_credentials')
      .select('id')
      .eq('identity_id', identityId)
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
      identityUpdate.failed_attempts = 0;
      identityUpdate.locked_until = null;
      console.log('[Auth] Updated shared identity password (no tenant-specific creds exist yet)');
    } else {
      console.log('[Auth] NOT updating shared identity password (tenant-specific creds exist for isolation)');
    }
    
    await supabase
      .from('tenant_identity')
      .update(identityUpdate)
      .eq('id', identityId);

    // Link member to identity if not already linked
    const { data: memberData } = await supabase
      .from('member')
      .select('identity_id, organization_id, tenant_id')
      .eq('id', member.id)
      .single();

    if (memberData && !memberData.identity_id) {
      await supabase
        .from('member')
        .update({ identity_id: identityId })
        .eq('id', member.id);
      console.log('[Auth] Linked member to identity');
    }

    // Create tenant_membership if doesn't exist
    const { data: existingMembership } = await supabase
      .from('tenant_membership')
      .select('id')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .single();

    if (!existingMembership) {
      await supabase
        .from('tenant_membership')
        .insert({
          identity_id: identityId,
          tenant_id: tenantId,
          member_id: member.id,
          role: 'member',
          membership_type: 'member',
          status: 'active',
          is_default: true
        });
      console.log('[Auth] Created tenant membership for member');
    }

    // Legacy: Also update member_credentials for backwards compatibility
    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', member.id)
      .single();

    if (existingCreds) {
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({ 
          password_hash: passwordHash,
          is_temp_password: false,
          password_set_at: new Date().toISOString(),
          reset_token: null,
          reset_token_expires: null,
          failed_login_attempts: 0,
          locked_until: null
        })
        .eq('id', existingCreds.id);
      
      if (updateError) {
        console.error('[Auth] Failed to update password:', updateError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Updated existing credentials for:', email);
    } else {
      const { error: insertError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: member.id,
          email: email.toLowerCase(),
          password_hash: passwordHash,
          is_temp_password: false,
          password_set_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error('[Auth] Failed to insert credentials:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Created new credentials for:', email);
    }

    const { data: fullMember } = await supabase
      .from('member')
      .select('*')
      .eq('id', member.id)
      .single();

    // Auto-generate handle if member doesn't have one
    if (fullMember && !fullMember.handle && (fullMember.first_name || fullMember.last_name || fullMember.email)) {
      console.log('[Auth SetPassword] Member has no handle, generating one...');
      
      try {
        const generateSlug = (text) => {
          return text
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        };

        const { data: allMembersForHandles } = await supabase
          .from('member')
          .select('handle');
        
        const existingHandles = new Set(
          (allMembersForHandles || [])
            .map((m) => m.handle)
            .filter((h) => h !== null)
        );

        let baseHandle = '';
        if (fullMember.first_name && fullMember.last_name) {
          baseHandle = `${generateSlug(fullMember.first_name)}-${generateSlug(fullMember.last_name)}`;
        } else if (fullMember.first_name) {
          baseHandle = generateSlug(fullMember.first_name);
        } else if (fullMember.last_name) {
          baseHandle = generateSlug(fullMember.last_name);
        } else if (fullMember.email) {
          baseHandle = generateSlug(fullMember.email.split('@')[0]);
        }
        
        if (baseHandle.length < 3) baseHandle = 'member';
        if (baseHandle.length > 30) baseHandle = baseHandle.substring(0, 30);

        let handle = baseHandle;
        let counter = 1;
        while (existingHandles.has(handle)) {
          const suffix = `-${counter}`;
          handle = baseHandle.substring(0, 30 - suffix.length) + suffix;
          counter++;
        }

        const { error: updateError } = await supabase
          .from('member')
          .update({ handle })
          .eq('id', fullMember.id);

        if (!updateError) {
          fullMember.handle = handle;
          console.log('[Auth SetPassword] Generated and saved handle:', handle);
        }
      } catch (handleError) {
        console.error('[Auth SetPassword] Error generating handle:', handleError.message);
      }
    }

    // Get tenant_id for session (use existing tenantId or derive from organization)
    let sessionTenantId = fullMember?.tenant_id || tenantId;
    if (!sessionTenantId && fullMember?.organization_id) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', fullMember.organization_id)
        .single();
      sessionTenantId = orgData?.tenant_id;
    }

    // Create PostgreSQL-backed session (same format as login.js and portal-sso.js)
    // Prefer fullMember.identity_id (direct link) over identity?.id (email lookup)
    await createSession(res, {
      memberId: member.id,
      memberEmail: email.toLowerCase(),
      organizationId: fullMember?.organization_id || null,
      tenantId: sessionTenantId || null,
      roleId: fullMember?.role_id || null,
      identityId: fullMember?.identity_id || identity?.id || null,
      userType: 'member'
    }, { req });

    console.log('[Auth] Password set for:', email);
    res.json({ success: true, member: fullMember });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ success: false, error: 'Failed to set password' });
  }
}
