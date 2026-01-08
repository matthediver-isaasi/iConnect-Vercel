import { supabase } from '../_lib/database.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenantName, slug, adminEmail, adminFirstName, adminLastName, password } = req.body;

  if (!tenantName || !slug || !adminEmail || !adminFirstName || !adminLastName || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (slug.length < 3) {
    return res.status(400).json({ error: 'Subdomain must be at least 3 characters' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (!slugRegex.test(slug)) {
    return res.status(400).json({ error: 'Subdomain can only contain lowercase letters, numbers, and hyphens' });
  }

  const reservedSlugs = ['www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets', 'images', 'login', 'signup', 'register'];
  if (reservedSlugs.includes(slug)) {
    return res.status(400).json({ error: 'This subdomain is reserved. Please choose another.' });
  }

  let tenantId = null;
  let organizationId = null;
  let memberId = null;
  let adminRoleId = null;
  let memberRoleId = null;

  async function rollbackAll(reason) {
    console.error(`[Provision Tenant] Rolling back due to: ${reason}`);
    
    try {
      if (memberId) {
        await supabase.from('member_credentials').delete().eq('member_id', memberId);
        await supabase.from('member').delete().eq('id', memberId);
      }
      if (memberRoleId) {
        await supabase.from('role').delete().eq('id', memberRoleId);
      }
      if (adminRoleId) {
        await supabase.from('role').delete().eq('id', adminRoleId);
      }
      if (organizationId) {
        await supabase.from('organization').delete().eq('id', organizationId);
      }
      if (tenantId) {
        await supabase.from('tenant').delete().eq('id', tenantId);
      }
    } catch (rollbackErr) {
      console.error('[Provision Tenant] Rollback error:', rollbackErr);
    }
  }

  try {
    const { data: existingTenant } = await supabase
      .from('tenant')
      .select('id')
      .eq('slug', slug)
      .single();

    if (existingTenant) {
      return res.status(400).json({ error: 'This subdomain is already taken' });
    }

    const { data: existingMember } = await supabase
      .from('member')
      .select('id')
      .eq('email', adminEmail.toLowerCase())
      .single();

    if (existingMember) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .insert({
        name: tenantName,
        slug: slug,
        status: 'active',
        subscription_plan: 'trial',
        subscription_status: 'active',
        billing_email: adminEmail.toLowerCase(),
        settings: {}
      })
      .select()
      .single();

    if (tenantError) {
      console.error('[Provision Tenant] Error creating tenant:', tenantError);
      return res.status(500).json({ error: 'Failed to create workspace' });
    }
    tenantId = tenant.id;

    const { data: organization, error: orgError } = await supabase
      .from('organization')
      .insert({
        name: tenantName,
        tenant_id: tenant.id,
        status: 'active'
      })
      .select()
      .single();

    if (orgError) {
      console.error('[Provision Tenant] Error creating organization:', orgError);
      await rollbackAll('organization creation failed');
      return res.status(500).json({ error: 'Failed to create workspace' });
    }
    organizationId = organization.id;

    const { data: adminRole, error: roleError } = await supabase
      .from('role')
      .insert({
        name: 'Administrator',
        tenant_id: tenant.id,
        is_default: false,
        excluded_features: [],
        default_landing_page: 'Dashboard'
      })
      .select()
      .single();

    if (roleError) {
      console.error('[Provision Tenant] Error creating admin role:', roleError);
      await rollbackAll('admin role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    adminRoleId = adminRole.id;

    const { data: memberRole, error: memberRoleError } = await supabase
      .from('role')
      .insert({
        name: 'Member',
        tenant_id: tenant.id,
        is_default: true,
        excluded_features: ['admin.*'],
        default_landing_page: 'Preferences'
      })
      .select()
      .single();

    if (memberRoleError) {
      console.error('[Provision Tenant] Error creating member role:', memberRoleError);
      await rollbackAll('member role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    memberRoleId = memberRole.id;

    const passwordHash = await bcrypt.hash(password, 10);

    const { data: member, error: memberError } = await supabase
      .from('member')
      .insert({
        first_name: adminFirstName,
        last_name: adminLastName,
        email: adminEmail.toLowerCase(),
        organization_id: organization.id,
        role_id: adminRole.id,
        login_enabled: true,
        status: 'active'
      })
      .select()
      .single();

    if (memberError) {
      console.error('[Provision Tenant] Error creating admin member:', memberError);
      await rollbackAll('admin member creation failed');
      return res.status(500).json({ error: 'Failed to create admin account' });
    }
    memberId = member.id;

    const { error: credError } = await supabase
      .from('member_credentials')
      .insert({
        member_id: member.id,
        password_hash: passwordHash,
        is_temporary: false
      });

    if (credError) {
      console.error('[Provision Tenant] Error creating credentials:', credError);
      await rollbackAll('credentials creation failed');
      return res.status(500).json({ error: 'Failed to create login credentials' });
    }

    console.log(`[Provision Tenant] Successfully created tenant: ${tenant.name} (${tenant.slug})`);

    return res.status(200).json({
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug
      },
      message: 'Workspace created successfully'
    });

  } catch (err) {
    console.error('[Provision Tenant] Unexpected error:', err);
    await rollbackAll('unexpected error');
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}
