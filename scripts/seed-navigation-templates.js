/**
 * Seed Navigation Templates Script
 * 
 * This script snapshots the portal navigation items and menus from the GFI tenant
 * and stores them as templates in platform_preferences for use when provisioning new tenants.
 * 
 * Usage: node scripts/seed-navigation-templates.js
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function seedNavigationTemplates() {
  try {
    const { data: gfiTenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('slug', 'gfi')
      .single();

    if (tenantError || !gfiTenant) {
      console.error('GFI tenant not found:', tenantError?.message);
      process.exit(1);
    }

    console.log(`Found GFI tenant: ${gfiTenant.name} (${gfiTenant.id})`);

    const { data: navItems, error: navError } = await supabase
      .from('portal_navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .eq('is_active', true)
      .order('id');

    if (navError) {
      console.error('Error fetching portal_navigation_item:', navError.message);
    } else {
      console.log(`Found ${navItems?.length || 0} active portal navigation items`);
    }

    const { data: menus, error: menuError } = await supabase
      .from('portal_menu')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .eq('is_active', true)
      .order('id');

    if (menuError) {
      console.error('Error fetching portal_menu:', menuError.message);
    } else {
      console.log(`Found ${menus?.length || 0} active portal menus`);
    }

    const { data: publicNavItems, error: publicNavError } = await supabase
      .from('navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .eq('is_active', true)
      .order('id');

    if (publicNavError) {
      console.error('Error fetching navigation_item:', publicNavError.message);
    } else {
      console.log(`Found ${publicNavItems?.length || 0} active public navigation items`);
    }

    // Build menu ID to template_key mapping (using stable IDs)
    const menuIdToTemplateKey = {};
    (menus || []).forEach((menu) => {
      const templateKey = `menu_${menu.id}`;
      menuIdToTemplateKey[menu.id] = templateKey;
    });

    // Portal menus now include parent_id for hierarchy
    // Only include parent_template_key if the parent is in our active set
    const portalMenuTemplates = (menus || []).map((menu) => {
      const { id, tenant_id, created_at, updated_at, parent_id, ...template } = menu;
      const parentTemplateKey = parent_id && menuIdToTemplateKey[parent_id] ? menuIdToTemplateKey[parent_id] : null;
      return {
        ...template,
        template_key: menuIdToTemplateKey[id],
        parent_template_key: parentTemplateKey
      };
    });

    // Count menus with parent relationships
    const menusWithParents = portalMenuTemplates.filter(m => m.parent_template_key);
    console.log(`\nPortal menu parent-child relationships found: ${menusWithParents.length}`);
    menusWithParents.slice(0, 10).forEach(m => {
      console.log(`  ${m.template_key} (${m.label || m.name}) -> parent: ${m.parent_template_key}`);
    });
    if (menusWithParents.length > 10) {
      console.log(`  ... and ${menusWithParents.length - 10} more`);
    }

    // Portal navigation items
    const navItemIdToTemplateKey = {};
    (navItems || []).forEach((item) => {
      const templateKey = `navitem_${item.id}`;
      navItemIdToTemplateKey[item.id] = templateKey;
    });

    const portalNavigationTemplates = (navItems || []).map((item) => {
      const { id, tenant_id, created_at, updated_at, menu_id, parent_id, ...template } = item;
      const menuTemplateKey = menu_id && menuIdToTemplateKey[menu_id] ? menuIdToTemplateKey[menu_id] : null;
      const parentTemplateKey = parent_id && navItemIdToTemplateKey[parent_id] ? navItemIdToTemplateKey[parent_id] : null;
      return {
        ...template,
        template_key: navItemIdToTemplateKey[id],
        menu_template_key: menuTemplateKey,
        parent_template_key: parentTemplateKey
      };
    });

    // Public navigation items
    const publicNavItemIdToTemplateKey = {};
    (publicNavItems || []).forEach((item) => {
      const templateKey = `publicnav_${item.id}`;
      publicNavItemIdToTemplateKey[item.id] = templateKey;
    });

    const publicNavigationTemplates = (publicNavItems || []).map((item) => {
      const { id, tenant_id, created_at, updated_at, parent_id, ...template } = item;
      const parentTemplateKey = parent_id && publicNavItemIdToTemplateKey[parent_id] ? publicNavItemIdToTemplateKey[parent_id] : null;
      return {
        ...template,
        template_key: publicNavItemIdToTemplateKey[id],
        parent_template_key: parentTemplateKey
      };
    });

    console.log('\nPublic navigation parent-child relationships:');
    publicNavigationTemplates.filter(t => t.parent_template_key).forEach(t => {
      console.log(`  ${t.template_key} (${t.label || t.name}) -> parent: ${t.parent_template_key}`);
    });

    const { error: saveError } = await supabase
      .from('platform_preferences')
      .upsert({
        key: 'default_navigation_templates',
        value: {
          portal_navigation_items: portalNavigationTemplates,
          portal_menus: portalMenuTemplates,
          navigation_items: publicNavigationTemplates,
          source_tenant: gfiTenant.slug,
          snapshot_date: new Date().toISOString()
        },
        description: 'Default navigation configuration to provision for new tenants (snapshotted from GFI)',
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    if (saveError) {
      console.error('Error saving templates:', saveError.message);
      process.exit(1);
    }

    console.log('\nSuccessfully saved navigation templates to platform_preferences:');
    console.log(`  - ${portalNavigationTemplates.length} portal navigation items`);
    console.log(`  - ${portalMenuTemplates.length} portal menus (${menusWithParents.length} with parents)`);
    console.log(`  - ${publicNavigationTemplates.length} public navigation items`);

  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

seedNavigationTemplates();
