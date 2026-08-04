import { supabase } from '../../_lib/database.js';
import { getTenantContext, checkCrossMemberPermissions } from '../../_lib/tenantContext.js';
import { triggerPreferenceWorkflows } from '../../_lib/workflows.js';
import { triggerZohoCrmSync } from '../../_lib/zohoCrmSync.js';
import { getPublicBaseUrl } from '../../_lib/publicBaseUrl.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);

  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { member_id, field_id, value } = req.body;

  if (!member_id || !field_id) {
    return res.status(400).json({ error: 'member_id and field_id are required' });
  }

  try {
    const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;

    if (!effectiveTenantId) {
      return res.status(403).json({ error: 'Unable to verify tenant context' });
    }

    const { data: member } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', member_id)
      .single();

    if (!member || member.tenant_id !== effectiveTenantId) {
      return res.status(403).json({ error: 'Member does not belong to your tenant' });
    }

    if (member_id !== tenantCtx.memberId) {
      let hasCrossMemberAccess = false;

      if (tenantCtx.roleId) {
        const { hasCrossMemberAccess: hasAccess } = await checkCrossMemberPermissions(tenantCtx.roleId);
        hasCrossMemberAccess = hasAccess;
      }

      if (!hasCrossMemberAccess) {
        return res.status(403).json({ error: 'You do not have permission to access other members' });
      }
    }

    let previousValue = undefined;
    const { data: existingPref } = await supabase
      .from('member_preference_value')
      .select('value')
      .eq('member_id', member_id)
      .eq('field_id', field_id)
      .single();
    if (existingPref) {
      previousValue = existingPref.value;
    }

    const { data, error } = await supabase
      .from('member_preference_value')
      .upsert(
        {
          member_id,
          field_id,
          value: value !== undefined ? String(value) : ''
        },
        {
          onConflict: 'member_id,field_id',
          ignoreDuplicates: false
        }
      )
      .select()
      .single();

    if (error) {
      console.error('Error upserting member_preference_value:', error);
      return res.status(500).json({ error: error.message });
    }

    const storedValue = value !== undefined ? String(value) : '';

    triggerZohoCrmSync(effectiveTenantId, 'member', member_id, { action: 'preference_change' });

    const baseUrl = getPublicBaseUrl(req);

    let pendingWorkflowConfirmations = [];
    try {
      const prefResult = await triggerPreferenceWorkflows('member', member_id, field_id, storedValue, baseUrl, previousValue);
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
    console.error('Unexpected error in member preference value upsert:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
