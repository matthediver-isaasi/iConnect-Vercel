/**
 * Task #1222: Blog co-authors helper.
 *
 * A blog post's full ordered author list lives in the `blog_post_author` join
 * table. Each row points to EITHER a member (author_id) OR a guest writer
 * (guest_writer_id) and carries a display_order. The post's own
 * author_id / guest_writer_id columns remain the PRIMARY author (display_order 0).
 *
 * - normalizeAuthorEntries: validate + dedupe an incoming author list.
 * - syncBlogPostAuthors: replace a post's author-link rows (tenant-validated).
 * - resolveBlogPostAuthors: return the ordered, resolved author cards for a post.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a raw `authors` payload into a clean ordered list of
 * { type: 'member' | 'guest', id } entries. Drops malformed entries and
 * de-duplicates (first occurrence wins), preserving order.
 */
export function normalizeAuthorEntries(authors) {
  if (!Array.isArray(authors)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of authors) {
    if (!raw || typeof raw !== 'object') continue;
    let type = raw.type;
    let id = raw.id;
    // Accept the column-style shape too ({ author_id } / { guest_writer_id }).
    if (!type) {
      if (raw.author_id) { type = 'member'; id = raw.author_id; }
      else if (raw.guest_writer_id) { type = 'guest'; id = raw.guest_writer_id; }
    }
    if (type !== 'member' && type !== 'guest') continue;
    if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
    const key = `${type}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
  }
  return out;
}

/**
 * Replace the author-link rows for a blog post with the provided ordered list.
 * IDs are validated against the tenant so a caller cannot link a member /
 * guest writer from another tenant.
 *
 * Pass `authors === undefined`/`null` to skip entirely (e.g. auto-save updates
 * that don't touch the author list). An empty array is treated as "no change"
 * to avoid accidentally wiping the list.
 */
export async function syncBlogPostAuthors(supabase, blogPostId, tenantId, authors) {
  if (!supabase || !blogPostId) return;
  const entries = normalizeAuthorEntries(authors);
  if (!entries || entries.length === 0) return;

  const memberIds = entries.filter((e) => e.type === 'member').map((e) => e.id);
  const guestIds = entries.filter((e) => e.type === 'guest').map((e) => e.id);

  // Validate referenced rows belong to the tenant (when tenant is known).
  const validMembers = new Set();
  const validGuests = new Set();

  if (memberIds.length > 0) {
    let q = supabase.from('member').select('id, tenant_id').in('id', memberIds);
    const { data } = await q;
    for (const m of data || []) {
      if (!tenantId || m.tenant_id === tenantId) validMembers.add(m.id);
    }
  }
  if (guestIds.length > 0) {
    let q = supabase.from('guest_writer').select('id, tenant_id').in('id', guestIds);
    const { data } = await q;
    for (const g of data || []) {
      if (!tenantId || g.tenant_id === tenantId) validGuests.add(g.id);
    }
  }

  const rows = [];
  let order = 0;
  for (const e of entries) {
    if (e.type === 'member' && !validMembers.has(e.id)) continue;
    if (e.type === 'guest' && !validGuests.has(e.id)) continue;
    rows.push({
      blog_post_id: blogPostId,
      author_id: e.type === 'member' ? e.id : null,
      guest_writer_id: e.type === 'guest' ? e.id : null,
      display_order: order++,
      tenant_id: tenantId || null,
    });
  }

  if (rows.length === 0) return;

  // Replace existing rows for this post.
  await supabase.from('blog_post_author').delete().eq('blog_post_id', blogPostId);
  const { error } = await supabase.from('blog_post_author').insert(rows);
  if (error) {
    console.error('[blogPostAuthors] Failed to insert author rows:', error.message);
    throw error;
  }
}

/**
 * Resolve the ordered, public-safe author cards for a blog post. Falls back to
 * the post's own author_id / guest_writer_id when the join table has no rows
 * (e.g. a post created before the backfill ran).
 *
 * Each returned author has a normalized shape used by the public article view:
 *   { type, author_id, guest_writer_id, display_order, name, photoUrl,
 *     jobTitle, organization, biography, email, handle, linkedinUrl }
 */
export async function resolveBlogPostAuthors(supabase, post) {
  if (!supabase || !post?.id) return [];

  let { data: links } = await supabase
    .from('blog_post_author')
    .select('id, author_id, guest_writer_id, display_order')
    .eq('blog_post_id', post.id)
    .order('display_order', { ascending: true });

  links = Array.isArray(links) ? links : [];

  // Fallback for un-backfilled posts: synthesize a single link from the post.
  if (links.length === 0) {
    if (post.author_id) {
      links = [{ id: null, author_id: post.author_id, guest_writer_id: null, display_order: 0 }];
    } else if (post.guest_writer_id) {
      links = [{ id: null, author_id: null, guest_writer_id: post.guest_writer_id, display_order: 0 }];
    } else {
      return [];
    }
  }

  const memberIds = [...new Set(links.filter((l) => l.author_id).map((l) => l.author_id))];
  const guestIds = [...new Set(links.filter((l) => l.guest_writer_id).map((l) => l.guest_writer_id))];

  const membersById = new Map();
  const guestsById = new Map();
  const orgsById = new Map();

  if (memberIds.length > 0) {
    const { data: members } = await supabase
      .from('member')
      .select('id, first_name, last_name, handle, profile_image_url, job_title, biography, linkedin_url, email, organization_id')
      .in('id', memberIds);
    for (const m of members || []) membersById.set(m.id, m);

    const orgIds = [...new Set((members || []).map((m) => m.organization_id).filter(Boolean))];
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase.from('organization').select('id, name').in('id', orgIds);
      for (const o of orgs || []) orgsById.set(o.id, o);
    }
  }
  if (guestIds.length > 0) {
    const { data: guests } = await supabase
      .from('guest_writer')
      .select('id, full_name, organization, job_title, biography, profile_photo_url, email')
      .in('id', guestIds);
    for (const g of guests || []) guestsById.set(g.id, g);
  }

  const result = [];
  for (const link of links) {
    if (link.author_id) {
      const m = membersById.get(link.author_id);
      if (!m) continue;
      const org = m.organization_id ? orgsById.get(m.organization_id) : null;
      result.push({
        type: 'member',
        author_id: m.id,
        guest_writer_id: null,
        display_order: link.display_order ?? 0,
        name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        photoUrl: m.profile_image_url || null,
        jobTitle: m.job_title || null,
        organization: org?.name || null,
        biography: m.biography || null,
        email: m.email || null,
        handle: m.handle || m.blog_handle || null,
        linkedinUrl: m.linkedin_url || null,
      });
    } else if (link.guest_writer_id) {
      const g = guestsById.get(link.guest_writer_id);
      if (!g) continue;
      result.push({
        type: 'guest',
        author_id: null,
        guest_writer_id: g.id,
        display_order: link.display_order ?? 0,
        name: g.full_name || '',
        photoUrl: g.profile_photo_url || null,
        jobTitle: g.job_title || null,
        organization: g.organization || null,
        biography: g.biography || null,
        email: g.email || null,
        handle: null,
        linkedinUrl: null,
      });
    }
  }

  return result;
}

/**
 * Batch version of resolveBlogPostAuthors. Given an array of post rows (each at
 * least { id, author_id, guest_writer_id }), returns a Map keyed by post id to
 * its ordered, resolved author cards (same normalized shape as
 * resolveBlogPostAuthors). Avoids the N+1 query pattern when resolving authors
 * for a whole article list.
 */
export async function resolveBlogPostAuthorsForPosts(supabase, posts) {
  const result = new Map();
  if (!supabase || !Array.isArray(posts) || posts.length === 0) return result;

  const postIds = [...new Set(posts.map((p) => p?.id).filter(Boolean))];
  if (postIds.length === 0) return result;

  const { data: linkRows } = await supabase
    .from('blog_post_author')
    .select('blog_post_id, author_id, guest_writer_id, display_order')
    .in('blog_post_id', postIds)
    .order('display_order', { ascending: true });

  // Group links by post id.
  const linksByPost = new Map();
  for (const row of linkRows || []) {
    if (!linksByPost.has(row.blog_post_id)) linksByPost.set(row.blog_post_id, []);
    linksByPost.get(row.blog_post_id).push(row);
  }

  // Fallback for un-backfilled posts: synthesize a single link from the post.
  for (const post of posts) {
    if (!post?.id) continue;
    if (!linksByPost.has(post.id)) {
      if (post.author_id) {
        linksByPost.set(post.id, [{ blog_post_id: post.id, author_id: post.author_id, guest_writer_id: null, display_order: 0 }]);
      } else if (post.guest_writer_id) {
        linksByPost.set(post.id, [{ blog_post_id: post.id, author_id: null, guest_writer_id: post.guest_writer_id, display_order: 0 }]);
      }
    }
  }

  // Collect every referenced member / guest id across all posts.
  const allLinks = [].concat(...linksByPost.values());
  const memberIds = [...new Set(allLinks.filter((l) => l.author_id).map((l) => l.author_id))];
  const guestIds = [...new Set(allLinks.filter((l) => l.guest_writer_id).map((l) => l.guest_writer_id))];

  const membersById = new Map();
  const guestsById = new Map();
  const orgsById = new Map();

  if (memberIds.length > 0) {
    const { data: members } = await supabase
      .from('member')
      .select('id, first_name, last_name, handle, profile_image_url, job_title, biography, linkedin_url, email, organization_id')
      .in('id', memberIds);
    for (const m of members || []) membersById.set(m.id, m);

    const orgIds = [...new Set((members || []).map((m) => m.organization_id).filter(Boolean))];
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase.from('organization').select('id, name').in('id', orgIds);
      for (const o of orgs || []) orgsById.set(o.id, o);
    }
  }
  if (guestIds.length > 0) {
    const { data: guests } = await supabase
      .from('guest_writer')
      .select('id, full_name, organization, job_title, biography, profile_photo_url, email')
      .in('id', guestIds);
    for (const g of guests || []) guestsById.set(g.id, g);
  }

  for (const [postId, links] of linksByPost.entries()) {
    const cards = [];
    for (const link of links) {
      if (link.author_id) {
        const m = membersById.get(link.author_id);
        if (!m) continue;
        const org = m.organization_id ? orgsById.get(m.organization_id) : null;
        cards.push({
          type: 'member',
          author_id: m.id,
          guest_writer_id: null,
          display_order: link.display_order ?? 0,
          name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
          photoUrl: m.profile_image_url || null,
          jobTitle: m.job_title || null,
          organization: org?.name || null,
          biography: m.biography || null,
          email: m.email || null,
          handle: m.handle || m.blog_handle || null,
          linkedinUrl: m.linkedin_url || null,
        });
      } else if (link.guest_writer_id) {
        const g = guestsById.get(link.guest_writer_id);
        if (!g) continue;
        cards.push({
          type: 'guest',
          author_id: null,
          guest_writer_id: g.id,
          display_order: link.display_order ?? 0,
          name: g.full_name || '',
          photoUrl: g.profile_photo_url || null,
          jobTitle: g.job_title || null,
          organization: g.organization || null,
          biography: g.biography || null,
          email: g.email || null,
          handle: null,
          linkedinUrl: null,
        });
      }
    }
    result.set(postId, cards);
  }

  return result;
}
