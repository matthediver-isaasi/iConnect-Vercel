import { supabase, databaseUrl } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

async function ensureIsDeletedColumn() {
  if (!databaseUrl) return;
  try {
    const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forum_post' AND column_name = 'is_deleted') THEN
          ALTER TABLE forum_post ADD COLUMN is_deleted BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);
    await client.end();
    console.log('[Forum Delete Post] Ensured is_deleted column exists');
    if (supabase) {
      try {
        await supabase.rpc('exec_sql', { sql_text: "NOTIFY pgrst, 'reload schema';" });
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Forum Delete Post] Migration error:', err.message);
  }
}

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
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', tenantCtx.roleId)
        .single();
      const roleExcluded = role?.excluded_features || [];

      let memberExcluded = [];
      if (tenantCtx.memberId) {
        const { data: member } = await supabase
          .from('member')
          .select('member_excluded_features')
          .eq('id', tenantCtx.memberId)
          .single();
        memberExcluded = member?.member_excluded_features || [];
      }

      const excluded = [...roleExcluded, ...memberExcluded];
      console.log('[Forum Delete Post] Exclusions:', {
        roleId: tenantCtx.roleId,
        roleExcluded,
        memberExcluded,
        error: roleError?.message
      });
      const isExcluded = (featureKey) => {
        if (excluded.includes(featureKey)) return true;
        const parts = featureKey.split('.');
        if (parts.length >= 2) {
          const pageId = parts.slice(0, 2).join('.');
          if (excluded.includes(pageId)) return true;
        }
        if (parts.length >= 1) {
          const moduleId = parts[0];
          if (excluded.includes(moduleId)) return true;
        }
        return false;
      };
      if (!isExcluded('forum.threads.delete-any')) canDeleteAny = true;
      if (!isExcluded('forum.threads.delete-own')) canDeleteOwn = true;
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
      let { error: updateError } = await supabase
        .from('forum_post')
        .update({
          is_deleted: true,
          content: '[Deleted]',
          updated_at: new Date().toISOString()
        })
        .eq('id', postId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (updateError && updateError.code === 'PGRST204') {
        console.log('[Forum Delete Post] is_deleted column missing, running migration...');
        await ensureIsDeletedColumn();
        const retry = await supabase
          .from('forum_post')
          .update({
            is_deleted: true,
            content: '[Deleted]',
            updated_at: new Date().toISOString()
          })
          .eq('id', postId)
          .eq('tenant_id', tenantCtx.tenantId);
        updateError = retry.error;
      }

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
            .select('id, content')
            .eq('id', post.parent_post_id)
            .eq('tenant_id', tenantCtx.tenantId)
            .single();

          if (parentPost?.is_deleted || parentPost?.content === '[Deleted]') {
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
