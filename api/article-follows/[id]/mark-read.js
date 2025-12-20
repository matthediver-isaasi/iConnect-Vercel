import { createClient } from '@supabase/supabase-js';
import { getSession } from '../../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req);
  const memberId = session?.data?.memberId;

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
