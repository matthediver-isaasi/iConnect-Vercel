import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { saveFormPrivacyUrl } from '../_lib/formPrivacySettings.js';
import { FORM_PRIVACY_SETTINGS_KEY, safeFormPrivacyUrl } from '../../shared/formConsentSettings.js';

export default async function handler(req, res, deps = {}) {
  const db = deps.supabase || supabase;
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!db) {
    return req.method === 'GET'
      ? res.status(200).json({ message: '', privacy_settings_url: '' })
      : res.status(503).json({ error: 'Database unavailable' });
  }

  try {
    if (req.method === 'POST') {
      const context = await (deps.getTenantContext || getTenantContext)(req);
      if (context?.tenantMismatch) {
        return res.status(409).json({
          error: 'Tenant context has changed. Please refresh this page.',
          code: 'TENANT_CONTEXT_CHANGED',
        });
      }
      if (!context || !await (deps.hasAdminAccess || hasAdminAccess)(context)) {
        return res.status(403).json({ error: 'Administrator access required' });
      }
      const tenantId = context.effectiveTenantId || context.tenantId;
      if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
      return res.json(await saveFormPrivacyUrl(db, tenantId, req.body?.privacy_settings_url));
    }
    // Resolve tenant from request (subdomain, header, etc.)
    const tenant = await (deps.resolveTenantFromRequest || resolveTenantFromRequest)(req);
    
    if (!tenant) {
      // No tenant found - return empty message
      return res.json({ message: '', privacy_settings_url: '' });
    }

    const { data, error } = await db
      .from('system_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['form_default_consent_message', FORM_PRIVACY_SETTINGS_KEY])
      .eq('tenant_id', tenant.id);

    if (error) {
      console.error('Error fetching form consent message:', error);
      return res.status(500).json({ error: error.message });
    }

    const messages = (data || []).filter(row => row.setting_key === 'form_default_consent_message');
    const urls = (data || []).filter(row => row.setting_key === FORM_PRIVACY_SETTINGS_KEY);
    if (messages.length > 1 || urls.length > 1) throw new Error('Duplicate consent settings');
    return res.json({
      message: messages[0]?.setting_value || '',
      privacy_settings_url: safeFormPrivacyUrl(urls[0]?.setting_value),
    });
  } catch (error) {
    console.error('Form consent message fetch error:', error);
    return res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : 'Failed to load or save consent settings',
    });
  }
}
