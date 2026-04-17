import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import {
  listZohoCrmSyncModules,
  getZohoCrmModuleFields,
  isZohoCrmConnected
} from '../../_lib/zohoCrmClient.js';

const ENTITY_CORE_FIELDS = {
  member: [
    { key: 'first_name', label: 'First Name', type: 'text' },
    { key: 'last_name', label: 'Last Name', type: 'text' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'job_title', label: 'Job Title', type: 'text' },
    { key: 'organization_id', label: 'Organisation Id', type: 'text' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'membership_type', label: 'Membership Type', type: 'text' }
  ],
  organization: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'website', label: 'Website', type: 'url' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address_line_1', label: 'Address Line 1', type: 'text' },
    { key: 'address_line_2', label: 'Address Line 2', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'country', label: 'Country', type: 'text' },
    { key: 'description', label: 'Description', type: 'longtext' },
    { key: 'status', label: 'Status', type: 'text' }
  ]
};

async function loadCustomFields(tenantId, entityType) {
  const target = entityType === 'organization' ? 'organization' : 'member';
  try {
    const { data, error } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, entity_scope')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', target)
      .eq('is_active', true);
    if (error) {
      console.error('[ZohoCrmSync metadata] custom fields error:', error);
      return [];
    }
    return (data || []).map(f => ({
      key: `custom:${f.id}`,
      label: f.label || f.name,
      type: f.field_type || 'text',
      custom: true
    }));
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { resource, module, entity_type } = req.query;

    if (resource === 'connection') {
      const connected = await isZohoCrmConnected(tenantId);
      return res.status(200).json({ connected });
    }

    if (resource === 'modules') {
      try {
        const modules = await listZohoCrmSyncModules(tenantId);
        return res.status(200).json({ modules });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (resource === 'fields') {
      if (!module) return res.status(400).json({ error: 'module query param is required' });
      try {
        const fields = await getZohoCrmModuleFields(tenantId, module);
        return res.status(200).json({ fields });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (resource === 'iconnect-fields') {
      if (!entity_type || !ENTITY_CORE_FIELDS[entity_type]) {
        return res.status(400).json({ error: 'entity_type must be member or organization' });
      }
      const core = ENTITY_CORE_FIELDS[entity_type];
      const custom = await loadCustomFields(tenantId, entity_type);
      return res.status(200).json({ core, custom });
    }

    return res.status(400).json({ error: 'Unknown resource' });
  } catch (err) {
    console.error('[ZohoCrmSync metadata] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
