import { supabase } from './database.js';

export async function dispatchWpWebhook(tenantId, event, articleId) {
  if (!tenantId) return;

  try {
    const { data: settings } = await supabase
      .from('system_settings')
      .select('setting_key, setting_value')
      .eq('tenant_id', tenantId)
      .in('setting_key', ['wp_webhook_url', 'wp_webhook_api_key']);

    if (!settings || settings.length === 0) return;

    const urlSetting = settings.find(s => s.setting_key === 'wp_webhook_url');
    const keySetting = settings.find(s => s.setting_key === 'wp_webhook_api_key');

    const webhookUrl = urlSetting?.setting_value;
    if (!webhookUrl) return;

    const headers = { 'Content-Type': 'application/json' };
    if (keySetting?.setting_value) {
      headers['X-IConnect-API-Key'] = keySetting.setting_value;
    }

    const payload = { event, article_id: articleId };

    console.log(`[WP Webhook] Dispatching ${event} for article ${articleId} to ${webhookUrl}`);

    fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
      .then(resp => {
        console.log(`[WP Webhook] Response: ${resp.status} ${resp.statusText}`);
      })
      .catch(err => {
        console.error(`[WP Webhook] Failed to dispatch ${event}:`, err.message);
      });
  } catch (err) {
    console.error(`[WP Webhook] Error looking up settings for tenant ${tenantId}:`, err.message);
  }
}
