import { randomUUID } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { loadGroupDefinitions, groupCustomFieldsAvailable } from '../_lib/memberGroupCustomFields.js';
import { validateGroupDefinitions } from '../../shared/memberGroupCustomFields.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  const db = deps.supabase || supabase;
  try {
    const ctx = await (deps.getTenantContext || getTenantContext)(req);
    if (!ctx.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Authentication required' });
    if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant changed. Reload this page.' });
    if (!(await (deps.hasAdminAccess || hasAdminAccess)(ctx))) return res.status(403).json({ error: 'Tenant administrator access required' });
    if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!(await groupCustomFieldsAvailable(db, ctx.tenantId))) {
      if (req.method === 'GET') return res.json({ fields: [], revision: 0, available: false });
      return res.status(503).json({ error: 'Custom fields require the database migration before definitions can be saved.' });
    }
    const current = await loadGroupDefinitions(db, ctx.tenantId);
    if (req.method === 'GET') return res.json(current);
    const { fields, revision, confirmedDeletedIds = [] } = req.body || {};
    if (!Array.isArray(fields) || fields.length > 50 || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(confirmedDeletedIds)) return res.status(400).json({ error: 'Invalid definition save.' });
    if (current.revision !== revision) return res.status(409).json({ error: 'Fields changed. Reload before saving.' });
    const existing = new Set(current.fields.map(f => f.id));
    if (fields.some(f => !f || (f.id && !existing.has(f.id)))) return res.status(400).json({ error: 'Unknown field ID. New fields must omit their ID.' });
    const next = validateGroupDefinitions(fields.map(f => ({ ...f, id: f.id || randomUUID() })));
    const removed = current.fields.filter(f => !next.some(n => n.id === f.id));
    if (removed.some(f => !confirmedDeletedIds.includes(f.id))) return res.status(400).json({ error: 'Confirm removal of each deleted field.' });
    // Never reinterpret saved values under a different type or choice vocabulary.
    for (const f of next) {
      const old = current.fields.find(o => o.id === f.id);
      if (old && (old.type !== f.type || old.choices.some(c => !f.choices.includes(c)))) {
        return res.status(400).json({ error: 'Existing field types and choices cannot be removed. Create a new field instead.' });
      }
    }
    const result = await db.rpc('save_member_group_custom_fields', { p_tenant: ctx.tenantId, p_fields: next, p_revision: revision });
    if (result.error) return res.status(result.error.code === '40001' ? 409 : 500).json({ error: result.error.code === '40001' ? 'Fields changed. Reload before saving.' : 'Unable to save custom fields.' });
    return res.json({ fields: next, revision: revision + 1 });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to load or save custom fields.' });
  }
}
