import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Unauthorized - Platform owner access required' });
  }

  try {
    const { data: gfiTenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('slug', 'gfi')
      .single();

    if (tenantError || !gfiTenant) {
      return res.status(404).json({ error: 'GFI tenant not found' });
    }

    const { data: navItems, error: navError } = await supabase
      .from('portal_navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .order('id');

    if (navError) {
      console.error('Error fetching portal_navigation_item:', navError.message);
    }

    const { data: menus, error: menuError } = await supabase
      .from('portal_menu')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .eq('is_active', true)
      .order('id');

    if (menuError) {
      console.error('Error fetching portal_menu:', menuError.message);
    }

    const { data: publicNavItems, error: publicNavError } = await supabase
      .from('navigation_item')
      .select('*')
      .eq('tenant_id', gfiTenant.id)
      .eq('is_active', true)
      .order('id');

    if (publicNavError) {
      console.error('Error fetching navigation_item:', publicNavError.message);
    }

    const menuIdToTemplateKey = {};
    (menus || []).forEach((menu) => {
      const templateKey = `menu_${menu.id}`;
      menuIdToTemplateKey[menu.id] = templateKey;
    });

    const portalMenuTemplates = (menus || []).map((menu) => {
      const { id, tenant_id, created_at, updated_at, parent_id, ...template } = menu;
      const parentTemplateKey = parent_id && menuIdToTemplateKey[parent_id] ? menuIdToTemplateKey[parent_id] : null;
      return {
        ...template,
        template_key: menuIdToTemplateKey[id],
        parent_template_key: parentTemplateKey
      };
    });

    const menusWithParents = portalMenuTemplates.filter(m => m.parent_template_key);

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
      return res.status(500).json({ error: 'Failed to save templates' });
    }

    return res.status(200).json({
      success: true,
      stats: {
        portal_navigation_items: portalNavigationTemplates.length,
        portal_menus: portalMenuTemplates.length,
        portal_menus_with_parents: menusWithParents.length,
        public_navigation_items: publicNavigationTemplates.length
      },
      snapshot_date: new Date().toISOString(),
      source_tenant: gfiTenant.slug
    });

  } catch (err) {
    console.error('Error seeding navigation templates:', err);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}
