import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { getAdzunaCredentials, fetchAdzunaJobs, getAdzunaQuery, mapAdzunaJob, syncAdzunaFeed } from '../../_lib/adzunaFeed.js';

const cleanConfig = (body = {}) => ({
  keywords: String(body.keywords || '').slice(0, 500), exclusions: String(body.exclusions || '').slice(0, 500),
  category: String(body.category || '').slice(0, 100) || null, location: String(body.location || '').slice(0, 255) || null,
  max_days_old: Math.min(90, Math.max(1, Number(body.max_days_old) || 30)),
  result_limit: Math.min(50, Math.max(1, Number(body.result_limit) || 25)),
});
async function admin(req) {
  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) return [null, 401];
  return [context, await hasAdminAccess(context) ? 200 : 403];
}
export default async function handler(req, res) {
  const [context, access] = await admin(req);
  if (access !== 200) return res.status(access).json({ error: access === 401 ? 'Unauthorized' : 'Admin access required' });
  if (req.method === 'GET') {
    const [{ data: config }, credentials] = await Promise.all([
      supabase.from('tenant_job_feed_config').select('*').eq('tenant_id', context.tenantId).maybeSingle(),
      getAdzunaCredentials(context.tenantId),
    ]);
    return res.json({ configured: !!credentials, enabled: !!credentials, config: config || {}, safeQuery: getAdzunaQuery(config || {}).toString() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = req.body?.action || 'save';
  const config = cleanConfig(req.body);
  if (action === 'save') {
    const { error } = await supabase.from('tenant_job_feed_config').upsert({ tenant_id: context.tenantId, provider: 'adzuna', ...config, updated_at: new Date().toISOString() });
    return error ? res.status(500).json({ error: 'Unable to save feed settings' }) : res.json({ success: true, config });
  }
  const credentials = await getAdzunaCredentials(context.tenantId);
  if (!credentials) return res.status(400).json({ error: 'Adzuna credentials are missing or disabled.' });
  if (action === 'preview') {
    try { return res.json({ jobs: (await fetchAdzunaJobs(credentials, config)).map(j => mapAdzunaJob(j)).filter(Boolean) }); }
    catch (error) { return res.status(502).json({ error: error.message }); }
  }
  if (action === 'sync') {
    const { error: saveError } = await supabase.from('tenant_job_feed_config').upsert({ tenant_id: context.tenantId, provider: 'adzuna', ...config, updated_at: new Date().toISOString() });
    if (saveError) return res.status(500).json({ error: 'Unable to save feed settings' });
    try { return res.json({ success: true, ...(await syncAdzunaFeed(context.tenantId)) }); }
    catch (error) {
      await supabase.from('tenant_job_feed_config').upsert({ tenant_id: context.tenantId, provider: 'adzuna', ...config, last_sync_at: new Date().toISOString(), last_error: error.message.slice(0, 500) });
      return res.status(502).json({ error: error.message });
    }
  }
  return res.status(400).json({ error: 'Unknown action' });
}