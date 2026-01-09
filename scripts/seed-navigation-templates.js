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
    // Get the GFI tenant
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

    // Fetch portal_navigation_item records
    const { data: navItems, error: navError } = await supabase
      .from('portal_navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .order('order_index');

    if (navError) {
      console.error('Error fetching portal_navigation_item:', navError.message);
    } else {
      console.log(`Found ${navItems?.length || 0} portal navigation items`);
    }

    // Fetch portal_menu records
    const { data: menus, error: menuError } = await supabase
      .from('portal_menu')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .order('order_index');

    if (menuError) {
      console.error('Error fetching portal_menu:', menuError.message);
    } else {
      console.log(`Found ${menus?.length || 0} portal menus`);
    }

    // Fetch navigation_item records (public site navigation)
    const { data: publicNavItems, error: publicNavError } = await supabase
      .from('navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .order('order_index');

    if (publicNavError) {
      console.error('Error fetching navigation_item:', publicNavError.message);
    } else {
      console.log(`Found ${publicNavItems?.length || 0} public navigation items`);
    }

    // Create templates by stripping IDs and tenant_id
    // For menus, we use a stable template_key based on their name/slug for later remapping
    const portalMenuTemplates = (menus || []).map((menu, index) => {
      const { id, tenant_id, created_at, updated_at, ...template } = menu;
      return {
        ...template,
        template_key: `menu_${index}_${(menu.name || menu.slug || 'default').toLowerCase().replace(/\s+/g, '_')}`
      };
    });

    // Build a map from old menu IDs to template_keys for remapping nav items
    const menuIdToTemplateKey = {};
    (menus || []).forEach((menu, index) => {
      const templateKey = `menu_${index}_${(menu.name || menu.slug || 'default').toLowerCase().replace(/\s+/g, '_')}`;
      menuIdToTemplateKey[menu.id] = templateKey;
    });

    // Build a map from old nav item IDs to template_keys for parent_id remapping
    const navItemIdToTemplateKey = {};
    (navItems || []).forEach((item, index) => {
      const templateKey = `navitem_${index}_${(item.label || item.name || 'item').toLowerCase().replace(/\s+/g, '_')}`;
      navItemIdToTemplateKey[item.id] = templateKey;
    });

    // For nav items, replace menu_id and parent_id with template_keys for later reconstruction
    const portalNavigationTemplates = (navItems || []).map((item, index) => {
      const { id, tenant_id, created_at, updated_at, menu_id, parent_id, ...template } = item;
      return {
        ...template,
        template_key: `navitem_${index}_${(item.label || item.name || 'item').toLowerCase().replace(/\s+/g, '_')}`,
        menu_template_key: menu_id ? menuIdToTemplateKey[menu_id] : null,
        parent_template_key: parent_id ? navItemIdToTemplateKey[parent_id] : null
      };
    });

    // Same for public navigation items - handle parent_id
    const publicNavItemIdToTemplateKey = {};
    (publicNavItems || []).forEach((item, index) => {
      const templateKey = `publicnav_${index}_${(item.label || item.name || 'item').toLowerCase().replace(/\s+/g, '_')}`;
      publicNavItemIdToTemplateKey[item.id] = templateKey;
    });

    const publicNavigationTemplates = (publicNavItems || []).map((item, index) => {
      const { id, tenant_id, created_at, updated_at, parent_id, ...template } = item;
      return {
        ...template,
        template_key: `publicnav_${index}_${(item.label || item.name || 'item').toLowerCase().replace(/\s+/g, '_')}`,
        parent_template_key: parent_id ? publicNavItemIdToTemplateKey[parent_id] : null
      };
    });

    // Store in platform_preferences
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
    console.log(`  - ${portalMenuTemplates.length} portal menus`);
    console.log(`  - ${publicNavigationTemplates.length} public navigation items`);

  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

seedNavigationTemplates();
