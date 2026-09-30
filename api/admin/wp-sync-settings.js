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
      if (!tenantContext.tenantUserId) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { data: settings } = await supabase
        .from('system_settings')
        .select('setting_key, setting_value')
        .eq('tenant_id', tenantId)
        .in('setting_key', ['wp_webhook_url', 'wp_webhook_api_key']);

      const urlSetting = settings?.find(s => s.setting_key === 'wp_webhook_url');
      const keySetting = settings?.find(s => s.setting_key === 'wp_webhook_api_key');

      return res.status(200).json({
        webhook_url: urlSetting?.setting_value || '',
        api_key: keySetting?.setting_value || '',
      });
    }

    if (req.method === 'POST') {
      if (!tenantContext.tenantUserId) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { webhook_url, api_key, test } = req.body;

      if (test) {
        const testUrl = webhook_url || '';
        if (!testUrl) {
          return res.status(400).json({ error: 'Webhook URL is required for testing' });
        }

        try {
          const headers = { 'Content-Type': 'application/json' };
          if (api_key) {
            headers['X-IConnect-API-Key'] = api_key;
          }

          const resp = await fetch(testUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ event: 'test', article_id: null }),
            signal: AbortSignal.timeout(10000),
          });

          return res.status(200).json({
            success: resp.ok,
            status: resp.status,
            statusText: resp.statusText,
          });
        } catch (err) {
          return res.status(200).json({
            success: false,
            status: 0,
            statusText: err.message,
          });
        }
      }

      if (webhook_url !== undefined) {
        if (webhook_url && !/^https?:\/\/.+/.test(webhook_url)) {
          return res.status(400).json({ error: 'Webhook URL must start with http:// or https://' });
        }

        await supabase
          .from('system_settings')
          .upsert({
            tenant_id: tenantId,
            setting_key: 'wp_webhook_url',
            setting_value: webhook_url || '',
            setting_type: 'text',
            description: 'WordPress webhook URL for article sync notifications',
          }, { onConflict: 'tenant_id,setting_key' });
      }

      if (api_key !== undefined) {
        await supabase
          .from('system_settings')
          .upsert({
            tenant_id: tenantId,
            setting_key: 'wp_webhook_api_key',
            setting_value: api_key || '',
            setting_type: 'text',
            description: 'API key for authenticating WordPress webhook requests',
          }, { onConflict: 'tenant_id,setting_key' });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[WP Sync Settings] Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
