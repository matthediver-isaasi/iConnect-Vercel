import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Unauthorized - platform owner authentication required' });
  }

  const { tenantName, slug, adminEmail, adminFirstName, adminLastName } = req.body;

  if (!tenantName || !slug || !adminEmail || !adminFirstName || !adminLastName) {
    return res.status(400).json({ error: 'All fields are required: tenantName, slug, adminEmail, adminFirstName, adminLastName' });
  }

  if (slug.length < 3) {
    return res.status(400).json({ error: 'Subdomain must be at least 3 characters' });
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (!slugRegex.test(slug)) {
    return res.status(400).json({ error: 'Subdomain can only contain lowercase letters, numbers, and hyphens' });
  }

  const reservedSlugs = ['www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets', 'images', 'login', 'signup', 'register', 'platform'];
  if (reservedSlugs.includes(slug)) {
    return res.status(400).json({ error: 'This subdomain is reserved. Please choose another.' });
  }

  let tenantId = null;
  let organizationId = null;
  let tenantUserId = null;
  let memberId = null;
  let adminRoleId = null;
  let memberRoleId = null;
  let identityId = null;
  let membershipId = null;

  async function rollbackAll(reason) {
    console.error(`[Platform Provision] Rolling back due to: ${reason}`);
    try {
      if (membershipId) await supabase.from('tenant_membership').delete().eq('id', membershipId);
      if (identityId) await supabase.from('tenant_identity').delete().eq('id', identityId);
      if (memberId) {
        await supabase.from('member_credentials').delete().eq('member_id', memberId);
        await supabase.from('member').delete().eq('id', memberId);
      }
      if (tenantUserId) {
        await supabase.from('tenant_user_credentials').delete().eq('tenant_user_id', tenantUserId);
        await supabase.from('tenant_user').delete().eq('id', tenantUserId);
      }
      if (memberRoleId) await supabase.from('role').delete().eq('id', memberRoleId);
      if (adminRoleId) await supabase.from('role').delete().eq('id', adminRoleId);
      if (organizationId) await supabase.from('organization').delete().eq('id', organizationId);
      if (tenantId) await supabase.from('tenant').delete().eq('id', tenantId);
    } catch (rollbackErr) {
      console.error('[Platform Provision] Rollback error:', rollbackErr);
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

    const { data: existingIdentity } = await supabase
      .from('tenant_identity')
      .select('id')
      .eq('email', adminEmail.toLowerCase())
      .single();

    if (existingIdentity) {
      return res.status(400).json({ error: 'An account with this email already exists. The admin will need to create the tenant from their account.' });
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
      console.error('[Platform Provision] Error creating tenant:', tenantError);
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
      console.error('[Platform Provision] Error creating organization:', orgError);
      await rollbackAll('organization creation failed');
      return res.status(500).json({ error: 'Failed to create workspace' });
    }
    organizationId = organization.id;

    const { data: templatePref } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'default_role_templates')
      .single();

    const roleTemplates = templatePref?.value?.roles || [];
    const superAdminTemplate = roleTemplates.find(r => r.name === 'Super Admin');
    const memberTemplate = roleTemplates.find(r => r.name === 'Member');

    const { data: adminRole, error: roleError } = await supabase
      .from('role')
      .insert({
        name: 'Super Admin',
        tenant_id: tenant.id,
        is_default: false,
        is_system: true,
        excluded_features: superAdminTemplate?.excluded_features || [],
        default_landing_page: superAdminTemplate?.default_landing_page || 'Dashboard'
      })
      .select()
      .single();

    if (roleError) {
      await rollbackAll('Super Admin role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    adminRoleId = adminRole.id;

    const { data: memberRole, error: memberRoleError } = await supabase
      .from('role')
      .insert({
        name: 'Member',
        tenant_id: tenant.id,
        is_default: true,
        is_system: memberTemplate?.is_system || false,
        excluded_features: memberTemplate?.excluded_features || ['admin.*'],
        default_landing_page: memberTemplate?.default_landing_page || 'Preferences'
      })
      .select()
      .single();

    if (memberRoleError) {
      await rollbackAll('member role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    memberRoleId = memberRole.id;

    const setupToken = crypto.randomBytes(32).toString('hex');
    const setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .insert({
        email: adminEmail.toLowerCase(),
        first_name: adminFirstName,
        last_name: adminLastName,
        password_hash: null,
        setup_token: setupToken,
        setup_token_expires: setupExpires.toISOString()
      })
      .select()
      .single();

    if (identityError) {
      console.error('[Platform Provision] Error creating identity:', identityError);
      await rollbackAll('identity creation failed');
      return res.status(500).json({ error: 'Failed to create admin account' });
    }
    identityId = identity.id;

    const { data: member, error: memberError } = await supabase
      .from('member')
      .insert({
        first_name: adminFirstName,
        last_name: adminLastName,
        email: adminEmail.toLowerCase(),
        organization_id: organization.id,
        tenant_id: tenant.id,
        role_id: adminRole.id,
        login_enabled: true,
        status: 'active'
      })
      .select()
      .single();

    if (memberError) {
      console.error('[Platform Provision] Error creating member:', memberError);
      await rollbackAll('member creation failed');
      return res.status(500).json({ error: 'Failed to create admin member record' });
    }
    memberId = member.id;

    const { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .insert({
        email: adminEmail.toLowerCase(),
        first_name: adminFirstName,
        last_name: adminLastName,
        tenant_id: tenant.id,
        role: 'owner',
        status: 'pending_setup'
      })
      .select()
      .single();

    if (tenantUserError) {
      console.error('[Platform Provision] Error creating tenant_user:', tenantUserError);
      await rollbackAll('tenant_user creation failed');
      return res.status(500).json({ error: 'Failed to create tenant admin' });
    }
    tenantUserId = tenantUser.id;

    const { data: membership, error: membershipError } = await supabase
      .from('tenant_membership')
      .insert({
        identity_id: identity.id,
        tenant_id: tenant.id,
        tenant_user_id: tenantUser.id,
        role: 'owner',
        is_default: true
      })
      .select()
      .single();

    if (membershipError) {
      console.error('[Platform Provision] Error creating membership:', membershipError);
      await rollbackAll('membership creation failed');
      return res.status(500).json({ error: 'Failed to link admin to tenant' });
    }
    membershipId = membership.id;

    const { error: linkError } = await supabase
      .from('tenant_user_member_link')
      .insert({
        tenant_user_id: tenantUser.id,
        member_id: member.id,
        tenant_id: tenant.id
      });

    if (linkError) {
      console.error('[Platform Provision] Error creating tenant_user_member_link:', linkError);
    }

    const { data: navPref } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'default_navigation_templates')
      .single();

    if (navPref?.value) {
      const { portal_navigation_items, portal_menus, navigation_items } = navPref.value;
      const templateKeyToMenuId = {};

      if (portal_menus?.length > 0) {
        for (const menu of portal_menus) {
          const { template_key, parent_template_key, order_index, ...menuData } = menu;
          const { data: newMenu, error: menuError } = await supabase
            .from('portal_menu')
            .insert({ ...menuData, tenant_id: tenant.id, parent_id: null })
            .select('id')
            .single();
          
          if (!menuError && template_key) {
            templateKeyToMenuId[template_key] = newMenu.id;
          }
        }

        for (const menu of portal_menus) {
          if (menu.parent_template_key && menu.template_key) {
            const newMenuId = templateKeyToMenuId[menu.template_key];
            const newParentId = templateKeyToMenuId[menu.parent_template_key];
            if (newMenuId && newParentId) {
              await supabase.from('portal_menu').update({ parent_id: newParentId }).eq('id', newMenuId);
            }
          }
        }
      }

      const navTemplateKeyToNewId = {};
      if (portal_navigation_items?.length > 0) {
        for (const item of portal_navigation_items) {
          const { menu_template_key, parent_template_key, template_key, order_index, ...navData } = item;
          const { data: newItem, error: navItemError } = await supabase
            .from('portal_navigation_item')
            .insert({
              ...navData,
              tenant_id: tenant.id,
              menu_id: menu_template_key ? templateKeyToMenuId[menu_template_key] : null,
              parent_id: null
            })
            .select('id')
            .single();
          
          if (!navItemError && template_key) {
            navTemplateKeyToNewId[template_key] = newItem.id;
          }
        }

        for (const item of portal_navigation_items) {
          if (item.parent_template_key && item.template_key) {
            const newItemId = navTemplateKeyToNewId[item.template_key];
            const newParentId = navTemplateKeyToNewId[item.parent_template_key];
            if (newItemId && newParentId) {
              await supabase.from('portal_navigation_item').update({ parent_id: newParentId }).eq('id', newItemId);
            }
          }
        }
      }

      const publicNavTemplateKeyToNewId = {};
      if (navigation_items?.length > 0) {
        for (const item of navigation_items) {
          const { parent_template_key, template_key, order_index, ...navData } = item;
          const { data: newItem, error: publicNavError } = await supabase
            .from('navigation_item')
            .insert({ ...navData, tenant_id: tenant.id, parent_id: null })
            .select('id')
            .single();
          
          if (!publicNavError && template_key) {
            publicNavTemplateKeyToNewId[template_key] = newItem.id;
          }
        }

        for (const item of navigation_items) {
          if (item.parent_template_key && item.template_key) {
            const newItemId = publicNavTemplateKeyToNewId[item.template_key];
            const newParentId = publicNavTemplateKeyToNewId[item.parent_template_key];
            if (newItemId && newParentId) {
              await supabase.from('navigation_item').update({ parent_id: newParentId }).eq('id', newItemId);
            }
          }
        }
      }

      console.log(`[Platform Provision] Created navigation templates for tenant: ${tenant.slug}`);
    }

    const baseDomain = process.env.APP_DOMAIN || 'iconn.app';
    const mailDomain = `mail.${slug}.${baseDomain}`;
    
    await supabase
      .from('tenant')
      .update({
        settings: {
          ...tenant.settings,
          email_domain: {
            domain: mailDomain,
            status: 'pending_setup',
            from_email: `noreply@${mailDomain}`,
            from_name: tenantName
          }
        }
      })
      .eq('id', tenant.id);

    console.log(`[Platform Provision] Successfully created tenant: ${tenant.name} (${tenant.slug})`);
    const setupUrl = `https://${baseDomain}/admin/login?setup=${setupToken}&email=${encodeURIComponent(adminEmail)}`;

    return res.status(201).json({
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        portalUrl: `https://${slug}.${baseDomain}`
      },
      admin: {
        email: adminEmail,
        setupUrl: setupUrl
      },
      message: `Tenant created successfully. Send the setup URL to the admin to complete their account setup.`
    });

  } catch (error) {
    console.error('[Platform Provision] Error:', error);
    await rollbackAll('unexpected error');
    return res.status(500).json({ error: 'Internal server error' });
  }
}
