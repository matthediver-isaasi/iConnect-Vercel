import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { commentId, userIdentifier } = req.query;

    if (req.method === 'GET') {
      if (userIdentifier) {
        // Get reactions for this user, scoped to tenant via article_comment -> blog_post join
        const { data: reactions, error } = await supabase
          .from('comment_reaction')
          .select(`
            id, comment_id, reaction_type, user_identifier, is_member,
            article_comment!inner(article_id, blog_post!inner(tenant_id))
          `)
          .eq('user_identifier', userIdentifier)
          .eq('article_comment.blog_post.tenant_id', tenant.id);

        if (error) {
          console.error('[Public Comment Reactions] Query error:', error);
          return res.status(500).json({ error: 'Failed to fetch reactions' });
        }

        // Clean up the response to only include reaction fields
        const cleanReactions = (reactions || []).map(r => ({
          id: r.id,
          comment_id: r.comment_id,
          reaction_type: r.reaction_type,
          user_identifier: r.user_identifier,
          is_member: r.is_member
        }));

        return res.json({ reactions: cleanReactions });
      }

      if (!commentId) {
        return res.status(400).json({ error: 'Comment ID or user identifier is required' });
      }

      // Verify comment belongs to this tenant before fetching reactions
      const { data: commentCheck } = await supabase
        .from('article_comment')
        .select('id, blog_post!inner(tenant_id)')
        .eq('id', commentId)
        .eq('blog_post.tenant_id', tenant.id)
        .single();

      if (!commentCheck) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      const { data: reactions, error } = await supabase
        .from('comment_reaction')
        .select('id, comment_id, reaction_type, user_identifier, is_member')
        .eq('comment_id', commentId);

      if (error) {
        console.error('[Public Comment Reactions] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch reactions' });
      }

      return res.json({ reactions: reactions || [] });
    }

    if (req.method === 'POST') {
      const { comment_id, reaction_type, user_identifier, is_member } = req.body;

      if (!comment_id) {
        return res.status(400).json({ error: 'Comment ID is required' });
      }

      if (!reaction_type || !['up', 'down'].includes(reaction_type)) {
        return res.status(400).json({ error: 'Valid reaction type (up/down) is required' });
      }

      if (!user_identifier) {
        return res.status(400).json({ error: 'User identifier is required' });
      }

      // Verify comment belongs to this tenant before allowing reaction
      const { data: comment } = await supabase
        .from('article_comment')
        .select('id, thumbs_up_count, thumbs_down_count, blog_post!inner(tenant_id)')
        .eq('id', comment_id)
        .eq('blog_post.tenant_id', tenant.id)
        .single();

      if (!comment) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      const { data: existingReaction } = await supabase
        .from('comment_reaction')
        .select('id, reaction_type')
        .eq('comment_id', comment_id)
        .eq('user_identifier', user_identifier)
        .single();

      if (existingReaction) {
        if (existingReaction.reaction_type === reaction_type) {
          const { error: deleteError } = await supabase
            .from('comment_reaction')
            .delete()
            .eq('id', existingReaction.id);

          if (deleteError) {
            console.error('[Public Comment Reactions] Delete error:', deleteError);
            return res.status(500).json({ error: 'Failed to remove reaction' });
          }

          const updateData = reaction_type === 'up'
            ? { thumbs_up_count: Math.max(0, (comment.thumbs_up_count || 0) - 1) }
            : { thumbs_down_count: Math.max(0, (comment.thumbs_down_count || 0) - 1) };
          
          await supabase
            .from('article_comment')
            .update(updateData)
            .eq('id', comment_id);

          return res.json({ action: 'removed', reactionType: reaction_type });
        } else {
          const { error: updateError } = await supabase
            .from('comment_reaction')
            .update({ reaction_type })
            .eq('id', existingReaction.id);

          if (updateError) {
            console.error('[Public Comment Reactions] Update error:', updateError);
            return res.status(500).json({ error: 'Failed to update reaction' });
          }

          const updateData = reaction_type === 'up'
            ? { 
                thumbs_up_count: (comment.thumbs_up_count || 0) + 1,
                thumbs_down_count: Math.max(0, (comment.thumbs_down_count || 0) - 1)
              }
            : { 
                thumbs_down_count: (comment.thumbs_down_count || 0) + 1,
                thumbs_up_count: Math.max(0, (comment.thumbs_up_count || 0) - 1)
              };
          
          await supabase
            .from('article_comment')
            .update(updateData)
            .eq('id', comment_id);

          return res.json({ action: 'switched', reactionType: reaction_type });
        }
      }

      const { data: newReaction, error: insertError } = await supabase
        .from('comment_reaction')
        .insert({
          comment_id,
          reaction_type,
          user_identifier,
          is_member: is_member || false
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Public Comment Reactions] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to add reaction' });
      }

      const updateData = reaction_type === 'up'
        ? { thumbs_up_count: (comment.thumbs_up_count || 0) + 1 }
        : { thumbs_down_count: (comment.thumbs_down_count || 0) + 1 };
      
      await supabase
        .from('article_comment')
        .update(updateData)
        .eq('id', comment_id);

      return res.status(201).json({ action: 'added', reaction: newReaction });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Public Comment Reactions] Error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
}
