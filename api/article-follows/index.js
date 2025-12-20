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

  const session = await getSession(req);
  const memberId = session?.data?.memberId;

  if (!memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    if (req.method === 'GET') {
      const { data: follows, error } = await supabase
        .from('article_follow')
        .select('*')
        .eq('follower_member_id', memberId);

      if (error) {
        console.error('Error fetching follows:', error);
        return res.status(500).json({ error: error.message });
      }

      const followsWithUnread = await Promise.all(
        (follows || []).map(async (follow) => {
          let unreadCount = 0;
          
          let query = supabase
            .from('blog_post')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'published')
            .gt('published_date', follow.last_read_at);

          if (follow.followed_member_id) {
            query = query.eq('author_id', follow.followed_member_id);
          } else if (follow.followed_guest_writer_id) {
            query = query.eq('guest_writer_id', follow.followed_guest_writer_id);
          }

          const { count } = await query;
          unreadCount = count || 0;

          let authorName = 'Unknown Author';
          let authorHandle = null;
          let debugInfo = null;
          
          if (follow.followed_member_id) {
            const { data: member, error: memberError } = await supabase
              .from('member')
              .select('first_name, last_name, handle')
              .eq('id', follow.followed_member_id)
              .single();
            
            console.log('[article-follows] Member lookup result:', { 
              followed_member_id: follow.followed_member_id, 
              member, 
              memberError 
            });
            
            if (member && !memberError) {
              authorName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Author';
              authorHandle = member.handle;
            } else {
              debugInfo = { 
                lookup_failed: true, 
                followed_member_id: follow.followed_member_id,
                error: memberError?.message || 'No member found'
              };
            }
          } else if (follow.followed_guest_writer_id) {
            const { data: guestWriter, error: gwError } = await supabase
              .from('guest_writer')
              .select('full_name, handle')
              .eq('id', follow.followed_guest_writer_id)
              .single();
            
            if (guestWriter && !gwError) {
              authorName = guestWriter.full_name || 'Unknown Author';
              authorHandle = guestWriter.handle;
            } else {
              debugInfo = { 
                lookup_failed: true, 
                followed_guest_writer_id: follow.followed_guest_writer_id,
                error: gwError?.message || 'No guest writer found'
              };
            }
          }

          return {
            ...follow,
            unread_count: unreadCount,
            author_name: authorName,
            author_handle: authorHandle,
            _debug: debugInfo
          };
        })
      );

      return res.json(followsWithUnread);
    } else if (req.method === 'POST') {
      const { followed_member_id, followed_guest_writer_id } = req.body;

      if (!followed_member_id && !followed_guest_writer_id) {
        return res.status(400).json({ error: 'Author ID required' });
      }

      if (followed_member_id && followed_guest_writer_id) {
        return res.status(400).json({ error: 'Cannot specify both member and guest writer' });
      }

      if (followed_member_id && followed_member_id === memberId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
      }

      if (followed_member_id) {
        const { data: member, error: memberError } = await supabase
          .from('member')
          .select('id')
          .eq('id', followed_member_id)
          .single();
        
        if (memberError || !member) {
          return res.status(404).json({ error: 'Author not found' });
        }
      } else if (followed_guest_writer_id) {
        const { data: guestWriter, error: gwError } = await supabase
          .from('guest_writer')
          .select('id')
          .eq('id', followed_guest_writer_id)
          .single();
        
        if (gwError || !guestWriter) {
          return res.status(404).json({ error: 'Guest writer not found' });
        }
      }

      let checkQuery = supabase
        .from('article_follow')
        .select('id')
        .eq('follower_member_id', memberId);

      if (followed_member_id) {
        checkQuery = checkQuery.eq('followed_member_id', followed_member_id);
      } else {
        checkQuery = checkQuery.eq('followed_guest_writer_id', followed_guest_writer_id);
      }

      const { data: existingFollow } = await checkQuery.single();

      if (existingFollow) {
        return res.status(400).json({ error: 'Already following this author' });
      }

      const { data, error } = await supabase
        .from('article_follow')
        .insert({
          follower_member_id: memberId,
          followed_member_id: followed_member_id || null,
          followed_guest_writer_id: followed_guest_writer_id || null,
          created_at: new Date().toISOString(),
          last_read_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating follow:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(201).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Article follows error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
