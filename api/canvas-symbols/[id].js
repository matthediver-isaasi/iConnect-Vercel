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
      .from('canvas_symbol')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Failed to load symbol' });
    if (!data) return res.status(404).json({ error: 'Symbol not found' });
    return res.status(200).json({ symbol: data });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = req.body || {};
    const patch = {};
    if (body.name != null) patch.name = String(body.name).slice(0, 200);
    if (body.description !== undefined) patch.description = body.description || null;
    if (body.design !== undefined) {
      if (!body.design || typeof body.design !== 'object') {
        return res.status(400).json({ error: 'design must be object' });
      }
      patch.design = body.design;
    }
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('canvas_symbol')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Failed to update symbol' });
    return res.status(200).json({ symbol: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase
      .from('canvas_symbol')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) return res.status(500).json({ error: 'Failed to delete symbol' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
