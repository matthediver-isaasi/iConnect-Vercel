import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const tenantContext = await getTenantContext(req);

    if (!tenantContext || !tenantContext.tenantId || !tenantContext.isAuthenticated) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const tenantId = tenantContext.tenantId;

    if (req.method === 'GET') {
      const { data: setting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'outlook_sync_frequency_minutes')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const { count, error: countError } = await supabase
        .from('outlook_connection')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'active');

      return res.status(200).json({
        frequency_minutes: setting?.setting_value ? parseInt(setting.setting_value, 10) : 15,
        connected_accounts: countError ? 0 : (count || 0)
      });
    }

    if (req.method === 'POST') {
      if (!tenantContext.isAuthenticated || !tenantContext.tenantUserId) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { frequency_minutes } = req.body;
      const validFrequencies = [5, 15, 30, 60, 240, 720, 1440];

      if (!validFrequencies.includes(frequency_minutes)) {
        return res.status(400).json({ error: 'Invalid frequency value' });
      }

      const { error } = await supabase
        .from('system_settings')
        .upsert({
          tenant_id: tenantId,
          setting_key: 'outlook_sync_frequency_minutes',
          setting_value: String(frequency_minutes)
        }, {
          onConflict: 'tenant_id,setting_key'
        });

      if (error) {
        console.error('[Outlook Sync Settings] Save error:', error);
        return res.status(500).json({ error: 'Failed to save setting' });
      }

      return res.status(200).json({ success: true, frequency_minutes });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Outlook Sync Settings] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
