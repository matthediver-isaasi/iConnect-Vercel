import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
  const actor = ctx.memberId || ctx.tenantUserId;
  if (!actor) return res.status(403).json({ error: 'Administrator identity required' });
  const input = req.method === 'GET' ? { ...req.query, operation: 'history' } : req.body || {};
  if (!['history', 'preview', 'execute'].includes(input.operation)) return res.status(400).json({ error: 'Invalid lifecycle operation' });
  if (input.operation === 'execute' && input.acknowledged !== true) {
    return res.status(400).json({ error: 'Please acknowledge the impact before continuing' });
  }
  const { data, error } = await supabase.rpc('manage_survey_lifecycle', {
    p_tenant: ctx.tenantId, p_actor: String(actor), p_form: input.form_id,
    p_operation: input.operation, p_action: input.action || null,
    p_assignment: input.assignment_id || null, p_token: input.confirmation_token || null,
    p_acknowledged: input.acknowledged === true, p_delete_confirmation: input.delete_confirmation || null,
    p_changes: input.changes || {},
  });
  if (error) {
    const known = ['P0001', '23503', '23505', '40001'].includes(error.code);
    return res.status(known ? 409 : 503).json({
      error: known ? 'The survey or its dependencies changed. Review the impact again before continuing.' : 'Survey lifecycle management is unavailable. No change has been confirmed.',
    });
  }
  return res.status(200).json(data);
}
