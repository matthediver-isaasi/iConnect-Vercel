import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';

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
      .select('is_admin, excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasPermission: false, memberId: sessionMember.id };
    }

    if (role.is_admin === true) {
      return { hasPermission: true, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
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
      'phone', 'invoicing_email', 'invoicing_address'
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

    return res.json(updatedOrg);
  } catch (error) {
    console.error('[Admin Update Org] Error:', error);
    return res.status(500).json({ error: 'Failed to update organization' });
  }
}
