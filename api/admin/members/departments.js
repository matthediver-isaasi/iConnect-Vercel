import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { listDepartmentOptions, MemberDepartmentError } from '../../_lib/memberDepartments.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
  if (!context.tenantId || !(await hasAdminAccess(context))) return res.status(403).json({ error: 'Administrator access required' });
  const rawOrganizationId = String(req.query.organizationId || '');
  const organizationIds = rawOrganizationId === 'all' ? [] : rawOrganizationId.split(',').map(id => id.trim()).filter(Boolean).slice(0, 100);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (organizationIds.some(id => !UUID_RE.test(id))) return res.status(400).json({ error: 'organizationId contains an invalid ID' });
  try {
    return res.json({ departments: await listDepartmentOptions(supabase, context.tenantId, organizationIds) });
  } catch (error) {
    if (error instanceof MemberDepartmentError) return res.status(error.status).json({ error: error.message });
    console.error('[Member departments] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch departments' });
  }
}