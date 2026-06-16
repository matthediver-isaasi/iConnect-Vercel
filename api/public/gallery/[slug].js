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
        login_redirect_url: `https://${tenantDomain}/login?returnTo=${encodeURIComponent(
          `/gallery/${gallery.slug}`
        )}`,
      });
    }

    const { data: photos, error: pErr } = await supabase
      .from('gallery_photo')
      .select(PUBLIC_PHOTO_COLUMNS)
      .eq('gallery_id', gallery.id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (pErr) {
      console.error('[Public Gallery API] Photos query error:', pErr);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    return res.json({
      ...base,
      is_locked: false,
      photos: photos || [],
    });
  } catch (err) {
    console.error('[Public Gallery API] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch gallery' });
  }
}
