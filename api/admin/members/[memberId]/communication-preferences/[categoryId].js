import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';

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

  const { hasPermission, error } = await verifyPermission(req, 'admin_can_manage_communications');

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasPermission) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { memberId, categoryId } = req.query;

  try {
    const { is_subscribed } = req.body;

    if (typeof is_subscribed !== 'boolean') {
      return res.status(400).json({ error: 'is_subscribed must be a boolean' });
    }

    const { data: existingPref } = await supabase
      .from('member_communication_preference')
      .select('id')
      .eq('member_id', memberId)
      .eq('category_id', categoryId)
      .single();

    if (existingPref) {
      const { data, error: updateError } = await supabase
        .from('member_communication_preference')
        .update({ 
          is_subscribed,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingPref.id)
        .select()
        .single();

      if (updateError) {
        console.error('[Admin Update Comm Pref] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      return res.json(data);
    } else {
      const { data, error: insertError } = await supabase
        .from('member_communication_preference')
        .insert({
          member_id: memberId,
          category_id: categoryId,
          is_subscribed
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Admin Create Comm Pref] Error:', insertError);
        return res.status(500).json({ error: insertError.message });
      }

      return res.json(data);
    }
  } catch (error) {
    console.error('[Admin Comm Pref] Error:', error);
    return res.status(500).json({ error: 'Failed to update communication preference' });
  }
}
