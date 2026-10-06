import filtersHandler from './organisation-directory/filters.js';

/**
 * Legacy GET compatibility surface. Use the same authenticated, tenant-scoped
 * authority as the main directory rather than returning raw organisation rows.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let filters;
  try {
    const raw = typeof req.query?.filters === 'string'
      ? JSON.parse(req.query.filters) : (req.query?.filters || {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    filters = Object.fromEntries(Object.entries(raw)
      .filter(([, value]) => value !== '' && value !== 'all' && value != null)
      .map(([key, value]) => [
        key.startsWith('custom:') || key.startsWith('object-field:') || key.startsWith('org_')
          ? key : `custom:${key}`,
        { operator: 'eq', value },
      ]));
  } catch {
    return res.status(400).json({ error: 'Invalid filters' });
  }
  const response = Object.create(res);
  response.status = code => { res.status(code); return response; };
  response.setHeader = (...args) => res.setHeader(...args);
  response.json = payload => res.json(Array.isArray(payload.organizations) ? {
    data: payload.organizations, total: payload.total, page: payload.page,
    limit: payload.pageSize, totalPages: Math.ceil(payload.total / payload.pageSize),
  } : payload);
  return filtersHandler({
    ...req, method: 'POST', query: { ...req.query, settings: undefined },
    body: {
      filters, search: req.query?.search || '', sort: req.query?.sort || 'asc',
      page: Number(req.query?.page || 1), pageSize: Number(req.query?.limit || 100),
    },
  }, response);
}
