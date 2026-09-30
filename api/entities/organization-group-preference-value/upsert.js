import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

/**
 * Task #3601: tenant-safe upsert for organisation-group custom field values.
 * Mirrors api/entities/organization-preference-value/upsert.js minus the
 * Zoho / workflow side effects (explicitly out of scope for groups).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);

  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { organization_group_id, field_id, value } = req.body;

  if (!organization_group_id || !field_id) {
    return res.status(400).json({ error: 'organization_group_id and field_id are required' });
  }

  try {
    const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
    if (!effectiveTenantId) {
      return res.status(403).json({ error: 'Unable to verify tenant context' });
    }

    // Writes require admin access (tenant users bypass inside hasAdminAccess).
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // The group must belong to the caller's tenant.
    const { data: group } = await supabase
      .from('organization_group')
      .select('tenant_id')
      .eq('id', organization_group_id)
      .single();

    if (!group || group.tenant_id !== effectiveTenantId) {
      return res.status(403).json({ error: 'Organisation group does not belong to your tenant' });
    }

    // The field definition must belong to the caller's tenant and be
    // scoped to organisation groups.
    const { data: fieldDef } = await supabase
      .from('preference_field')
      .select('tenant_id, entity_scope')
      .eq('id', field_id)
      .single();

    if (!fieldDef || fieldDef.tenant_id !== effectiveTenantId || fieldDef.entity_scope !== 'organization_group') {
      return res.status(403).json({ error: 'Invalid field for this tenant' });
    }

    const { data, error } = await supabase
      .from('organization_group_preference_value')
      .upsert(
        {
          tenant_id: effectiveTenantId,
          organization_group_id,
          field_id,
          value: value !== undefined ? String(value) : '',
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'organization_group_id,field_id',
          ignoreDuplicates: false,
        }
      )
      .select()
      .single();

    if (error) {
      console.error('Error upserting organization_group_preference_value:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error in group preference upsert:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
