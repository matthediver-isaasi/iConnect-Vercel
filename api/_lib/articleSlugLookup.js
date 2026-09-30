// Shared tolerant article-by-slug lookup for server surfaces (public article
// API, prerender, entity meta). Used when the author segment of an article
// URL is unknown, stale, or a placeholder ('member'): resolve the published
// article by slug alone, tenant-scoped.
//
// Deterministic precedence: an exact slug match always wins; only when none
// exists do we try the legacy "-by-{handle}" suffix. (A combined
// .or(...).single() errors when a clean slug and a distinct legacy slug share
// the same prefix.)
export async function findPublishedArticleBySlug(supabase, tenantId, slug, select) {
  if (!supabase || !tenantId || !slug) return null;

  const { data: exactRows } = await supabase
    .from('blog_post')
    .select(select)
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .eq('slug', slug)
    .limit(1);
  if (exactRows && exactRows.length > 0) return exactRows[0];

  const { data: legacyRows } = await supabase
    .from('blog_post')
    .select(select)
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .like('slug', `${slug}-by-%`)
    .order('slug')
    .limit(1);
  return legacyRows?.[0] || null;
}
