import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const SETTING_KEYS = [
  'membership_require_approval',
  'membership_stripe_enabled',
  'membership_custom_message',
];

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('system_settings')
        .select('setting_key, setting_value')
        .eq('tenant_id', tenantId)
        .in('setting_key', SETTING_KEYS);

      if (error) {
        console.error('[MembershipSettings] Error fetching:', error);
        return res.status(500).json({ error: 'Failed to fetch settings' });
      }

      const settings = {};
      for (const row of (data || [])) {
        settings[row.setting_key] = row.setting_value;
      }

      return res.json({
        require_approval: settings.membership_require_approval === 'true',
        stripe_enabled: settings.membership_stripe_enabled !== 'false',
        custom_message: settings.membership_custom_message || '',
      });
    }

    if (req.method === 'PUT') {
      const { require_approval, stripe_enabled, custom_message } = req.body;

      const updates = [
        { key: 'membership_require_approval', value: String(!!require_approval) },
        { key: 'membership_stripe_enabled', value: String(stripe_enabled !== false) },
        { key: 'membership_custom_message', value: custom_message || '' },
      ];

      for (const { key, value } of updates) {
        const { data: existing } = await supabase
          .from('system_settings')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('setting_key', key)
          .maybeSingle();

        if (existing) {
          await supabase
            .from('system_settings')
            .update({ setting_value: value, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        } else {
          await supabase
            .from('system_settings')
            .insert({
              tenant_id: tenantId,
              setting_key: key,
              setting_value: value,
            });
        }
      }

      return res.json({
        success: true,
        require_approval: require_approval === true,
        stripe_enabled: stripe_enabled !== false,
        custom_message: custom_message || '',
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[MembershipSettings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
