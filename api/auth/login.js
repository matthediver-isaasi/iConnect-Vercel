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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // Resolve tenant from subdomain for tenant isolation enforcement
    const requestTenant = await resolveTenantFromRequest(req);
    const requestTenantId = requestTenant?.id || null;

    const { data: credentials, error: credError } = await supabase
      .from('member_credentials')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

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

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .eq('id', credentials.member_id)
      .single();

    if (memberError || !member) {
      return res.status(401).json({ success: false, error: 'Member not found' });
    }

    // TENANT ISOLATION: Verify member belongs to the tenant from the subdomain
    // This prevents cross-tenant authentication attacks
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
      
      // Reject login if member doesn't belong to this tenant
      if (memberTenantId !== requestTenantId) {
        console.log('[Auth Login] Tenant mismatch - member tenant:', memberTenantId, 'request tenant:', requestTenantId);
        return res.status(403).json({ 
          success: false, 
          error: 'This account does not have access to this portal. Please use the correct login URL for your organization.' 
        });
      }
    }

    // Check if login is enabled for this member
    if (member.login_enabled === false) {
      console.log('[Auth Login] Login disabled for member:', email);
      return res.status(403).json({ success: false, error: 'Login is disabled for this account. Please contact an administrator.' });
    }

    if (!member.role_id) {
      const { data: allRoles } = await supabase.from('role').select('*');
      
      // Check for role segmentation
      const { data: segmentationSettings } = await supabase
        .from('system_settings')
        .select('*')
        .eq('setting_key', 'role_segmentation_field_id')
        .single();
      
      let defaultRole = null;
      const segmentationFieldId = segmentationSettings?.setting_value;
      
      if (segmentationFieldId && member.organization_id) {
        // Get the organization's segment value
        const { data: orgPrefValue } = await supabase
          .from('organization_preference_value')
          .select('value')
          .eq('organization_id', member.organization_id)
          .eq('field_id', segmentationFieldId)
          .single();
        
        const orgSegmentValue = orgPrefValue?.value;
        
        if (orgSegmentValue) {
          // Find a default role that matches this segment value
          defaultRole = allRoles?.find((r) => 
            r.is_default === true && 
            r.segment_values && 
            Array.isArray(r.segment_values) && 
            r.segment_values.includes(orgSegmentValue)
          );
        }
      }
      
      // Fallback to any default role or a role named 'Member' if no segmented match
      if (!defaultRole) {
        const memberRole = allRoles?.find((r) => r.name === 'Member');
        const anyDefaultRole = allRoles?.find((r) => r.is_default === true);
        defaultRole = memberRole || anyDefaultRole;
      }
      
      if (defaultRole) {
        await supabase
          .from('member')
          .update({ role_id: defaultRole.id })
          .eq('id', member.id);
        member.role_id = defaultRole.id;
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

    // Create PostgreSQL-backed session with tenant context
    await createSession(res, {
      memberId: member.id,
      memberEmail: member.email,
      tenantId: sessionTenantId || null
    });

    console.log('[Auth Login] Success for:', email);
    
    res.json({ 
      success: true, 
      member,
      isTemporaryPassword: credentials.is_temp_password 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}
