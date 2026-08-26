import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const PUBLIC_SETTINGS_WHITELIST = [
  'page_visibility',
  'page_visibility_settings',
  'articles_slug',
  'articles_public_slug',
  'articles_view_slug',
  'articles_my_slug',
  'articles_editor_slug',
  'button_styles_enabled',
  'border_radius',
  'global_border_radius',
  'portal_logo',
  'search_enabled',
  'event_booking_terms',
  'event_sponsors_placement',
  'speaker_module_name',
  'newsletter_form_id',
  'floater_config',
  'article_display_name',
  'member_display_name',
  'social_icons_config',
  'header_icons_config',
  'footer_config',
  'newsletter_signup_form_id',
  'news_cards_per_row',
  'news_show_image',
  'news_show_author',
  'news_card_cta_radius',
  'news_card_image_divider_mode',
  'news_card_image_divider_weight',
  'news_card_image_divider_color',
  'webinar_show_join_link',
  'news_ticker_count',
  'news_ticker_cycle_seconds',
  'news_ticker_enabled',
  'news_ticker_bottom_margin',
  'org_directory_excluded_orgs',
  'org_directory_show_name_tooltip',
  'org_directory_show_title',
  'org_directory_allowed_application_statuses',
  'wall_of_fame_photo_size',
  'date_display_format',
  'event_types',
  'event_time_format_24h',
  'event_cta_button',
  'job_types',
  'job_hours',
  'job_posting_price',
  'show_event_card_prices',
  'featured_events_background',
  'tbc_events_banner',
  'email_preferences_blank_page',
  'photo_gallery_max_upload_mb',
  'resource_max_upload_mb',
  'member_group_events_per_page',
  'member_group_resources_per_page',
  'member_group_feature_name',
  'member_group_ticket_type_name',
  'member_group_default_terms_of_reference',
  'member_group_allow_terms_override',
  'support_levels',
  'support_ticket_instructions',
  'support_areas',
  'allow_voucher_use_after_expiry',
  'collect_attendee_options',
  'event_agenda_item_types',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { key } = req.query;

    // system_settings table is tenant-scoped with tenant_id column
    // Filter by tenant and whitelist to only expose safe settings publicly
    let query = supabase
      .from('system_settings')
      .select('id, setting_key, setting_value')
      .eq('tenant_id', tenant.id);

    if (key) {
      if (!PUBLIC_SETTINGS_WHITELIST.includes(key)) {
        return res.status(403).json({ error: 'Setting not accessible publicly' });
      }
      query = query.eq('setting_key', key);
    } else {
      query = query.in('setting_key', PUBLIC_SETTINGS_WHITELIST);
    }

    const { data: settings, error } = await query;

    if (error) {
      console.error('[Public SystemSettings] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }

    return res.status(200).json(settings || []);
  } catch (error) {
    console.error('[Public SystemSettings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
