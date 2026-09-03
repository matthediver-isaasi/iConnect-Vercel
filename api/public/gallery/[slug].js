import { supabase } from '../../_lib/database.js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { evaluateGalleryAccessPolicy } from '../../_lib/galleryAccessPolicy.js';

const PUBLIC_GALLERY_COLUMNS =
  'id, title, description, slug, is_public, cover_photo_id, display_order, tenant_id, access_policy';
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

    // A public slug is public. A members-only slug is evaluated against the
    // current session before *any* gallery metadata/photos are returned.
    const tenantContext = await getTenantContext(req);
    if (tenantContext.tenantMismatch) return res.status(404).json({ error: 'Gallery not found' });
    const isManager = !!tenantContext.tenantUserId
      || (tenantContext.roleId && await hasFeatureAccess(tenantContext.roleId, 'content.gallery.manage'));
    if (!gallery.is_public) {
      if (!tenantContext.isAuthenticated) {
        const tenantDomain = tenant.domain || `${tenant.slug}.iconn.app`;
        return res.json({
          is_locked: true,
          photos: [],
          total_photos: 0,
          login_redirect_url: `https://${tenantDomain}/login?returnTo=${encodeURIComponent(`/gallery/${encodeURIComponent(String(slug))}`)}`,
        });
      }
      const access = await evaluateGalleryAccessPolicy({
        supabase, tenantId: tenant.id, memberId: tenantContext.memberId,
        roleId: tenantContext.roleId, policy: gallery.access_policy, isManager,
      });
      // Deliberately indistinguishable from a missing slug to avoid private
      // title/description/cover metadata discovery by authenticated members.
      if (!access.allowed) return res.status(404).json({ error: 'Gallery not found' });
    }

    const base = {
      id: gallery.id,
      title: gallery.title,
      description: gallery.description,
      slug: gallery.slug,
      is_public: gallery.is_public,
      cover_photo_id: gallery.cover_photo_id,
    };

    const { data: photos, error: pErr, count } = await supabase
      .from('gallery_photo')
      .select(PUBLIC_PHOTO_COLUMNS, { count: 'exact' })
      .eq('gallery_id', gallery.id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .range(from, to);

    if (pErr) {
      console.error('[Public Gallery API] Photos query error:', pErr);
      return res.status(500).json({ error: 'Failed to fetch photos' });
    }

    // Resolve the gallery's cover photo so a consumer (e.g. the CanvasBuilder
    // "cover image only" display mode) can render it without loading the page
    // that hosts the gallery. Prefer the explicitly-set cover_photo_id; fall
    // back to the first photo by display order. Only resolved for public
    // galleries — private ones already returned above without any photos.
    let cover_photo = null;
    if (gallery.cover_photo_id) {
      cover_photo =
        (photos || []).find((p) => p.id === gallery.cover_photo_id) || null;
      if (!cover_photo) {
        const { data: coverRow } = await supabase
          .from('gallery_photo')
          .select(PUBLIC_PHOTO_COLUMNS)
          .eq('gallery_id', gallery.id)
          .eq('tenant_id', tenant.id)
          .eq('id', gallery.cover_photo_id)
          .maybeSingle();
        cover_photo = coverRow || null;
      }
    }
    if (!cover_photo) {
      // First-photo fallback (documented): the earliest photo by display order.
      const { data: firstRow } = await supabase
        .from('gallery_photo')
        .select(PUBLIC_PHOTO_COLUMNS)
        .eq('gallery_id', gallery.id)
        .eq('tenant_id', tenant.id)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      cover_photo = firstRow || null;
    }

    return res.json({
      ...base,
      is_locked: false,
      photos: photos || [],
      total_photos: count ?? 0,
      cover_photo,
    });
  } catch (err) {
    console.error('[Public Gallery API] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch gallery' });
  }
}
