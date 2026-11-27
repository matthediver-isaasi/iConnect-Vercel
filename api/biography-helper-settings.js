import { supabase } from './_lib/database.js';
import { getTenantContext, hasAdminAccess } from './_lib/tenantContext.js';
import { BIOGRAPHY_HELPER_SETTING_KEY, DEFAULT_BIOGRAPHY_HELPER_TEXT, normalizeBiographyHelperText } from '../shared/biographyHelperText.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (deps.getTenantContext || getTenantContext)(req);
    if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required.' });
    const tenantId = context.tenantId;
    if (!tenantId || context.tenantMismatch) return res.status(403).json({ error: 'Invalid tenant context. Reload and try again.' });
    const canManage = await (deps.hasAdminAccess || hasAdminAccess)(context);
    if (req.method === 'PUT' && !canManage) return res.status(403).json({ error: 'Administrator access required.' });
    const db = deps.db || supabase;
    const { data: current, error: readError } = await db.from('system_settings').select('id,setting_value')
      .eq('tenant_id', tenantId).eq('setting_key', BIOGRAPHY_HELPER_SETTING_KEY).maybeSingle();
    if (readError) throw readError;
    if (req.method === 'PUT') {
      let helperText;
      try { helperText = normalizeBiographyHelperText(req.body?.helperText); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      // Persist the normalized default on reset as well. No global/null-tenant
      // fallback is used: each row belongs solely to the session tenant.
      const write = current
        ? db.from('system_settings').update({ setting_value: helperText })
          .eq('id', current.id).eq('tenant_id', tenantId).eq('setting_key', BIOGRAPHY_HELPER_SETTING_KEY)
        : db.from('system_settings').insert({
        tenant_id: tenantId, setting_key: BIOGRAPHY_HELPER_SETTING_KEY,
        setting_value: helperText,
        description: 'Plain-text explanation beneath the member Professional Biography input',
      });
      const { data, error } = await write.select('setting_value').single();
      if (error?.code === '23505') return res.status(409).json({ error: 'Settings changed. Retry saving your draft.' });
      if (error || !data || data.setting_value !== helperText) throw error || new Error('Save was not confirmed');
      return res.json({ tenantId, helperText, canManage });
    }
    const helperText = current ? normalizeBiographyHelperText(current.setting_value) : DEFAULT_BIOGRAPHY_HELPER_TEXT;
    return res.json({ tenantId, helperText, canManage });
  } catch {
    return res.status(503).json({ error: 'Biography helper settings could not be loaded or saved. Please retry.' });
  }
}
