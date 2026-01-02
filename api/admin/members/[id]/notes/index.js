import { getSessionMember } from '../../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../../_lib/roleVisibility.js';

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
      return { hasAccess: true, memberId: sessionMember.id, memberName: `${sessionMember.first_name || ''} ${sessionMember.last_name || ''}`.trim() || sessionMember.email };
    }

    return { hasAccess: false, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Member Notes Access Verify] Error:', error);
    return { hasAccess: false, error: 'Verification failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { hasAccess, error, memberId, memberName } = await verifyAdminAccess(req);

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasAccess) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { id: targetMemberId } = req.query;

  if (req.method === 'GET') {
    try {
      const { data: notes, error: fetchError } = await supabase
        .from('member_note')
        .select('*')
        .eq('target_member_id', targetMemberId)
        .order('created_at', { ascending: false });

      if (fetchError) {
        console.error('[Get Member Notes] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      const authorIds = [...new Set(notes.map(n => n.author_member_id))];
      let authorMap = {};
      
      if (authorIds.length > 0) {
        const { data: members } = await supabase
          .from('member')
          .select('id, first_name, last_name, email')
          .in('id', authorIds);
        
        if (members) {
          authorMap = members.reduce((acc, m) => {
            acc[m.id] = `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email;
            return acc;
          }, {});
        }
      }

      const notesWithNames = notes.map(note => ({
        ...note,
        author_name: authorMap[note.author_member_id] || 'Unknown'
      }));

      return res.json(notesWithNames);
    } catch (error) {
      console.error('[Get Member Notes] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch notes' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { content, attachments } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Note content is required' });
      }

      const { data: newNote, error: insertError } = await supabase
        .from('member_note')
        .insert({
          target_member_id: targetMemberId,
          author_member_id: memberId,
          content: content.trim(),
          attachments: attachments || []
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Create Member Note] Error:', insertError);
        return res.status(500).json({ error: insertError.message });
      }

      return res.json({
        ...newNote,
        author_name: memberName
      });
    } catch (error) {
      console.error('[Create Member Note] Error:', error);
      return res.status(500).json({ error: 'Failed to create note' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
