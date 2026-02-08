import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const tenantCtx = await getTenantContext(req);
    if (!tenantCtx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized - tenant context required' });
    }

    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'postId is required' });
    }

    const { data: post, error: postError } = await supabase
      .from('forum_post')
      .select('*')
      .eq('id', postId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (postError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.is_deleted) {
      return res.status(400).json({ error: 'Post is already deleted' });
    }

    const isOwner = post.created_by === tenantCtx.memberId;
    const isTenantAdmin = !!tenantCtx.tenantUserId;

    console.log('[Forum Delete Post] Permission check:', {
      postCreatedBy: post.created_by,
      contextMemberId: tenantCtx.memberId,
      isOwner,
      isTenantAdmin,
      roleId: tenantCtx.roleId,
      tenantUserId: tenantCtx.tenantUserId
    });

    let canDeleteAny = isTenantAdmin;
    let canDeleteOwn = false;
    if (tenantCtx.roleId) {
      const { data: features, error: featError } = await supabase
        .from('role_feature')
        .select('feature_key')
        .eq('role_id', tenantCtx.roleId)
        .in('feature_key', ['forum.threads.delete-any', 'forum.threads.delete-own']);
      console.log('[Forum Delete Post] Role features query:', {
        roleId: tenantCtx.roleId,
        features: features?.map(f => f.feature_key),
        error: featError?.message
      });
      const featureKeys = (features || []).map(f => f.feature_key);
      if (featureKeys.includes('forum.threads.delete-any')) canDeleteAny = true;
      if (featureKeys.includes('forum.threads.delete-own')) canDeleteOwn = true;
    } else {
      console.log('[Forum Delete Post] No roleId - skipping permission feature check');
    }

    console.log('[Forum Delete Post] Final permission:', { canDeleteAny, canDeleteOwn, isOwner, allowed: canDeleteAny || (canDeleteOwn && isOwner) });

    if (!canDeleteAny && !(canDeleteOwn && isOwner)) {
      return res.status(403).json({ error: 'You do not have permission to delete this post' });
    }

    const { data: childPosts } = await supabase
      .from('forum_post')
      .select('id')
      .eq('parent_post_id', postId)
      .limit(1);

    const hasReplies = childPosts && childPosts.length > 0;

    if (hasReplies) {
      const { error: updateError } = await supabase
        .from('forum_post')
        .update({
          is_deleted: true,
          content: '[Deleted]',
          updated_at: new Date().toISOString()
        })
        .eq('id', postId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (updateError) {
        console.error('[Forum Delete Post] Soft delete error:', updateError);
        return res.status(500).json({ error: 'Failed to delete post' });
      }

      return res.json({ success: true, action: 'soft_deleted' });
    } else {
      const { error: deleteError } = await supabase
        .from('forum_post')
        .delete()
        .eq('id', postId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (deleteError) {
        console.error('[Forum Delete Post] Hard delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete post' });
      }

      if (post.parent_post_id) {
        const { data: siblingCheck } = await supabase
          .from('forum_post')
          .select('id')
          .eq('parent_post_id', post.parent_post_id)
          .limit(1);

        if (!siblingCheck || siblingCheck.length === 0) {
          const { data: parentPost } = await supabase
            .from('forum_post')
            .select('id, is_deleted')
            .eq('id', post.parent_post_id)
            .eq('tenant_id', tenantCtx.tenantId)
            .single();

          if (parentPost?.is_deleted) {
            await supabase
              .from('forum_post')
              .delete()
              .eq('id', parentPost.id)
              .eq('tenant_id', tenantCtx.tenantId);
          }
        }
      }

      return res.json({ success: true, action: 'hard_deleted' });
    }
  } catch (error) {
    console.error('[Forum Delete Post] Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
