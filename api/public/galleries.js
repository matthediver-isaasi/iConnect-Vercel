import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: galleries, error: gErr } = await supabase
      .from('gallery')
      .select('id, title, description, is_public, cover_photo_id, display_order, created_at, updated_at')
      .eq('tenant_id', tenant.id)
      .eq('is_public', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (gErr) {
      console.error('[Public Galleries] Query error:', gErr);
      return res.status(500).json({ error: 'Failed to fetch galleries' });
    }

    if (!galleries || galleries.length === 0) {
      return res.json([]);
    }

    const galleryIds = galleries.map((g) => g.id);
    const { data: photos, error: pErr } = await supabase
      .from('gallery_photo')
      .select('id, gallery_id, file_url, storage_path, bucket, caption, alt_text, display_order, created_at')
      .in('gallery_id', galleryIds)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (pErr) {
      console.error('[Public Galleries] Photos query error:', pErr);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    const photosByGallery = new Map();
    for (const p of photos || []) {
      if (!photosByGallery.has(p.gallery_id)) photosByGallery.set(p.gallery_id, []);
      photosByGallery.get(p.gallery_id).push(p);
    }

    const result = galleries.map((g) => ({
      ...g,
      photos: photosByGallery.get(g.id) || [],
    }));

    res.json(result);
  } catch (error) {
    console.error('[Public Galleries] Error:', error);
    res.status(500).json({ error: 'Failed to fetch galleries' });
  }
}
