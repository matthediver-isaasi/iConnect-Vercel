import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const SETTING_KEYS = [
  'membership_require_approval',
  'membership_custom_message',
  'membership_cron_time',
  'membership_nominal_ledger',
  'membership_addons_enabled',
  'membership_addon_training_fund_enabled',
  'membership_addon_freeform_enabled',
  'membership_training_fund_nominal_code',
  'membership_training_fund_vat_rate',
];

function parseVatRateSetting(value) {
  if (!value || value === 'none') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.taxType ? parsed : null;
  } catch {
    return null;
  }
}

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
        custom_message: settings.membership_custom_message && settings.membership_custom_message !== 'none' ? settings.membership_custom_message : '',
        cron_time: settings.membership_cron_time || '06:00',
        nominal_ledger: settings.membership_nominal_ledger || '',
        addons_enabled: settings.membership_addons_enabled === 'true',
        addon_training_fund_enabled: settings.membership_addon_training_fund_enabled === 'true',
        addon_freeform_enabled: settings.membership_addon_freeform_enabled === 'true',
        training_fund_nominal_code: settings.membership_training_fund_nominal_code || '',
        training_fund_vat_rate: parseVatRateSetting(settings.membership_training_fund_vat_rate),
      });
    }

    if (req.method === 'PUT') {
      const {
        require_approval, custom_message, cron_time, nominal_ledger,
        addons_enabled, addon_training_fund_enabled, addon_freeform_enabled,
        training_fund_nominal_code, training_fund_vat_rate,
      } = req.body;

      let vatRateValue = 'none';
      if (training_fund_vat_rate && typeof training_fund_vat_rate === 'object' && training_fund_vat_rate.taxType) {
        vatRateValue = JSON.stringify({
          taxType: String(training_fund_vat_rate.taxType),
          name: training_fund_vat_rate.name || null,
          effectiveRate: training_fund_vat_rate.effectiveRate != null ? Number(training_fund_vat_rate.effectiveRate) : null,
        });
      }

      const validCronTime = /^\d{2}:00$/.test(cron_time) && parseInt(cron_time, 10) >= 0 && parseInt(cron_time, 10) <= 23
        ? cron_time
        : '06:00';

      const updates = [
        { key: 'membership_require_approval', value: String(!!require_approval) },
        { key: 'membership_custom_message', value: custom_message || 'none' },
        { key: 'membership_cron_time', value: validCronTime },
        { key: 'membership_nominal_ledger', value: nominal_ledger || '' },
        { key: 'membership_addons_enabled', value: String(!!addons_enabled) },
        { key: 'membership_addon_training_fund_enabled', value: String(!!addon_training_fund_enabled) },
        { key: 'membership_addon_freeform_enabled', value: String(!!addon_freeform_enabled) },
        { key: 'membership_training_fund_nominal_code', value: training_fund_nominal_code || '' },
        { key: 'membership_training_fund_vat_rate', value: vatRateValue },
      ];

      for (const { key, value } of updates) {
        const { error: upsertError } = await supabase
          .from('system_settings')
          .upsert(
            {
              tenant_id: tenantId,
              setting_key: key,
              setting_value: value,
            },
            { onConflict: 'tenant_id,setting_key' }
          );

        if (upsertError) {
          console.error(`[MembershipSettings] Error upserting ${key}:`, upsertError);
          return res.status(500).json({ error: `Failed to save setting: ${key}` });
        }
      }

      return res.json({
        success: true,
        require_approval: require_approval === true,
        custom_message: custom_message || '',
        cron_time: validCronTime,
        nominal_ledger: nominal_ledger || '',
        addons_enabled: !!addons_enabled,
        addon_training_fund_enabled: !!addon_training_fund_enabled,
        addon_freeform_enabled: !!addon_freeform_enabled,
        training_fund_nominal_code: training_fund_nominal_code || '',
        training_fund_vat_rate: vatRateValue === 'none' ? null : JSON.parse(vatRateValue),
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[MembershipSettings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
