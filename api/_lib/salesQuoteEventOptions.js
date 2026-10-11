import { SalesHttpError } from './salesAccess.js';

// Separate from catalogue ticket discovery: quotes may reference events without tickets.
export async function listQuoteEventOptions(db, tenantId, options = {}, now = new Date()) {
  const page = Math.max(1, Math.min(10000, Number.parseInt(options.page, 10) || 1));
  const size = 25;
  const term = String(options.search || options.q || '').trim().slice(0, 150);
  const selected = options.selectedId;
  if (selected && (!/^[0-9a-f-]{36}$/i.test(selected) || !['simple', 'complex'].includes(options.kind))) {
    throw new SalesHttpError(400, 'Invalid selected event');
  }
  const kinds = selected ? [options.kind] : ['simple', 'complex'];
  const results = await Promise.all(kinds.map(async (kind) => {
    let query = db.from(kind === 'simple' ? 'event' : 'complex_event')
      .select('id,title,start_date,end_date').eq('tenant_id', tenantId);
    if (selected) query = query.eq('id', selected);
    else {
      // Literal, case-insensitive search. Escaped regex also handles literal *.
      if (term) query = query.filter('title', 'imatch', term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (options.excludePast === 'true') {
        const boundary = now.toISOString();
        query = query.or(`end_date.gte.${boundary},and(end_date.is.null,start_date.gte.${boundary}),and(end_date.is.null,start_date.is.null)`);
      }
    }
    const { data, error } = await query.order('title', { ascending: true }).order('id', { ascending: true })
      .range(selected ? 0 : (page - 1) * size, selected ? 0 : page * size);
    if (error) throw error;
    return { more: (data || []).length > size, items: (data || []).slice(0, size).map(row => ({
      id: row.id, name: row.title, kind, startDate: row.start_date, endDate: row.end_date,
    })) };
  }));
  return { items: results.flatMap(result => result.items).sort((a, b) => String(a.name).localeCompare(String(b.name))), hasMore: results.some(result => result.more), page };
}
