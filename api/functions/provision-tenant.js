import { supabase } from '../_lib/database.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenantName, slug, adminEmail, adminFirstName, adminLastName, password, googleId, linkExistingAccount } = req.body;

  if (!tenantName || !slug || !adminEmail || !adminFirstName || !adminLastName) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!password && !googleId && !linkExistingAccount) {
    return res.status(400).json({ error: 'Either password or Google authentication is required' });
  }

  if (slug.length < 3) {
    return res.status(400).json({ error: 'Subdomain must be at least 3 characters' });
  }

  if (password && password.length < 8) {
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
  let tenantUserId = null;
  let memberId = null;
  let adminRoleId = null;
  let memberRoleId = null;
  let identityId = null;
  let membershipId = null;
  let existingIdentity = null;

  async function rollbackAll(reason) {
    console.error(`[Provision Tenant] Rolling back due to: ${reason}`);
    
    try {
      if (membershipId) {
        await supabase.from('tenant_membership').delete().eq('id', membershipId);
      }
      if (identityId && !existingIdentity) {
        await supabase.from('tenant_identity').delete().eq('id', identityId);
      }
      if (memberId) {
        await supabase.from('member_credentials').delete().eq('member_id', memberId);
        await supabase.from('member').delete().eq('id', memberId);
      }
      if (tenantUserId) {
        await supabase.from('tenant_user_credentials').delete().eq('tenant_user_id', tenantUserId);
        await supabase.from('tenant_user').delete().eq('id', tenantUserId);
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

    // Check for existing identity (supports multi-tenant ownership)
    const { data: foundIdentity } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', adminEmail.toLowerCase())
      .single();

    existingIdentity = foundIdentity;

    // If identity exists but linkExistingAccount is not set, check if we should prompt
    if (existingIdentity && !linkExistingAccount) {
      // Return a response indicating the user can link to existing account
      return res.status(409).json({ 
        error: 'An account with this email already exists',
        existingAccount: true,
        canLinkAccount: true,
        message: 'You already have an account with this email. Would you like to add this new workspace to your existing account?'
      });
    }

    // If no identity exists, check legacy tables
    if (!existingIdentity) {
      const { data: existingTenantUser } = await supabase
        .from('tenant_user')
        .select('id')
        .eq('email', adminEmail.toLowerCase())
        .single();

      if (existingTenantUser) {
        return res.status(400).json({ 
          error: 'An account with this email already exists. Please run the database migration to enable multi-tenant support.',
          needsMigration: true
        });
      }
    }

    // Check if this Google ID is already linked
    if (googleId && !existingIdentity) {
      const { data: existingGoogleIdentity } = await supabase
        .from('tenant_identity')
        .select('id')
        .eq('google_id', googleId)
        .single();

      if (existingGoogleIdentity) {
        existingIdentity = existingGoogleIdentity;
      } else {
        const { data: existingGoogleUser } = await supabase
          .from('tenant_user')
          .select('id')
          .eq('google_id', googleId)
          .single();

        if (existingGoogleUser) {
          return res.status(400).json({ error: 'This Google account is already linked to another tenant' });
        }
      }
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

    // Fetch role templates from platform preferences
    const { data: templatePref } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'default_role_templates')
      .single();
    
    const roleTemplates = templatePref?.value?.roles || [];
    const superAdminTemplate = roleTemplates.find(r => r.name === 'Super Admin');
    const memberTemplate = roleTemplates.find(r => r.name === 'Member');

    // Create Super Admin role from template or defaults
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
      console.error('[Provision Tenant] Error creating Super Admin role:', roleError);
      await rollbackAll('Super Admin role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    adminRoleId = adminRole.id;

    // Create field permissions for Super Admin if template exists
    if (superAdminTemplate?.member_field_permissions?.length > 0) {
      const memberPerms = superAdminTemplate.member_field_permissions.map(p => ({
        role_id: adminRole.id,
        field_key: p.field_key,
        permission: p.permission
      }));
      await supabase.from('role_member_field_permission').insert(memberPerms);
    }
    if (superAdminTemplate?.organization_field_permissions?.length > 0) {
      const orgPerms = superAdminTemplate.organization_field_permissions.map(p => ({
        role_id: adminRole.id,
        field_key: p.field_key,
        permission: p.permission
      }));
      await supabase.from('role_organization_field_permission').insert(orgPerms);
    }

    // Create Member role from template or defaults
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
      console.error('[Provision Tenant] Error creating member role:', memberRoleError);
      await rollbackAll('member role creation failed');
      return res.status(500).json({ error: 'Failed to create workspace roles' });
    }
    memberRoleId = memberRole.id;

    // Create field permissions for Member if template exists
    if (memberTemplate?.member_field_permissions?.length > 0) {
      const memberPerms = memberTemplate.member_field_permissions.map(p => ({
        role_id: memberRole.id,
        field_key: p.field_key,
        permission: p.permission
      }));
      await supabase.from('role_member_field_permission').insert(memberPerms);
    }
    if (memberTemplate?.organization_field_permissions?.length > 0) {
      const orgPerms = memberTemplate.organization_field_permissions.map(p => ({
        role_id: memberRole.id,
        field_key: p.field_key,
        permission: p.permission
      }));
      await supabase.from('role_organization_field_permission').insert(orgPerms);
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    // Create or use existing tenant_identity (new multi-tenant system)
    let identity = existingIdentity;
    if (!identity) {
      const identityInsert = {
        email: adminEmail.toLowerCase(),
        first_name: adminFirstName,
        last_name: adminLastName,
        password_hash: passwordHash
      };
      if (googleId) {
        identityInsert.google_id = googleId;
      }

      const { data: newIdentity, error: identityError } = await supabase
        .from('tenant_identity')
        .insert(identityInsert)
        .select()
        .single();

      if (identityError) {
        console.error('[Provision Tenant] Error creating tenant identity:', identityError);
        // Fall through to legacy flow if new tables don't exist yet
      } else {
        identity = newIdentity;
        identityId = newIdentity.id;
      }
    } else {
      identityId = identity.id;
    }

    // Create tenant_membership linking identity to tenant
    if (identity) {
      const { data: membership, error: membershipError } = await supabase
        .from('tenant_membership')
        .insert({
          identity_id: identity.id,
          tenant_id: tenant.id,
          role: 'owner',
          status: 'active',
          is_default: !existingIdentity // First tenant is default
        })
        .select()
        .single();

      if (membershipError) {
        console.error('[Provision Tenant] Error creating tenant membership:', membershipError);
        // Fall through to legacy flow
      } else {
        membershipId = membership.id;
      }
    }

    const memberInsert = {
      first_name: adminFirstName,
      last_name: adminLastName,
      email: adminEmail.toLowerCase(),
      organization_id: organization.id,
      role_id: adminRole.id,
      login_enabled: true,
      status: 'active'
    };
    // Only set google_id if this is a NEW identity (not linking to existing)
    // Legacy tables have unique constraints on google_id
    if (googleId && !existingIdentity) {
      memberInsert.google_id = googleId;
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .insert(memberInsert)
      .select()
      .single();

    if (memberError) {
      console.error('[Provision Tenant] Error creating admin member:', memberError);
      await rollbackAll('admin member creation failed');
      return res.status(500).json({ error: 'Failed to create admin account' });
    }
    memberId = member.id;

    if (passwordHash) {
      const { error: memberCredError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: member.id,
          tenant_id: tenant.id,
          email: adminEmail.toLowerCase(),
          password_hash: passwordHash,
          is_temporary: false
        });

      if (memberCredError) {
        console.error('[Provision Tenant] Error creating member credentials:', memberCredError);
        await rollbackAll('member credentials creation failed');
        return res.status(500).json({ error: 'Failed to create login credentials' });
      }
    }

    // Create legacy tenant_user (for backwards compatibility during transition)
    const tenantUserInsert = {
      tenant_id: tenant.id,
      email: adminEmail.toLowerCase(),
      first_name: adminFirstName,
      last_name: adminLastName,
      role: 'owner',
      status: 'active'
    };
    // Only set google_id if this is a NEW identity (not linking to existing)
    // Legacy tables have unique constraints on google_id
    if (googleId && !existingIdentity) {
      tenantUserInsert.google_id = googleId;
    }
    if (identityId) {
      tenantUserInsert.identity_id = identityId;
    }

    const { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .insert(tenantUserInsert)
      .select()
      .single();

    if (tenantUserError) {
      console.error('[Provision Tenant] Error creating tenant user:', tenantUserError);
      await rollbackAll('tenant user creation failed');
      return res.status(500).json({ error: 'Failed to create admin account' });
    }
    tenantUserId = tenantUser.id;

    // Only create credentials if identity wasn't used (legacy path)
    if (passwordHash && !identityId) {
      const { error: tenantCredError } = await supabase
        .from('tenant_user_credentials')
        .insert({
          tenant_user_id: tenantUser.id,
          email: adminEmail.toLowerCase(),
          password_hash: passwordHash,
          is_temporary: false
        });

      if (tenantCredError) {
        console.error('[Provision Tenant] Error creating tenant user credentials:', tenantCredError);
        await rollbackAll('tenant user credentials creation failed');
        return res.status(500).json({ error: 'Failed to create login credentials' });
      }
    }

    const { error: linkError } = await supabase
      .from('tenant_user_member_link')
      .insert({
        tenant_user_id: tenantUser.id,
        member_id: member.id,
        tenant_id: tenant.id
      });

    if (linkError) {
      console.error('[Provision Tenant] Error creating tenant_user_member_link:', linkError);
    }

    // Create navigation from templates
    const { data: navPref } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'default_navigation_templates')
      .single();

    if (navPref?.value) {
      const { portal_navigation_items, portal_menus, navigation_items } = navPref.value;

      // Build a map from template_key to new menu_id for FK remapping
      const templateKeyToMenuId = {};

      // Create portal menus FIRST without parent_id (two-pass for hierarchy)
      if (portal_menus?.length > 0) {
        for (const menu of portal_menus) {
          const { template_key, parent_template_key, order_index, ...menuData } = menu;
          const { data: newMenu, error: menuError } = await supabase
            .from('portal_menu')
            .insert({
              ...menuData,
              tenant_id: tenant.id,
              parent_id: null // Will be updated in second pass
            })
            .select('id')
            .single();
          
          if (menuError) {
            console.error('[Provision Tenant] Error creating portal menu:', menuError);
          } else if (template_key) {
            templateKeyToMenuId[template_key] = newMenu.id;
          }
        }
        console.log(`[Provision Tenant] Created ${Object.keys(templateKeyToMenuId).length} portal menus`);

        // Second pass: update parent_id references for menus
        let menuParentsUpdated = 0;
        for (const menu of portal_menus) {
          if (menu.parent_template_key && menu.template_key) {
            const newMenuId = templateKeyToMenuId[menu.template_key];
            const newParentId = templateKeyToMenuId[menu.parent_template_key];
            if (newMenuId && newParentId) {
              const { error: updateError } = await supabase
                .from('portal_menu')
                .update({ parent_id: newParentId })
                .eq('id', newMenuId);
              if (!updateError) {
                menuParentsUpdated++;
              }
            }
          }
        }
        if (menuParentsUpdated > 0) {
          console.log(`[Provision Tenant] Updated ${menuParentsUpdated} portal menu parent relationships`);
        }
      }

      // Create portal navigation items with remapped menu_id and parent_id
      // Two-pass: first insert all items without parent_id, then update parent relationships
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
              parent_id: null // Will be updated in second pass
            })
            .select('id')
            .single();
          
          if (navItemError) {
            console.error('[Provision Tenant] Error creating portal navigation item:', navItemError);
          } else if (template_key) {
            navTemplateKeyToNewId[template_key] = newItem.id;
          }
        }
        console.log(`[Provision Tenant] Created ${Object.keys(navTemplateKeyToNewId).length} portal navigation items`);

        // Second pass: update parent_id references
        for (const item of portal_navigation_items) {
          if (item.parent_template_key && item.template_key) {
            const newItemId = navTemplateKeyToNewId[item.template_key];
            const newParentId = navTemplateKeyToNewId[item.parent_template_key];
            if (newItemId && newParentId) {
              await supabase
                .from('portal_navigation_item')
                .update({ parent_id: newParentId })
                .eq('id', newItemId);
            }
          }
        }
      }

      // Create public navigation items with parent_id remapping
      const publicNavTemplateKeyToNewId = {};
      if (navigation_items?.length > 0) {
        for (const item of navigation_items) {
          const { parent_template_key, template_key, order_index, ...navData } = item;
          const { data: newItem, error: publicNavError } = await supabase
            .from('navigation_item')
            .insert({
              ...navData,
              tenant_id: tenant.id,
              parent_id: null // Will be updated in second pass
            })
            .select('id')
            .single();
          
          if (publicNavError) {
            console.error('[Provision Tenant] Error creating public navigation item:', publicNavError);
          } else if (template_key) {
            publicNavTemplateKeyToNewId[template_key] = newItem.id;
          }
        }
        console.log(`[Provision Tenant] Created ${Object.keys(publicNavTemplateKeyToNewId).length} public navigation items`);

        // Second pass: update parent_id references
        for (const item of navigation_items) {
          if (item.parent_template_key && item.template_key) {
            const newItemId = publicNavTemplateKeyToNewId[item.template_key];
            const newParentId = publicNavTemplateKeyToNewId[item.parent_template_key];
            if (newItemId && newParentId) {
              await supabase
                .from('navigation_item')
                .update({ parent_id: newParentId })
                .eq('id', newItemId);
            }
          }
        }
      }
    }

    console.log(`[Provision Tenant] Successfully created tenant: ${tenant.name} (${tenant.slug})`);

    return res.status(200).json({
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug
      },
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        role: tenantUser.role
      },
      member: {
        id: member.id,
        email: member.email
      },
      message: 'Workspace created successfully'
    });

  } catch (err) {
    console.error('[Provision Tenant] Unexpected error:', err);
    await rollbackAll('unexpected error');
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}
