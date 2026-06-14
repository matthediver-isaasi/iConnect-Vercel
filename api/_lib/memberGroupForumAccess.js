import { supabase } from './database.js';

/**
 * Group Forum side-effects (Task #1421).
 *
 * Member groups can be flagged forum_enabled. When enabled, exactly one
 * forum_category is linked to the group via its group_id column; when disabled,
 * the linked category is deactivated (is_active = false) rather than deleted so
 * existing threads/posts are preserved. Member visibility is handled entirely by
 * the existing Forum.jsx group filtering (category.group_id ∈ caller's group ids)
 * plus the tenant-scoped entity API — there is no per-board membership table to
 * reconcile like Group Projects, so this helper only manages the category row.
 *
 * Best-effort: logs errors but never throws — provisioning is a background concern.
 */

function generateSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Ensure a forum_category slug is unique for the tenant by appending a numeric
 * suffix when needed. Excludes the category currently being (re)provisioned.
 */
async function ensureUniqueSlug(tenantId, baseSlug, excludeCategoryId) {
  const root = baseSlug || 'group-forum';
  let candidate = root;
  let suffix = 1;
  // Bounded loop guards against pathological collisions.
  while (suffix < 100) {
    let query = supabase
      .from('forum_category')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('slug', candidate);
    if (excludeCategoryId) query = query.neq('id', excludeCategoryId);
    const { data, error } = await query.limit(1);
    if (error) {
      console.error('[memberGroupForumAccess] slug uniqueness check failed:', error.message);
      // Fall back to a time-suffixed slug to avoid a hard unique-violation.
      return `${root}-${Date.now()}`;
    }
    if (!data || data.length === 0) return candidate;
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  return `${root}-${Date.now()}`;
}

/**
 * Reconcile the forum_category linked to a member group with its current
 * forum_enabled state.
 *
 * - forum enabled  -> ensure exactly one linked category exists and is active
 *                     (create if none; reactivate the most recent if hidden).
 * - forum disabled -> deactivate every linked category (is_active = false).
 *
 * Never hard-deletes; threads/posts under a deactivated category are preserved.
 */
export async function syncGroupForumCategory(groupId) {
  if (!supabase || !groupId) return { ok: false, reason: 'no_supabase_or_group' };

  try {
    const { data: group, error: groupErr } = await supabase
      .from('member_group')
      .select('id, name, is_active, forum_enabled, tenant_id')
      .eq('id', groupId)
      .maybeSingle();
    if (groupErr || !group) {
      return { ok: false, reason: 'group_not_found' };
    }

    const tenantId = group.tenant_id;
    if (!tenantId) return { ok: false, reason: 'no_tenant' };

    const shouldBeActive = group.is_active !== false && group.forum_enabled === true;

    const { data: linked, error: linkedErr } = await supabase
      .from('forum_category')
      .select('id, is_active, created_at')
      .eq('tenant_id', tenantId)
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (linkedErr) {
      console.error('[syncGroupForumCategory] linked category lookup failed:', linkedErr.message);
      return { ok: false, reason: 'lookup_failed' };
    }

    const existing = linked || [];

    if (!shouldBeActive) {
      // Disable: deactivate any active linked categories. Preserve threads/posts.
      const active = existing.filter((c) => c.is_active !== false);
      if (active.length > 0) {
        const { error: deactErr } = await supabase
          .from('forum_category')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId)
          .eq('group_id', groupId)
          .eq('is_active', true);
        if (deactErr) {
          console.error('[syncGroupForumCategory] deactivate failed:', deactErr.message);
          return { ok: false, reason: 'deactivate_failed' };
        }
      }
      return { ok: true, action: 'deactivated', deactivated: active.length };
    }

    // Enabled: ensure exactly one active linked category exists.
    if (existing.length > 0) {
      const keep = existing[0];
      if (keep.is_active !== true) {
        const { error: reactErr } = await supabase
          .from('forum_category')
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq('id', keep.id);
        if (reactErr) {
          console.error('[syncGroupForumCategory] reactivate failed:', reactErr.message);
          return { ok: false, reason: 'reactivate_failed' };
        }
      }
      return { ok: true, action: 'reactivated', categoryId: keep.id };
    }

    // None exists -> create one linked to the group.
    const baseSlug = generateSlug(group.name) || 'group-forum';
    const slug = await ensureUniqueSlug(tenantId, baseSlug, null);

    // Place the new category after existing ones for a stable display order.
    const { count } = await supabase
      .from('forum_category')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { data: created, error: createErr } = await supabase
      .from('forum_category')
      .insert({
        tenant_id: tenantId,
        name: group.name || 'Group Forum',
        description: `Private discussion forum for the ${group.name || 'group'}.`,
        slug,
        display_order: typeof count === 'number' ? count : 0,
        group_id: groupId,
        is_active: true,
      })
      .select('id')
      .single();
    if (createErr) {
      console.error('[syncGroupForumCategory] create failed:', createErr.message);
      return { ok: false, reason: 'create_failed' };
    }

    return { ok: true, action: 'created', categoryId: created?.id };
  } catch (err) {
    console.error('[syncGroupForumCategory] unexpected error:', err.message || err);
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Hook invoked after a member-group create/update/delete. Dispatches to
 * syncGroupForumCategory for the affected group. Mirrors
 * handleMemberGroupEntityChange (projects) but only for the 'membergroup'
 * entity — assignment changes do not affect forum category visibility, which is
 * resolved live from the caller's group ids in Forum.jsx.
 *
 * Best-effort.
 */
/**
 * Build the set of group ids whose forum the given member may access, keyed for
 * O(1) lookup. A group is accessible when the member is assigned to it AND
 * either the group sets no forum_enabled_roles (all members) or the member holds
 * one of those roles. Returns a predicate `(groupId) => boolean`.
 */
async function buildGroupForumAccess(memberId) {
  const myGroups = new Map(); // group_id -> Set(roles)
  if (memberId) {
    const { data: assigns } = await supabase
      .from('member_group_assignment')
      .select('group_id, group_role, expires_at')
      .eq('member_id', memberId);
    const nowIso = new Date().toISOString();
    (assigns || [])
      // Exclude expired assignments (null expires_at = never expires), matching
      // memberGroupProjectsAccess / memberGroupEventsAccess.
      .filter((a) => a.group_id && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso))
      .forEach((a) => {
        if (!myGroups.has(a.group_id)) myGroups.set(a.group_id, new Set());
        if (a.group_role) myGroups.get(a.group_id).add(a.group_role);
      });
  }

  const groupIds = [...myGroups.keys()];
  const forumRoles = new Map(); // group_id -> forum_enabled_roles[]
  if (groupIds.length) {
    const { data: groups } = await supabase
      .from('member_group')
      .select('id, forum_enabled_roles')
      .in('id', groupIds);
    (groups || []).forEach((g) => {
      forumRoles.set(g.id, Array.isArray(g.forum_enabled_roles) ? g.forum_enabled_roles : []);
    });
  }

  return (groupId) => {
    if (!groupId) return true; // tenant-wide (non-group) category
    if (!myGroups.has(groupId)) return false;
    const allowed = forumRoles.get(groupId) || [];
    if (allowed.length === 0) return true;
    const mine = myGroups.get(groupId) || new Set();
    return allowed.some((r) => mine.has(r));
  };
}

/**
 * Server-side authorization filter for forum reads (Task #1421).
 *
 * Group-linked forum categories (forum_category.group_id IS NOT NULL) are private
 * to that group's members. The generic entity API otherwise returns all
 * tenant-scoped rows, so without this a non-member could read a group's
 * categories / threads / posts directly via the API (bypassing the Forum.jsx UI
 * filter). This trims the already-fetched rows to those the caller may see.
 *
 * Privileged callers (tenant admins, or members with the `forum.management`
 * feature) are exempt so the admin ForumManagement surface keeps full access.
 *
 * Handles `forumcategory`, `forumthread`, and `forumpost`. Non-forum entities
 * and empty result sets pass through untouched.
 */
export async function filterForumReadRows({ entityNorm, rows, memberId, isPrivileged }) {
  if (!supabase) return rows;
  if (entityNorm !== 'forumcategory' && entityNorm !== 'forumthread' && entityNorm !== 'forumpost') {
    return rows;
  }
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (isPrivileged) return rows;

  try {
    const canAccessGroup = await buildGroupForumAccess(memberId);

    if (entityNorm === 'forumcategory') {
      return rows.filter((r) => {
        if (!r.group_id) return true;
        if (r.is_active === false) return false;
        return canAccessGroup(r.group_id);
      });
    }

    // forumthread / forumpost need their owning category's group_id + is_active.
    let categoryByThread = null; // for posts: thread_id -> category_id
    let categoryIds = [];

    if (entityNorm === 'forumthread') {
      categoryIds = [...new Set(rows.map((r) => r.category_id).filter(Boolean))];
    } else {
      // forumpost -> resolve thread_id -> category_id first.
      const threadIds = [...new Set(rows.map((r) => r.thread_id).filter(Boolean))];
      categoryByThread = new Map();
      if (threadIds.length) {
        const { data: threads, error: threadErr } = await supabase
          .from('forum_thread')
          .select('id, category_id')
          .in('id', threadIds);
        // Fail closed: if we cannot resolve a post's owning thread/category we
        // cannot prove it is not group-private, so deny rather than leak.
        if (threadErr) throw new Error(`forum_thread resolution failed: ${threadErr.message}`);
        (threads || []).forEach((t) => categoryByThread.set(t.id, t.category_id || null));
        categoryIds = [...new Set([...categoryByThread.values()].filter(Boolean))];
      }
    }

    const catInfo = new Map(); // category_id -> { group_id, is_active }
    if (categoryIds.length) {
      const { data: cats, error: catErr } = await supabase
        .from('forum_category')
        .select('id, group_id, is_active')
        .in('id', categoryIds);
      if (catErr) throw new Error(`forum_category resolution failed: ${catErr.message}`);
      (cats || []).forEach((c) => catInfo.set(c.id, { group_id: c.group_id || null, is_active: c.is_active }));
    }

    const categoryAccessible = (categoryId) => {
      if (!categoryId) return true;
      const info = catInfo.get(categoryId);
      // A referenced category we could not resolve is treated as private (deny):
      // every thread/post references a real category, so a miss means an orphan
      // or a failed lookup — fail closed.
      if (!info) return false;
      if (!info.group_id) return true; // tenant-wide category
      if (info.is_active === false) return false;
      return canAccessGroup(info.group_id);
    };

    if (entityNorm === 'forumthread') {
      return rows.filter((r) => categoryAccessible(r.category_id));
    }
    // forumpost
    return rows.filter((r) => {
      const catId = r.thread_id ? categoryByThread.get(r.thread_id) : null;
      return categoryAccessible(catId);
    });
  } catch (err) {
    console.error('[filterForumReadRows] unexpected error:', err.message || err);
    // Fail closed for group privacy. For categories we can still keep the rows we
    // can prove are tenant-wide (group_id null). For threads/posts we cannot
    // resolve the owning category on error, so deny the whole set rather than
    // risk leaking group-private content.
    if (entityNorm === 'forumcategory') {
      return rows.filter((r) => !r.group_id);
    }
    return [];
  }
}

export async function handleMemberGroupForumChange({ entityNorm, data, beforeData }) {
  if (!supabase) return;
  try {
    if (entityNorm !== 'membergroup') return;
    const groupId = data?.id || beforeData?.id;
    if (!groupId) return;
    await syncGroupForumCategory(groupId);
  } catch (err) {
    console.error('[handleMemberGroupForumChange] unexpected error:', err.message || err);
  }
}
