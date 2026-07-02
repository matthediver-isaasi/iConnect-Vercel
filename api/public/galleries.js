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
    // Fetch every photo across all public galleries. PostgREST caps a single
    // response at ~1000 rows, so on tenants with many public gallery photos a
    // plain `.in(...)` would silently drop rows — leaving galleries near the
    // end of the list with an incomplete `photos` array (and thus a Lightbox
    // missing photos). Page through in batches to stay cap-safe.
    const PHOTO_PAGE_SIZE = 1000;
    const photos = [];
    let pErr = null;
    for (let offset = 0; ; offset += PHOTO_PAGE_SIZE) {
      const { data: batch, error } = await supabase
        .from('gallery_photo')
        .select('id, gallery_id, file_url, storage_path, bucket, caption, alt_text, display_order, created_at')
        .in('gallery_id', galleryIds)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
        .range(offset, offset + PHOTO_PAGE_SIZE - 1);
      if (error) {
        pErr = error;
        break;
      }
      if (batch && batch.length > 0) {
        photos.push(...batch);
      }
      if (!batch || batch.length < PHOTO_PAGE_SIZE) {
        break;
      }
    }

    if (pErr) {
      console.error('[Public Galleries] Photos query error:', pErr);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    const photosByGallery = new Map();
    for (const p of photos || []) {
      if (!photosByGallery.has(p.gallery_id)) photosByGallery.set(p.gallery_id, []);
      photosByGallery.get(p.gallery_id).push(p);
    }

    // Resolve a cover photo per gallery so the public list can render a
    // thumbnail reliably. The bulk photo fetch above is subject to PostgREST's
    // default row cap, so a gallery near the end of a large tenant's list can
    // come back with no photos — which would drop its cover. Fetch the
    // explicitly-set cover photos directly by id (cap-safe) and only fall back
    // to the first photo from the batch when no cover is set.
    const coverPhotoIds = Array.from(
      new Set(galleries.map((g) => g.cover_photo_id).filter(Boolean))
    );
    const coverById = new Map();
    if (coverPhotoIds.length > 0) {
      const { data: coverRows, error: cErr } = await supabase
        .from('gallery_photo')
        .select('id, gallery_id, file_url, storage_path, bucket, caption, alt_text, display_order, created_at')
        .in('id', coverPhotoIds);
      if (cErr) {
        console.error('[Public Galleries] Cover photos query error:', cErr);
      } else {
        for (const p of coverRows || []) coverById.set(p.id, p);
      }
    }

    const result = galleries.map((g) => {
      const galleryPhotos = photosByGallery.get(g.id) || [];
      // Guard against a cover_photo_id that points at another gallery's photo.
      const explicitCover =
        g.cover_photo_id && coverById.get(g.cover_photo_id)?.gallery_id === g.id
          ? coverById.get(g.cover_photo_id)
          : null;
      const cover_photo = explicitCover || galleryPhotos[0] || null;
      return {
        ...g,
        photos: galleryPhotos,
        cover_photo,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('[Public Galleries] Error:', error);
    res.status(500).json({ error: 'Failed to fetch galleries' });
  }
}
