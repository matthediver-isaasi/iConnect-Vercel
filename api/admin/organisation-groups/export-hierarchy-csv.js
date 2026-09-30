import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import {
  loadOrganisationGroupHierarchy,
  renderOrganisationGroupHierarchyCsv,
} from '../../_lib/organisationGroupHierarchyExport.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
  if (!context.tenantId || !(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (context.roleId && !(await hasFeatureAccess(context.roleId, 'crm.organisation-groups'))) {
    return res.status(403).json({ error: 'Organisation Groups access required' });
  }

  try {
    const rows = await loadOrganisationGroupHierarchy(supabase, context.tenantId);
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="organisation_group_hierarchy_${today}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(renderOrganisationGroupHierarchyCsv(rows));
  } catch (error) {
    console.error('[OrganisationGroupHierarchyExport] Error:', error);
    return res.status(500).json({ error: 'Failed to export organisation group hierarchy' });
  }
}
