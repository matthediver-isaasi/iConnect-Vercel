import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { PRIMARY_CAROUSEL_SETTINGS } from '../_lib/directoryCarouselConsent.js';

export function createHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const isAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch || !context.tenantId) return res.status(403).json({ error: 'Invalid tenant context' });
      if (!await isAdmin(context)) return res.status(403).json({ error: 'Administrator access required' });
      const source = req.query?.source;
      const key = Object.hasOwn(PRIMARY_CAROUSEL_SETTINGS, source) ? PRIMARY_CAROUSEL_SETTINGS[source] : null;
      if (!key) return res.status(400).json({ error: 'Invalid primary directory source' });
      if (req.method === 'PUT' && typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'Public carousel permission must be a boolean' });
      }
      const { data: rows, error } = await db.from('system_settings').select('id,setting_value')
        .eq('tenant_id', context.tenantId).eq('setting_key', key).limit(2);
      if (error) throw error;
      if (rows?.length > 1) return res.status(409).json({ error: 'Duplicate directory settings require administrator repair' });
      if (req.method === 'GET') return res.json({ enabled: rows?.[0]?.setting_value === 'true' });
      const value = String(req.body.enabled);
      const result = rows?.[0]
        ? await db.from('system_settings').update({ setting_value: value })
          .eq('tenant_id', context.tenantId).eq('setting_key', key).eq('id', rows[0].id)
        : await db.from('system_settings').insert({
          tenant_id: context.tenantId, setting_key: key, setting_value: value,
          description: 'Explicit permission for safe public Directory Carousel display only',
        });
      if (result.error) {
        if (result.error.code === '23505') return res.status(409).json({ error: 'Settings changed. Reload and try again.' });
        throw result.error;
      }
      return res.json({ enabled: req.body.enabled });
    } catch {
      return res.status(503).json({ error: 'Public carousel settings are unavailable. No permission change was confirmed.' });
    }
  };
}

export default createHandler();
