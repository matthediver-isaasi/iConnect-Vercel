import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenantCtx = await getTenantContext(req);

    if (!tenantCtx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!tenantCtx.tenantId) {
      return res.status(400).json({ error: 'Tenant context not available' });
    }

    const settingKeys = [
      'page_visibility_settings',
      'global_border_radius',
      'article_display_name',
      'article_url_slug',
      'articles_public_author_label',
      'article_category_label',
      'featured_label',
      'show_author_profile_picture',
      'show_full_author_name',
      'article_default_author',
      'article_guest_author_label',
      'public_article_fallback_image',
      'article_card_style',
      'article_list_settings',
      'portal_carousel_settings',
    ];

    const results = {
      duplicated: [],
      alreadyExists: [],
      noNullRecord: [],
      errors: [],
    };

    for (const settingKey of settingKeys) {
      try {
        const { data: existingForTenant } = await supabase
          .from('system_settings')
          .select('id, setting_value')
          .eq('setting_key', settingKey)
          .eq('tenant_id', tenantCtx.tenantId)
          .limit(1);

        if (existingForTenant && existingForTenant.length > 0) {
          results.alreadyExists.push(settingKey);
          continue;
        }

        const { data: nullTenantRecords } = await supabase
          .from('system_settings')
          .select('id, setting_key, setting_value, description')
          .eq('setting_key', settingKey)
          .is('tenant_id', null);

        if (nullTenantRecords && nullTenantRecords.length > 0) {
          const record = nullTenantRecords[0];
          
          const { error } = await supabase
            .from('system_settings')
            .upsert({
              setting_key: record.setting_key,
              setting_value: record.setting_value,
              description: record.description,
              tenant_id: tenantCtx.tenantId,
            }, {
              onConflict: 'setting_key,tenant_id',
              ignoreDuplicates: true,
            });

          if (error) {
            if (error.code === '23505') {
              results.alreadyExists.push(settingKey);
            } else {
              results.errors.push({ key: settingKey, error: error.message });
            }
          } else {
            results.duplicated.push(settingKey);
          }
        } else {
          results.noNullRecord.push(settingKey);
        }
      } catch (err) {
        results.errors.push({ key: settingKey, error: err.message });
      }
    }

    return res.json({
      success: true,
      tenantId: tenantCtx.tenantId,
      results,
      message: 'Settings duplicated for your tenant. Original null-tenant records preserved for other tenants.',
    });
  } catch (error) {
    console.error('[backfill-system-settings] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
