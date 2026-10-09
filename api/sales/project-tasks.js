import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { salesProjectRequest } from '../_lib/salesProjects.js';

export function createSalesProjectTasksHandler(dependencies = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const db = dependencies.db || supabase;
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      const context = await (dependencies.getTenantContext || getTenantContext)(req);
      if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context.tenantId) return res.status(400).json({ error: 'Tenant context required' });
      const query = { ...req.query, ...Object.fromEntries(new URL(req.url || '/', 'http://request.local').searchParams) };
      const data = await salesProjectRequest(db, context, req.method, query, req.body || {}, dependencies);
      return res.status(200).json(data);
    } catch (error) {
      const status = error.status || ({ '40001': 409, '23505': 409, '23503': 409,
        '23514': 400, '22023': 400, '42501': 403 }[error.code]) || 500;
      const message = error.code === '23505' ? 'This opportunity or board already has a link. Refresh before trying again.'
        : error.code === '23503' ? 'The opportunity or board is no longer available in this tenant.'
          : status === 500 ? 'Unable to load or update Sales project tasks' : error.message;
      return res.status(status).json({ error: message });
    }
  };
}
export default createSalesProjectTasksHandler();
