import { supabase } from '../../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../../_lib/tenantContext.js';
import { triggerPreferenceWorkflows } from '../../_lib/workflows.js';

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

    let previousValue = undefined;
    const { data: existingPref } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', targetOrgId)
      .eq('field_id', field_id)
      .single();
    if (existingPref) {
      previousValue = existingPref.value;
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

    const storedValue = value !== undefined ? String(value) : '';

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    let host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!host && process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');

    let pendingWorkflowConfirmations = [];
    try {
      const prefResult = await triggerPreferenceWorkflows('organization', targetOrgId, field_id, storedValue, baseUrl, previousValue);
      if (prefResult?.pendingConfirmations?.length > 0) {
        pendingWorkflowConfirmations = prefResult.pendingConfirmations;
      }
    } catch (err) {
      console.error('Preference workflow error in upsert:', err);
    }

    if (pendingWorkflowConfirmations.length > 0) {
      return res.status(200).json({
        ...data,
        _pendingWorkflowConfirmations: pendingWorkflowConfirmations
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error in upsert:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
