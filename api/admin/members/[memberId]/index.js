import { getSessionMember } from '../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../_lib/roleVisibility.js';
import { triggerWorkflows } from '../../../_lib/workflows.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

  const { memberId } = req.query;

  if (req.method === 'GET') {
    try {
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('*')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      return res.json(member);
    } catch (error) {
      console.error('[Admin Get Member] Error:', error);
      return res.status(500).json({ error: 'Failed to get member' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const rawUpdates = req.body;

      const allowedFields = [
        'first_name', 'last_name', 'job_title', 'biography',
        'profile_photo_url', 'linkedin_url', 'show_in_directory',
        'twitter_url', 'phone_number', 'pronouns', 'location_summary'
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

      // Fetch the member before the update for workflow comparison
      const { data: beforeData } = await supabase
        .from('member')
        .select('*')
        .eq('id', memberId)
        .single();

      const { data: updatedMember, error: updateError } = await supabase
        .from('member')
        .update(updates)
        .eq('id', memberId)
        .select()
        .single();

      if (updateError) {
        console.error('[Admin Update Member] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      // Trigger workflows and check for pending confirmations
      let pendingWorkflowConfirmations = [];
      try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        const baseUrl = host ? `${protocol}://${host}` : '';
        
        const workflowResult = await triggerWorkflows('member', memberId, beforeData, updatedMember, 'field_change', baseUrl);
        if (workflowResult?.pendingConfirmations?.length > 0) {
          pendingWorkflowConfirmations = workflowResult.pendingConfirmations;
          console.log(`[Admin Update Member] ${pendingWorkflowConfirmations.length} workflow(s) pending confirmation`);
        }
      } catch (err) {
        console.error('[Admin Update Member] Workflow error:', err);
      }

      // Include pending confirmations in response if any
      if (pendingWorkflowConfirmations.length > 0) {
        return res.json({
          ...updatedMember,
          _pendingWorkflowConfirmations: pendingWorkflowConfirmations
        });
      }

      return res.json(updatedMember);
    } catch (error) {
      console.error('[Admin Update Member] Error:', error);
      return res.status(500).json({ error: 'Failed to update member' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
