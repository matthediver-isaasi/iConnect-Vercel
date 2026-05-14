import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  const tenantId = context.tenantId;

  if (req.method === 'GET') {
    const includeDesign = req.query.full === '1';
    const cols = includeDesign
      ? 'id, name, description, design, created_at, updated_at'
      : 'id, name, description, created_at, updated_at';
    const { data, error } = await supabase
      .from('canvas_symbol')
      .select(cols)
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load symbols' });
    return res.status(200).json({ symbols: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'name required' });
    if (!body.design || typeof body.design !== 'object') return res.status(400).json({ error: 'design required' });
    const { data, error } = await supabase
      .from('canvas_symbol')
      .insert({
        tenant_id: tenantId,
        name: String(body.name).slice(0, 200),
        description: body.description || null,
        design: body.design,
        created_by: context.memberId || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Failed to create symbol' });
    return res.status(201).json({ symbol: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
