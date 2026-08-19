import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { getAdzunaCredentials, fetchAdzunaJobs } from '../../_lib/adzunaFeed.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
  if (!await hasAdminAccess(context)) return res.status(403).json({ error: 'Admin access required' });
  try {
    const credentials = await getAdzunaCredentials(context.tenantId);
    if (!credentials) return res.status(400).json({ success: false, error: 'Save enabled Adzuna credentials before testing.' });
    await fetchAdzunaJobs(credentials, { result_limit: 1 });
    return res.json({ success: true, message: 'Adzuna connection successful.' });
  } catch (error) {
    return res.status(200).json({ success: false, error: error.message.includes('authentication') ? error.message : 'Unable to connect to Adzuna. Please try again.' });
  }
}