import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';

// Parse a Supabase public/sign storage URL back into { bucket, path }.
// Returns null if the URL doesn't match either pattern (e.g. external CDN).
function parseSupabaseStorageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/);
  if (!m) return null;
  try {
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return { bucket: m[1], path: m[2] };
  }
}

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

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = body.name == null ? null : String(body.name).slice(0, 255);
    if (body.alt_text !== undefined) patch.alt_text = body.alt_text || null;
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('media_asset')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Failed to update asset' });
    return res.status(200).json({ asset: data });
  }

  if (req.method === 'DELETE') {
    const { data: asset } = await supabase
      .from('media_asset')
      .select('url, byte_size')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const { error } = await supabase
      .from('media_asset')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) return res.status(500).json({ error: 'Failed to delete asset' });

    // Best-effort: remove the underlying storage object and decrement the
    // tenant storage counter. Failures are logged and swallowed — the nightly
    // recompute script re-baselines any drift.
    if (asset) {
      const loc = parseSupabaseStorageUrl(asset.url);
      if (loc) {
        try {
          const { error: rmErr } = await supabase.storage.from(loc.bucket).remove([loc.path]);
          if (rmErr) console.warn('[MediaLibrary Delete] Storage remove failed:', rmErr.message || rmErr);
        } catch (e) {
          console.warn('[MediaLibrary Delete] Storage remove threw:', e?.message || e);
        }
      }
      const size = Number(asset.byte_size);
      if (Number.isFinite(size) && size > 0) {
        addTenantStorageBytes(tenantId, -size).catch(() => {});
      }
    }

    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'PATCH, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
