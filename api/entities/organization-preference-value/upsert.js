import { supabase } from '../../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);
  
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { organization_id, field_id, value } = req.body;

  if (!organization_id || !field_id) {
    return res.status(400).json({ error: 'organization_id and field_id are required' });
  }

  try {
    const targetOrgId = organization_id;
    const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
    
    // Always validate organization belongs to user's tenant
    if (!effectiveTenantId) {
      return res.status(403).json({ error: 'Unable to verify tenant context' });
    }
    
    const { data: org } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', organization_id)
      .single();
    
    if (!org || org.tenant_id !== effectiveTenantId) {
      return res.status(403).json({ error: 'Organization does not belong to your tenant' });
    }
    
    // If editing a different organization, check cross-org permissions
    if (organization_id !== tenantCtx.organizationId) {
      let hasCrossOrgAccess = false;
      
      if (tenantCtx.roleId) {
        const { hasCrossOrgAccess: hasAccess } = await checkCrossOrgPermissions(tenantCtx.roleId);
        hasCrossOrgAccess = hasAccess;
      }
      
      if (!hasCrossOrgAccess) {
        return res.status(403).json({ error: 'You do not have permission to access other organizations' });
      }
    }

    const { data, error } = await supabase
      .from('organization_preference_value')
      .upsert(
        {
          organization_id: targetOrgId,
          field_id,
          value: value !== undefined ? String(value) : ''
        },
        {
          onConflict: 'organization_id,field_id',
          ignoreDuplicates: false
        }
      )
      .select()
      .single();

    if (error) {
      console.error('Error upserting organization_preference_value:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error in upsert:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
