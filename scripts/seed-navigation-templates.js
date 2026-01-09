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
    const portalNavigationTemplates = (navItems || []).map(item => {
      const { id, tenant_id, created_at, updated_at, ...template } = item;
      return template;
    });

    const portalMenuTemplates = (menus || []).map(menu => {
      const { id, tenant_id, created_at, updated_at, ...template } = menu;
      return template;
    });

    const publicNavigationTemplates = (publicNavItems || []).map(item => {
      const { id, tenant_id, created_at, updated_at, ...template } = item;
      return template;
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
