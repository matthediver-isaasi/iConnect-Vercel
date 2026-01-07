import { getSessionMember } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const member = await getSessionMember(req);
  const memberId = member?.id;

  if (!memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.query;

  try {
    const { data: follow, error: fetchError } = await supabase
      .from('article_follow')
      .select('*')
      .eq('id', id)
      .eq('follower_member_id', memberId)
      .single();

    if (fetchError || !follow) {
      return res.status(404).json({ error: 'Follow not found' });
    }

    const { data, error } = await supabase
      .from('article_follow')
      .update({ last_read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('follower_member_id', memberId)
      .select()
      .single();

    if (error) {
      console.error('Error updating follow:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data);
  } catch (error) {
    console.error('Mark read error:', error);
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
}
