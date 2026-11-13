export async function readAudienceListPage(db, tenantId, params = {}) {
  const page = Number(params.page ?? 1);
  const pageSize = Number(params.pageSize ?? 10);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      ![10, 25, 50].includes(pageSize) || typeof (params.search ?? '') !== 'string') {
    throw Object.assign(new Error('Invalid list pagination parameters.'), { status: 400 });
  }
  const search = (params.search || '').trim();
  if (search.length > 200) throw Object.assign(new Error('Search is too long.'), { status: 400 });
  let query = db.from('audience_list').select('*', { count: 'exact' }).eq('tenant_id', tenantId);
  // Regex literal matching avoids treating %, _ or * in list names as wildcards.
  if (search) query = query.filter('name', 'imatch', search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const { data, count, error } = await query.order('name').order('id')
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  return { lists: data || [], total: count || 0, page, pageSize };
}
