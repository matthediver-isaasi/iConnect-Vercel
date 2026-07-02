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
    const search = (req.query.search || '').toString().trim();
    let q = supabase
      .from('media_asset')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (search) {
      q = q.or(`name.ilike.%${search}%,alt_text.ilike.%${search}%`);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Failed to load media assets' });
    return res.status(200).json({ assets: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.url || typeof body.url !== 'string') return res.status(400).json({ error: 'url required' });
    const name = body.name || body.url.split('/').pop() || 'Asset';
    const { data, error } = await supabase
      .from('media_asset')
      .insert({
        tenant_id: tenantId,
        url: body.url,
        name: String(name).slice(0, 255),
        kind: body.kind || 'image',
        mime_type: body.mime_type || null,
        byte_size: body.byte_size || null,
        alt_text: body.alt_text || null,
        width: body.width || null,
        height: body.height || null,
        uploaded_by: context.memberId || null,
      })
      .select()
      .single();
    if (error) {
      console.error('[MediaLibrary] POST error:', error);
      return res.status(500).json({ error: 'Failed to register asset' });
    }
    return res.status(201).json({ asset: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
