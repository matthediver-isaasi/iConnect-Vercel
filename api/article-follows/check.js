import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req);
  const memberId = session?.data?.memberId;

  if (!memberId) {
    return res.json({ following: false, followId: null });
  }

  const { author_id, guest_writer_id } = req.query;

  if (!author_id && !guest_writer_id) {
    return res.status(400).json({ error: 'Author ID required' });
  }

  try {
    let query = supabase
      .from('article_follow')
      .select('id')
      .eq('follower_member_id', memberId);

    if (author_id) {
      query = query.eq('followed_member_id', author_id);
    } else {
      query = query.eq('followed_guest_writer_id', guest_writer_id);
    }

    const { data, error } = await query.single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error checking follow status:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      following: !!data,
      followId: data?.id || null
    });
  } catch (error) {
    console.error('Follow check error:', error);
    return res.status(500).json({ error: 'Failed to check follow status' });
  }
}
