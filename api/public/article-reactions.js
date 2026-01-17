import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { articleId } = req.query;

    if (!articleId) {
      return res.status(400).json({ error: 'Article ID is required' });
    }

    if (req.method === 'GET') {
      const { data: reactions, error } = await supabase
        .from('article_reaction')
        .select('id, article_id, reaction_type, user_identifier, is_member')
        .eq('article_id', articleId);

      if (error) {
        console.error('[Public Article Reactions] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch reactions' });
      }

      return res.json({ reactions: reactions || [] });
    }

    if (req.method === 'POST') {
      const { reaction_type, user_identifier, is_member } = req.body;

      if (!reaction_type || !['up', 'down'].includes(reaction_type)) {
        return res.status(400).json({ error: 'Valid reaction type (up/down) is required' });
      }

      if (!user_identifier) {
        return res.status(400).json({ error: 'User identifier is required' });
      }

      const { data: existingReaction } = await supabase
        .from('article_reaction')
        .select('id, reaction_type')
        .eq('article_id', articleId)
        .eq('user_identifier', user_identifier)
        .single();

      if (existingReaction) {
        if (existingReaction.reaction_type === reaction_type) {
          const { error: deleteError } = await supabase
            .from('article_reaction')
            .delete()
            .eq('id', existingReaction.id);

          if (deleteError) {
            console.error('[Public Article Reactions] Delete error:', deleteError);
            return res.status(500).json({ error: 'Failed to remove reaction' });
          }

          return res.json({ action: 'removed', reactionType: reaction_type });
        } else {
          const { data: updatedReaction, error: updateError } = await supabase
            .from('article_reaction')
            .update({ reaction_type })
            .eq('id', existingReaction.id)
            .select()
            .single();

          if (updateError) {
            console.error('[Public Article Reactions] Update error:', updateError);
            return res.status(500).json({ error: 'Failed to update reaction' });
          }

          return res.json({ action: 'switched', reaction: updatedReaction });
        }
      }

      const { data: newReaction, error: insertError } = await supabase
        .from('article_reaction')
        .insert({
          article_id: articleId,
          reaction_type,
          user_identifier,
          is_member: is_member || false
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Public Article Reactions] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to add reaction' });
      }

      return res.status(201).json({ action: 'added', reaction: newReaction });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Public Article Reactions] Error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
}
