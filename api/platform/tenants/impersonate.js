import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import { createSession } from '../../_lib/session.js';
import { getTenantPortalUrl } from '../../_lib/provisionTenantService.js';

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

  // Verify platform owner is authenticated
  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Platform owner authentication required' });
  }

  try {
    const { tenantId } = req.body;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Fetch tenant details
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug, domain')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    console.log(`[Platform Impersonate] Platform owner ${owner.id} impersonating tenant: ${tenant.name} (${tenant.slug})`);

    // Check if there's already a tenant_user linked to the platform owner's identity for this tenant
    let tenantUser = null;
    
    if (owner.identity_id) {
      const { data: existingTenantUser } = await supabase
        .from('tenant_user')
        .select('id, email, first_name, last_name, role')
        .eq('identity_id', owner.identity_id)
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .single();
      
      tenantUser = existingTenantUser;
    }

    // If no existing tenant_user, check by email or create new
    if (!tenantUser) {
      const { data: existingByEmail } = await supabase
        .from('tenant_user')
        .select('id, email, first_name, last_name, role')
        .eq('email', owner.email)
        .eq('tenant_id', tenantId)
        .single();

      if (existingByEmail) {
        tenantUser = existingByEmail;
      } else {
        // Create a new tenant_user record for this platform owner
        const { data: newTenantUser, error: createError } = await supabase
          .from('tenant_user')
          .insert({
            tenant_id: tenantId,
            identity_id: owner.identity_id,
            email: owner.email,
            first_name: owner.first_name || 'Platform',
            last_name: owner.last_name || 'Owner',
            role: 'owner',
            is_active: true
          })
          .select('id, email, first_name, last_name, role')
          .single();

        if (createError) {
          console.error('[Platform Impersonate] Failed to create tenant_user:', createError);
          return res.status(500).json({ error: 'Failed to create admin session' });
        }

        tenantUser = newTenantUser;
        console.log(`[Platform Impersonate] Created tenant_user for platform owner: ${tenantUser.id}`);
      }
    }

    // Ensure the tenant_user has owner role for full admin access
    if (tenantUser.role !== 'owner' && tenantUser.role !== 'admin') {
      const { error: updateError } = await supabase
        .from('tenant_user')
        .update({ role: 'owner' })
        .eq('id', tenantUser.id);
      
      if (!updateError) {
        tenantUser.role = 'owner';
        console.log(`[Platform Impersonate] Upgraded tenant_user ${tenantUser.id} to owner role`);
      }
    }

    // Create admin session for this tenant with all required fields
    const sessionData = {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenant.id,
      userType: 'tenant_user',
      identityId: owner.identity_id,
      membershipId: tenantUser.id,
      membershipRole: tenantUser.role,
      isPlatformImpersonation: true,
      platformOwnerId: owner.id
    };

    const session = await createSession(res, sessionData, { req });

    if (!session) {
      return res.status(500).json({ error: 'Failed to create session' });
    }

    console.log(`[Platform Impersonate] Session created for tenant ${tenant.slug}, tenant_user: ${tenantUser.id}`);

    // Build redirect URL using proper domain utilities
    const portalBaseUrl = getTenantPortalUrl(tenant.slug, tenant.domain);
    const adminUrl = `${portalBaseUrl}/admin/dashboard`;

    return res.status(200).json({
      success: true,
      redirectUrl: adminUrl,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug
      },
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        role: tenantUser.role
      }
    });

  } catch (error) {
    console.error('[Platform Impersonate] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
