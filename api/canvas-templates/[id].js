import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  const tenantId = context.tenantId;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('canvas_template')
      .select('*')
      .eq('id', id)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Failed to load template' });
    if (!data) return res.status(404).json({ error: 'Template not found' });
    return res.status(200).json({ template: data });
  }

  if (req.method === 'DELETE') {
    // Only tenant-owned templates may be deleted; global starters are read-only.
    const { error } = await supabase
      .from('canvas_template')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) return res.status(500).json({ error: 'Failed to delete template' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
