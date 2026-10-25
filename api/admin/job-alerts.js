import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { jobAlertSettings } from '../_lib/jobAlerts.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await getTenantContext(req);
    if (!context.tenantId || !await hasAdminAccess(context)) return res.status(403).json({ error: 'Administrator access required' });
    if (req.method === 'PATCH') {
      if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Enabled must be true or false' });
      const { error } = await supabase.rpc('configure_job_alerts', { p_tenant_id: context.tenantId, p_enabled: req.body.enabled });
      if (error) throw error;
    }
    const settings = await jobAlertSettings(supabase, context.tenantId);
    return res.json({ enabled: settings.enabled, categoryId: settings.category_id });
  } catch (error) {
    console.error('[Job alerts] Settings request failed', error.code || error.message);
    return res.status(503).json({ error: 'Job alert settings are unavailable. Please try again.' });
  }
}
