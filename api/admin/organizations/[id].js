import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';
import { triggerZohoCrmSync } from '../../_lib/zohoCrmSync.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyPermission(req, permissionId) {
  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return { hasPermission: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { hasPermission: false, memberId: sessionMember.id };
  }

  if (!supabase) {
    return { hasPermission: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasPermission: false, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
    
    // Derive admin status from whether admin.role-management is NOT excluded
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
    if (isAdmin) {
      return { hasPermission: true, memberId: sessionMember.id };
    }

    const hasPermission = !isResourceExcluded(excludedFeatures, permissionId);

    return { hasPermission, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Permission Verify] Error:', error);
    return { hasPermission: false, error: 'Verification failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { hasPermission, error } = await verifyPermission(req, 'admin_can_edit_members');

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasPermission) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { id: orgId } = req.query;

  try {
    const rawUpdates = req.body;

    const allowedFields = [
      'logo_url', 'name', 'description', 'website_url',
      'phone', 'invoicing_email', 'invoicing_address',
      'organization_group_id'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (rawUpdates[field] !== undefined) {
        updates[field] = rawUpdates[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // SECURITY: an organisation may only be assigned to an Organisation Group
    // belonging to the same tenant. Clearing (null/'') is always allowed.
    if ('organization_group_id' in updates) {
      if (updates.organization_group_id === '') updates.organization_group_id = null;
      if (updates.organization_group_id) {
        const { data: orgRow } = await supabase
          .from('organization')
          .select('tenant_id')
          .eq('id', orgId)
          .single();
        if (!orgRow?.tenant_id) {
          return res.status(404).json({ error: 'Organisation not found' });
        }
        const { data: targetGroup } = await supabase
          .from('organization_group')
          .select('id, tenant_id')
          .eq('id', updates.organization_group_id)
          .single();
        if (!targetGroup || targetGroup.tenant_id !== orgRow.tenant_id) {
          return res.status(403).json({ error: 'Organisation group not found in this tenant' });
        }
      }
    }

    const { data: updatedOrg, error: updateError } = await supabase
      .from('organization')
      .update(updates)
      .eq('id', orgId)
      .select()
      .single();

    if (updateError) {
      console.error('[Admin Update Org] Error:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    if (updatedOrg?.tenant_id) {
      triggerZohoCrmSync(updatedOrg.tenant_id, 'organization', orgId, { action: 'admin_update' });
    }

    return res.json(updatedOrg);
  } catch (error) {
    console.error('[Admin Update Org] Error:', error);
    return res.status(500).json({ error: 'Failed to update organization' });
  }
}
