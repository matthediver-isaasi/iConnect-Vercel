import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyAdminAccess(req) {
  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return { hasAccess: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { hasAccess: false, memberId: sessionMember.id };
  }

  if (!supabase) {
    return { hasAccess: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasAccess: false, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
    
    if (isAdmin) {
      return { hasAccess: true, memberId: sessionMember.id };
    }

    return { hasAccess: false, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Member Note Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { hasAccess, error, memberId } = await verifyAdminAccess(req);

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasAccess) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { noteId } = req.query;

  if (req.method === 'PATCH') {
    try {
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Note content is required' });
      }

      const { data: updatedNote, error: updateError } = await supabase
        .from('member_note')
        .update({
          content: content.trim(),
          updated_at: new Date().toISOString()
        })
        .eq('id', noteId)
        .select()
        .single();

      if (updateError) {
        console.error('[Update Member Note] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      return res.json(updatedNote);
    } catch (error) {
      console.error('[Update Member Note] Error:', error);
      return res.status(500).json({ error: 'Failed to update note' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error: deleteError } = await supabase
        .from('member_note')
        .delete()
        .eq('id', noteId);

      if (deleteError) {
        console.error('[Delete Member Note] Error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('[Delete Member Note] Error:', error);
      return res.status(500).json({ error: 'Failed to delete note' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
