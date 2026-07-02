import bcrypt from 'bcryptjs';
import { createSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  resolveMemberForTenantLogin,
  computeEffectiveLoginStatus,
  isMemberSoftDeleted,
} from '../_lib/memberLoginResolver.js';
import { evaluateOrganisationLoginGate } from '../_lib/organisationLoginGate.js';

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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // Resolve tenant from subdomain for tenant isolation enforcement
    const requestTenant = await resolveTenantFromRequest(req);
    const requestTenantId = requestTenant?.id || null;

    // First try unified identity system (tenant_identity)
    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    let authenticatedViaIdentity = false;
    let credentials = null;
    let usedTenantSpecificCreds = false;

    if (identity) {
      // Check for tenant-specific credentials first (per-tenant password isolation)
      let tenantCreds = null;
      if (requestTenantId) {
        const { data: tenantCredsData } = await supabase
          .from('tenant_membership_credentials')
          .select('*')
          .eq('identity_id', identity.id)
          .eq('tenant_id', requestTenantId)
          .single();
        tenantCreds = tenantCredsData;
      }

      // Determine which password_hash to use
      const passwordHash = tenantCreds?.password_hash || identity.password_hash;
      const credSource = tenantCreds?.password_hash ? tenantCreds : identity;
      usedTenantSpecificCreds = !!tenantCreds?.password_hash;

      if (passwordHash) {
        // Check if account is locked (check both tenant-specific and shared)
        if (credSource.locked_until && new Date(credSource.locked_until) > new Date()) {
          return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
        }

        const isValid = await bcrypt.compare(password, passwordHash);
        
        if (isValid) {
          authenticatedViaIdentity = true;
          
          // Reset failed attempts on successful login
          if (usedTenantSpecificCreds && tenantCreds) {
            await supabase
              .from('tenant_membership_credentials')
              .update({ 
                failed_attempts: 0, 
                locked_until: null,
                last_login: new Date().toISOString()
              })
              .eq('id', tenantCreds.id);
            console.log('[Auth Login] Authenticated via tenant-specific credentials for:', email, 'tenant:', requestTenantId);
          } else {
            await supabase
              .from('tenant_identity')
              .update({ 
                failed_attempts: 0, 
                locked_until: null,
                last_login: new Date().toISOString()
              })
              .eq('id', identity.id);
            console.log('[Auth Login] Authenticated via shared identity for:', email);
            
            // On-demand migration: Create tenant-specific credential from successful shared login
            // This ensures future logins use isolated credentials
            if (requestTenantId) {
              try {
                await supabase
                  .from('tenant_membership_credentials')
                  .insert({
                    identity_id: identity.id,
                    tenant_id: requestTenantId,
                    password_hash: identity.password_hash,
                    last_login: new Date().toISOString()
                  });
                console.log('[Auth Login] Created tenant-specific credential via on-demand migration');
              } catch (migrationError) {
                // Ignore duplicate key errors - credential may already exist
                console.log('[Auth Login] On-demand migration skipped (may already exist)');
              }
            }
          }
        } else {
          // Update failed attempts
          const newFailedAttempts = (credSource.failed_attempts || 0) + 1;
          const updates = { failed_attempts: newFailedAttempts };
          
          if (newFailedAttempts >= 5) {
            updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          }
          
          if (usedTenantSpecificCreds && tenantCreds) {
            await supabase
              .from('tenant_membership_credentials')
              .update(updates)
              .eq('id', tenantCreds.id);
          } else {
            await supabase
              .from('tenant_identity')
              .update(updates)
              .eq('id', identity.id);
          }
          
          return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }
      }
    }

    // Fall back to legacy member_credentials if not authenticated via identity
    if (!authenticatedViaIdentity) {
      const { data: credData, error: credError } = await supabase
        .from('member_credentials')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

      credentials = credData;

      if (credError || !credentials) {
        console.log('[Auth Login] No credentials found for:', email);
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      if (credentials.locked_until && new Date(credentials.locked_until) > new Date()) {
        return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
      }

      if (!credentials.password_hash) {
        return res.status(401).json({ 
          success: false, 
          error: 'Password not set', 
          needsPasswordSetup: true,
          memberId: credentials.member_id 
        });
      }

      const isValid = await bcrypt.compare(password, credentials.password_hash);
      
      if (!isValid) {
        const newFailedAttempts = (credentials.failed_attempts || 0) + 1;
        const updates = { failed_attempts: newFailedAttempts };
        
        if (newFailedAttempts >= 5) {
          updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        }
        
        await supabase
          .from('member_credentials')
          .update(updates)
          .eq('id', credentials.id);
        
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      await supabase
        .from('member_credentials')
        .update({ 
          failed_attempts: 0, 
          locked_until: null
        })
        .eq('id', credentials.id);
      
      console.log('[Auth Login] Authenticated via legacy credentials for:', email);
    }

    // Find the member record using the shared resolver. The resolver skips
    // soft-deleted/anonymized member rows so a stale tenant_membership row
    // pointing at a deleted member can no longer cause auth and the admin
    // UI to disagree.
    let member = null;

    if (authenticatedViaIdentity && identity) {
      const resolution = await resolveMemberForTenantLogin({
        supabase,
        identityId: identity.id,
        email,
        tenantId: requestTenantId,
      });
      member = resolution.member;
    } else if (credentials?.member_id) {
      // Legacy credentials - use member_id directly
      const { data: memberData } = await supabase
        .from('member')
        .select('*')
        .eq('id', credentials.member_id)
        .single();
      member = memberData;
      if (member && isMemberSoftDeleted(member)) {
        console.log('[Auth Login] Legacy member is soft-deleted:', email);
        return res.status(401).json({ success: false, error: 'Member not found' });
      }
    }

    if (!member) {
      console.log('[Auth Login] No member found for:', email, 'tenant:', requestTenantId);
      return res.status(401).json({ success: false, error: 'Member not found' });
    }

    // TENANT ISOLATION: Verify member belongs to the tenant from the subdomain
    // This prevents cross-tenant authentication attacks.
    let tenantMismatch = false;
    if (requestTenantId) {
      let memberTenantId = member.tenant_id;

      // If member doesn't have direct tenant_id, check via organization
      if (!memberTenantId && member.organization_id) {
        const { data: orgData } = await supabase
          .from('organization')
          .select('tenant_id')
          .eq('id', member.organization_id)
          .single();

        memberTenantId = orgData?.tenant_id;
      }

      tenantMismatch = memberTenantId !== requestTenantId;
    }

    const effectiveStatus = computeEffectiveLoginStatus(member, { tenantMismatch });

    // Auto-disable expired guests: persist login_enabled=false so the stale
    // flag can never let them back in.
    if (effectiveStatus.reason === 'guest_expired' && member.login_enabled !== false) {
      try {
        await supabase
          .from('member')
          .update({ login_enabled: false })
          .eq('id', member.id);
      } catch (e) {
        console.error('[Auth Login] Failed to auto-disable expired guest:', e);
      }
      member.login_enabled = false;
    }

    if (!effectiveStatus.canLogin) {
      switch (effectiveStatus.reason) {
        case 'tenant_mismatch':
          console.log('[Auth Login] Tenant mismatch - member:', member.id, 'request tenant:', requestTenantId);
          return res.status(403).json({
            success: false,
            error: 'This account does not have access to this portal. Please use the correct login URL for your organization.',
          });
        case 'guest_expired':
          console.log('[Auth Login] Guest access expired for member:', email);
          return res.status(403).json({
            success: false,
            error: 'Your guest access has expired. Please contact an administrator to extend your access.',
          });
        case 'soft_deleted':
          console.log('[Auth Login] Resolved member is soft-deleted:', email);
          return res.status(401).json({ success: false, error: 'Member not found' });
        case 'login_disabled':
        default:
          console.log('[Auth Login] Login disabled for member:', email);
          return res.status(403).json({
            success: false,
            error: 'Login is disabled for this account. Please contact an administrator.',
          });
      }
    }

    if (!member.role_id) {
      // Tenant-scope every lookup in this default-role fallback so a member
      // can never be assigned a role from a different tenant. If the member
      // has no tenant_id, leave role_id as NULL rather than guessing.
      if (!member.tenant_id) {
        console.warn('[Auth Login] Member has no tenant_id and no role_id; leaving role_id NULL:', member.id);
      } else {
        const { data: tenantRoles } = await supabase
          .from('role')
          .select('*')
          .eq('tenant_id', member.tenant_id);

        // Check for role segmentation (tenant-scoped — system_settings is per-tenant)
        const { data: segmentationSettings } = await supabase
          .from('system_settings')
          .select('*')
          .eq('setting_key', 'role_segmentation_field_id')
          .eq('tenant_id', member.tenant_id)
          .maybeSingle();

        let defaultRole = null;
        const segmentationFieldId = segmentationSettings?.setting_value;

        if (segmentationFieldId && member.organization_id) {
          // Get the organization's segment value
          const { data: orgPrefValue } = await supabase
            .from('organization_preference_value')
            .select('value')
            .eq('organization_id', member.organization_id)
            .eq('field_id', segmentationFieldId)
            .maybeSingle();

          const orgSegmentValue = orgPrefValue?.value;

          if (orgSegmentValue) {
            // Find a default role that matches this segment value
            defaultRole = tenantRoles?.find((r) =>
              r.is_default === true &&
              r.segment_values &&
              Array.isArray(r.segment_values) &&
              r.segment_values.includes(orgSegmentValue)
            );
          }
        }

        // Fallback to the tenant's `is_default = true` role (or the legacy
        // tenant-scoped default_role_id system_settings value). Never pick
        // a role by literal name.
        if (!defaultRole) {
          defaultRole = tenantRoles?.find((r) => r.is_default === true) || null;
        }

        if (!defaultRole) {
          const { data: legacyDefaultSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'default_role_id')
            .eq('tenant_id', member.tenant_id)
            .maybeSingle();

          const legacyDefaultRoleId = legacyDefaultSetting?.setting_value;
          if (legacyDefaultRoleId) {
            defaultRole = tenantRoles?.find((r) => r.id === legacyDefaultRoleId) || null;
          }
        }

        if (defaultRole) {
          await supabase
            .from('member')
            .update({ role_id: defaultRole.id })
            .eq('id', member.id);
          member.role_id = defaultRole.id;
        } else {
          console.warn('[Auth Login] No default role found for tenant; leaving role_id NULL:', {
            member_id: member.id,
            tenant_id: member.tenant_id,
          });
        }
      }
    }

    // Auto-generate handle if member doesn't have one
    if (!member.handle && (member.first_name || member.last_name || member.email)) {
      console.log('[Auth Login] Member has no handle, generating one...');
      
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
        if (member.first_name && member.last_name) {
          baseHandle = `${generateSlug(member.first_name)}-${generateSlug(member.last_name)}`;
        } else if (member.first_name) {
          baseHandle = generateSlug(member.first_name);
        } else if (member.last_name) {
          baseHandle = generateSlug(member.last_name);
        } else if (member.email) {
          baseHandle = generateSlug(member.email.split('@')[0]);
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
          .eq('id', member.id);

        if (!updateError) {
          member.handle = handle;
          console.log('[Auth Login] Generated and saved handle:', handle);
        }
      } catch (handleError) {
        console.error('[Auth Login] Error generating handle:', handleError.message);
      }
    }

    // Determine the member's tenant_id for session storage
    let sessionTenantId = member.tenant_id;
    if (!sessionTenantId && member.organization_id) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', member.organization_id)
        .single();
      sessionTenantId = orgData?.tenant_id;
    }

    // Organisation Login Gate: tenant-configurable rule that requires a
    // chosen organisation field to equal a chosen value. Applied uniformly
    // with no role-based bypass. Members without an organisation are
    // treated as failing the gate when it is enabled.
    if (sessionTenantId) {
      try {
        const gateResult = await evaluateOrganisationLoginGate({
          supabase,
          tenantId: sessionTenantId,
          organizationId: member.organization_id || null,
        });
        if (gateResult.blocked) {
          console.log('[Auth Login] Organisation login gate blocked:', email, 'org:', member.organization_id);
          return res.status(403).json({
            success: false,
            error: gateResult.message,
            organisationLoginGateBlocked: true,
          });
        }
      } catch (gateErr) {
        console.error('[Auth Login] Organisation login gate evaluation failed:', gateErr);
      }
    }

    // Create PostgreSQL-backed session with tenant context
    // Include all required fields to match portal-sso session format
    // Prefer member.identity_id (direct link) over identity?.id (email lookup)
    await createSession(res, {
      memberId: member.id,
      memberEmail: member.email,
      organizationId: member.organization_id || null,
      tenantId: sessionTenantId || null,
      roleId: member.role_id || null,
      identityId: member.identity_id || identity?.id || null,
      userType: 'member'
    }, { req });

    console.log('[Auth Login] Success for:', email);
    
    res.json({ 
      success: true, 
      member,
      isTemporaryPassword: credentials?.is_temp_password || false 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}
