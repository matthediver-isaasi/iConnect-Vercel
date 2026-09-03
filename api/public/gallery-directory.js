import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { evaluateGalleryAccessPolicy } from '../_lib/galleryAccessPolicy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const context = await getTenantContext(req);
    if (context.tenantMismatch) return res.status(404).json({ error: 'Tenant not found' });
    const manager = !!context.tenantUserId || (context.roleId && await hasFeatureAccess(context.roleId, 'content.gallery.manage'));
    const { data, error } = await supabase.from('gallery')
      .select('id, title, description, slug, is_public, cover_photo_id, display_order, created_at, access_policy')
      .eq('tenant_id', tenant.id).order('display_order', { ascending: true }).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to fetch galleries' });
    const needle = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const visible = [];
    for (const gallery of data || []) {
      let allowed = gallery.is_public;
      if (!allowed && context.isAuthenticated) {
        const access = await evaluateGalleryAccessPolicy({
          supabase, tenantId: tenant.id, memberId: context.memberId, roleId: context.roleId,
          policy: gallery.access_policy, isManager: manager,
        });
        allowed = access.allowed;
      }
      if (allowed && (!needle || String(gallery.title || '').toLowerCase().includes(needle))) {
        const { data: cover } = gallery.cover_photo_id
          ? await supabase.from('gallery_photo').select('id, file_url, alt_text').eq('tenant_id', tenant.id).eq('gallery_id', gallery.id).eq('id', gallery.cover_photo_id).maybeSingle()
          : { data: null };
        visible.push({ id: gallery.id, title: gallery.title, description: gallery.description, slug: gallery.slug, is_public: gallery.is_public, cover_photo: cover });
      }
    }
    return res.json(visible);
  } catch {
    return res.status(500).json({ error: 'Failed to fetch galleries' });
  }
}