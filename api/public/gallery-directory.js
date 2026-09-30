import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { evaluateGalleryAccessPolicies } from '../_lib/galleryAccessPolicy.js';
import { buildGalleryDirectoryPage, parseGalleryDirectoryPagination } from '../_lib/galleryDirectory.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const context = await getTenantContext(req);
    if (context.tenantMismatch) return res.status(404).json({ error: 'Tenant not found' });
    const manager = !!context.tenantUserId || (context.roleId && await hasFeatureAccess(context.roleId, 'content.gallery.manage'));
    const { page, pageSize } = parseGalleryDirectoryPagination(req.query);
    const needle = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    let galleryQuery = supabase.from('gallery')
      .select('id, title, description, slug, is_public, cover_photo_id, display_order, created_at, access_policy')
      .eq('tenant_id', tenant.id).order('display_order', { ascending: true }).order('created_at', { ascending: false });
    if (needle) galleryQuery = galleryQuery.ilike('title', `%${needle}%`);
    const { data, error } = await galleryQuery;
    if (error) return res.status(500).json({ error: 'Failed to fetch galleries' });
    const galleries = data || [];
    const access = context.isAuthenticated
      ? await evaluateGalleryAccessPolicies({
        supabase,
        tenantId: tenant.id,
        memberId: context.memberId,
        roleId: context.roleId,
        policies: galleries.map((gallery) => gallery.is_public ? null : gallery.access_policy),
        isManager: manager,
      })
      : galleries.map(() => ({ allowed: false }));
    const visible = galleries.filter((gallery, index) =>
      gallery.is_public || (context.isAuthenticated && access[index]?.allowed)
    );
    const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
    const coverIds = pageRows.map((gallery) => gallery.cover_photo_id).filter(Boolean);
    let covers = [];
    if (coverIds.length) {
      const { data: coverRows, error: coverError } = await supabase.from('gallery_photo')
        .select('id, gallery_id, file_url, alt_text')
        .eq('tenant_id', tenant.id)
        .in('gallery_id', pageRows.map((gallery) => gallery.id))
        .in('id', coverIds);
      if (coverError) return res.status(500).json({ error: 'Failed to fetch gallery covers' });
      covers = coverRows || [];
    }
    return res.json(buildGalleryDirectoryPage({
      galleries, access, covers, page, pageSize, isAuthenticated: context.isAuthenticated,
    }));
  } catch {
    return res.status(500).json({ error: 'Failed to fetch galleries' });
  }
}