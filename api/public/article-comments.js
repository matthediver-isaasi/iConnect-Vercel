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

    const { data: publicCommentsSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('tenant_id', tenant.id)
      .eq('setting_key', 'article_allow_public_comments')
      .single();

    const allowPublicComments = publicCommentsSetting?.setting_value === 'true';

    if (!allowPublicComments) {
      return res.status(403).json({ error: 'Public comments are not enabled' });
    }

    const { articleId } = req.query;

    if (!articleId) {
      return res.status(400).json({ error: 'Article ID is required' });
    }

    if (req.method === 'GET') {
      const { data: comments, error } = await supabase
        .from('article_comment')
        .select('id, article_id, comment_text, commenter_name, created_at, thumbs_up_count, thumbs_down_count')
        .eq('tenant_id', tenant.id)
        .eq('article_id', articleId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[Public Article Comments] Query error:', error);
        return res.status(500).json({ error: 'Failed to fetch comments' });
      }

      return res.json({ comments: comments || [] });
    }

    if (req.method === 'POST') {
      const { comment_text, commenter_name, user_identifier } = req.body;

      if (!comment_text || !comment_text.trim()) {
        return res.status(400).json({ error: 'Comment text is required' });
      }

      if (!commenter_name || !commenter_name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const { data: newComment, error } = await supabase
        .from('article_comment')
        .insert({
          tenant_id: tenant.id,
          article_id: articleId,
          comment_text: comment_text.trim(),
          commenter_name: commenter_name.trim(),
          user_identifier: user_identifier || null,
          thumbs_up_count: 0,
          thumbs_down_count: 0
        })
        .select()
        .single();

      if (error) {
        console.error('[Public Article Comments] Insert error:', error);
        return res.status(500).json({ error: 'Failed to add comment' });
      }

      return res.status(201).json({ comment: newComment });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Public Article Comments] Error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
}
