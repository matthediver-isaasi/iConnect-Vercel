import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

const PUBLIC_GALLERY_COLUMNS =
  'id, title, description, slug, is_public, cover_photo_id, display_order, tenant_id';
const PUBLIC_PHOTO_COLUMNS =
  'id, gallery_id, file_url, storage_path, bucket, caption, alt_text, display_order, created_at';

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

  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Gallery handle is required' });
  }

  // Pagination: page (1-based, default 1) and limit (default 24, capped at 100).
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      console.error('[Public Gallery API] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: gallery, error } = await supabase
      .from('gallery')
      .select(PUBLIC_GALLERY_COLUMNS)
      .eq('tenant_id', tenant.id)
      .eq('slug', slug)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Gallery not found' });
      }
      console.error('[Public Gallery API] Query error:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!gallery) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const base = {
      id: gallery.id,
      title: gallery.title,
      description: gallery.description,
      slug: gallery.slug,
      is_public: gallery.is_public,
      cover_photo_id: gallery.cover_photo_id,
    };

    // Private gallery: don't return photos to anonymous viewers. The client
    // sends them to login and back via the authenticated path.
    if (!gallery.is_public) {
      const tenantDomain = tenant.domain || `${tenant.slug}.iconn.app`;
      return res.json({
        ...base,
        is_locked: true,
        photos: [],
        total_photos: 0,
        login_redirect_url: `https://${tenantDomain}/login?returnTo=${encodeURIComponent(
          `/gallery/${gallery.slug}`
        )}`,
      });
    }

    const { data: photos, error: pErr, count } = await supabase
      .from('gallery_photo')
      .select(PUBLIC_PHOTO_COLUMNS, { count: 'exact' })
      .eq('gallery_id', gallery.id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .range(from, to);

    if (pErr) {
      console.error('[Public Gallery API] Photos query error:', pErr);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    return res.json({
      ...base,
      is_locked: false,
      photos: photos || [],
      total_photos: count ?? 0,
    });
  } catch (err) {
    console.error('[Public Gallery API] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch gallery' });
  }
}
