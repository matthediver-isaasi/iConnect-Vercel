import { supabase } from './database.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { provisionEmailDomain } from './emailDomainService.js';

const RESERVED_SLUGS = ['www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets', 'images', 'login', 'signup', 'register'];

export function getBaseDomain() {
  return process.env.APP_DOMAIN || 'iconn.app';
}

export function getTenantPortalUrl(slug) {
  return `https://${slug}.${getBaseDomain()}`;
}

export function getMailDomain(slug) {
  return `${slug}.${getBaseDomain()}`;
}

export async function validateProvisionInput({ tenantName, slug, adminEmail, adminFirstName, adminLastName, password, googleId, linkExistingAccount, isPlatformProvision }) {
  const errors = [];
  
  if (!tenantName || !slug || !adminEmail || !adminFirstName || !adminLastName) {
    errors.push('All fields are required');
  }

  if (!isPlatformProvision && !password && !googleId && !linkExistingAccount) {
    errors.push('Either password or Google authentication is required');
  }

  if (slug && slug.length < 3) {
    errors.push('Subdomain must be at least 3 characters');
  }

  if (password && password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (slug && !slugRegex.test(slug)) {
    errors.push('Subdomain can only contain lowercase letters, numbers, and hyphens');
  }

  if (slug && RESERVED_SLUGS.includes(slug)) {
    errors.push('This subdomain is reserved. Please choose another.');
  }

  return errors;
}

export async function checkSlugAvailability(slug) {
  const { data: existingTenant } = await supabase
    .from('tenant')
    .select('id')
    .eq('slug', slug)
    .single();

  return !existingTenant;
}

export async function checkExistingIdentity(email, googleId) {
  const { data: foundIdentity } = await supabase
    .from('tenant_identity')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  let existingIdentity = foundIdentity;

  if (googleId && !existingIdentity) {
    const { data: existingGoogleIdentity } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('google_id', googleId)
      .single();

    if (existingGoogleIdentity) {
      existingIdentity = existingGoogleIdentity;
    }
  }

  return existingIdentity;
}

export async function checkLegacyAccount(email, googleId) {
  const { data: existingTenantUser } = await supabase
    .from('tenant_user')
    .select('id')
    .eq('email', email.toLowerCase())
    .single();

  if (existingTenantUser) {
    return { exists: true, type: 'email' };
  }

  if (googleId) {
    const { data: existingGoogleUser } = await supabase
      .from('tenant_user')
      .select('id')
      .eq('google_id', googleId)
      .single();

    if (existingGoogleUser) {
      return { exists: true, type: 'google' };
    }
  }

  return { exists: false };
}

async function createRollbackFn(state) {
  return async function rollbackAll(reason) {
    console.error(`[Provision Tenant] Rolling back due to: ${reason}`);
    
    try {
      if (state.membershipId) {
        await supabase.from('tenant_membership').delete().eq('id', state.membershipId);
      }
      if (state.identityId && !state.existingIdentity) {
        await supabase.from('tenant_identity').delete().eq('id', state.identityId);
      }
      if (state.memberId) {
        await supabase.from('member_credentials').delete().eq('member_id', state.memberId);
        await supabase.from('member').delete().eq('id', state.memberId);
      }
      if (state.tenantUserId) {
        await supabase.from('tenant_user_credentials').delete().eq('tenant_user_id', state.tenantUserId);
        await supabase.from('tenant_user').delete().eq('id', state.tenantUserId);
      }
      if (state.memberRoleId) {
        await supabase.from('role').delete().eq('id', state.memberRoleId);
      }
      if (state.adminRoleId) {
        await supabase.from('role').delete().eq('id', state.adminRoleId);
      }
      if (state.organizationId) {
        await supabase.from('organization').delete().eq('id', state.organizationId);
      }
      if (state.tenantId) {
        await supabase.from('tenant').delete().eq('id', state.tenantId);
      }
    } catch (rollbackErr) {
      console.error('[Provision Tenant] Rollback error:', rollbackErr);
    }
  };
}

async function createRolesFromTemplates(tenantId) {
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
      tenant_id: tenantId,
      is_default: false,
      is_system: true,
      excluded_features: superAdminTemplate?.excluded_features || [],
      default_landing_page: superAdminTemplate?.default_landing_page || 'Dashboard'
    })
    .select()
    .single();

  if (roleError) {
    throw new Error('Failed to create Super Admin role');
  }

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

  const { data: memberRole, error: memberRoleError } = await supabase
    .from('role')
    .insert({
      name: 'Member',
      tenant_id: tenantId,
      is_default: true,
      is_system: memberTemplate?.is_system || false,
      excluded_features: memberTemplate?.excluded_features || ['admin.*'],
      default_landing_page: memberTemplate?.default_landing_page || 'Preferences'
    })
    .select()
    .single();

  if (memberRoleError) {
    throw new Error('Failed to create Member role');
  }

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

  return { adminRole, memberRole };
}

async function seedNavigationTemplates(tenantId) {
  const { data: navPref } = await supabase
    .from('platform_preferences')
    .select('value')
    .eq('key', 'default_navigation_templates')
    .single();

  if (!navPref?.value) return;

  const { portal_navigation_items, portal_menus, navigation_items } = navPref.value;
  const templateKeyToMenuId = {};

  if (portal_menus?.length > 0) {
    for (const menu of portal_menus) {
      const { template_key, parent_template_key, order_index, ...menuData } = menu;
      const { data: newMenu, error: menuError } = await supabase
        .from('portal_menu')
        .insert({ ...menuData, tenant_id: tenantId, parent_id: null })
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
    console.log(`[Provision Tenant] Created ${Object.keys(templateKeyToMenuId).length} portal menus`);
  }

  const navTemplateKeyToNewId = {};
  if (portal_navigation_items?.length > 0) {
    for (const item of portal_navigation_items) {
      const { menu_template_key, parent_template_key, template_key, order_index, ...navData } = item;
      const { data: newItem, error: navItemError } = await supabase
        .from('portal_navigation_item')
        .insert({
          ...navData,
          tenant_id: tenantId,
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
    console.log(`[Provision Tenant] Created ${Object.keys(navTemplateKeyToNewId).length} portal navigation items`);
  }

  const publicNavTemplateKeyToNewId = {};
  if (navigation_items?.length > 0) {
    for (const item of navigation_items) {
      const { parent_template_key, template_key, order_index, ...navData } = item;
      const { data: newItem, error: publicNavError } = await supabase
        .from('navigation_item')
        .insert({ ...navData, tenant_id: tenantId, parent_id: null })
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
    console.log(`[Provision Tenant] Created ${Object.keys(publicNavTemplateKeyToNewId).length} public navigation items`);
  }
}

export async function provisionTenant({
  tenantName,
  slug,
  adminEmail,
  adminFirstName,
  adminLastName,
  password = null,
  googleId = null,
  linkExistingAccount = false,
  isPlatformProvision = false,
  generateSetupToken = false,
  existingIdentity = null
}) {
  const state = {
    tenantId: null,
    organizationId: null,
    tenantUserId: null,
    memberId: null,
    adminRoleId: null,
    memberRoleId: null,
    identityId: null,
    membershipId: null,
    existingIdentity
  };

  const rollbackAll = await createRollbackFn(state);

  try {
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
      throw new Error('Failed to create workspace');
    }
    state.tenantId = tenant.id;

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
      throw new Error('Failed to create workspace');
    }
    state.organizationId = organization.id;

    let adminRole, memberRole;
    try {
      const roles = await createRolesFromTemplates(tenant.id);
      adminRole = roles.adminRole;
      memberRole = roles.memberRole;
      state.adminRoleId = adminRole.id;
      state.memberRoleId = memberRole.id;
    } catch (roleErr) {
      console.error('[Provision Tenant] Error creating roles:', roleErr);
      await rollbackAll('role creation failed');
      throw new Error('Failed to create workspace roles');
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    let setupToken = null;
    let setupExpires = null;

    if (generateSetupToken) {
      setupToken = crypto.randomBytes(32).toString('hex');
      setupExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

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
      if (setupToken) {
        identityInsert.reset_token = setupToken;
        identityInsert.reset_token_expires = setupExpires.toISOString();
      }

      const { data: newIdentity, error: identityError } = await supabase
        .from('tenant_identity')
        .insert(identityInsert)
        .select()
        .single();

      if (identityError) {
        console.error('[Provision Tenant] Error creating tenant identity - falling through to legacy:', identityError);
      } else {
        identity = newIdentity;
        state.identityId = newIdentity.id;
      }
    } else {
      state.identityId = identity.id;
    }

    const memberInsert = {
      first_name: adminFirstName,
      last_name: adminLastName,
      email: adminEmail.toLowerCase(),
      organization_id: organization.id,
      tenant_id: tenant.id,
      role_id: adminRole.id,
      login_enabled: true,
      status: 'active'
    };
    if (googleId && !existingIdentity) {
      memberInsert.google_id = googleId;
    }
    if (identity) {
      memberInsert.identity_id = identity.id;
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .insert(memberInsert)
      .select()
      .single();

    if (memberError) {
      console.error('[Provision Tenant] Error creating admin member:', memberError);
      await rollbackAll('admin member creation failed');
      throw new Error('Failed to create admin account');
    }
    state.memberId = member.id;

    if (identity) {
      const { data: membership, error: membershipError } = await supabase
        .from('tenant_membership')
        .insert({
          identity_id: identity.id,
          tenant_id: tenant.id,
          member_id: member.id,
          role: 'owner',
          membership_type: 'owner',
          status: 'active',
          is_default: !existingIdentity
        })
        .select()
        .single();

      if (membershipError) {
        console.error('[Provision Tenant] Error creating tenant membership - falling through to legacy:', membershipError);
      } else {
        state.membershipId = membership.id;
      }
    }

    if (passwordHash && !identity) {
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
        throw new Error('Failed to create login credentials');
      }
    }

    // For platform provisioning: 'active' if reusing existing identity, 'pending_setup' for new identity
    const tenantUserStatus = isPlatformProvision 
      ? (existingIdentity ? 'active' : 'pending_setup') 
      : 'active';
    
    const tenantUserInsert = {
      tenant_id: tenant.id,
      email: adminEmail.toLowerCase(),
      first_name: adminFirstName,
      last_name: adminLastName,
      role: 'owner',
      status: tenantUserStatus
    };
    if (googleId && !existingIdentity) {
      tenantUserInsert.google_id = googleId;
    }
    if (state.identityId) {
      tenantUserInsert.identity_id = state.identityId;
    }

    const { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .insert(tenantUserInsert)
      .select()
      .single();

    if (tenantUserError) {
      console.error('[Provision Tenant] Error creating tenant user:', tenantUserError);
      await rollbackAll('tenant user creation failed');
      throw new Error('Failed to create admin account');
    }
    state.tenantUserId = tenantUser.id;

    if (passwordHash && !state.identityId) {
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
        throw new Error('Failed to create login credentials');
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

    await seedNavigationTemplates(tenant.id);

    let emailDomainResult = null;
    try {
      console.log('[Provision Tenant] Starting automatic email domain provisioning...');
      emailDomainResult = await provisionEmailDomain(tenant.id, slug, tenantName, tenant.settings);
      if (emailDomainResult.success) {
        console.log(`[Provision Tenant] Email domain provisioned: ${emailDomainResult.domain} (${emailDomainResult.status})`);
      } else {
        console.log(`[Provision Tenant] Email domain provisioning skipped or failed: ${emailDomainResult.error}`);
      }
    } catch (emailErr) {
      console.error('[Provision Tenant] Non-critical: Failed to provision email domain:', emailErr.message);
      emailDomainResult = { success: false, error: emailErr.message };
    }

    console.log(`[Provision Tenant] Successfully created tenant: ${tenant.name} (${tenant.slug})`);

    return {
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        portalUrl: getTenantPortalUrl(slug)
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
      identity: identity ? { id: identity.id } : null,
      setupToken: generateSetupToken ? setupToken : null,
      emailDomain: emailDomainResult?.success ? {
        domain: emailDomainResult.domain,
        status: emailDomainResult.status,
        dns_records_created: emailDomainResult.dns_records_created
      } : null
    };

  } catch (err) {
    console.error('[Provision Tenant] Error:', err);
    await rollbackAll('unexpected error');
    throw err;
  }
}
