import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  // SECURITY: Canvas templates (including their full design payloads) are
  // editor authoring assets. Require tenant admin OR `site-builder.page-editor`.
  let canEditCanvasPages = !!context.tenantUserId;
  if (!canEditCanvasPages && context.roleId) {
    canEditCanvasPages = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEditCanvasPages) return res.status(403).json({ error: 'Forbidden' });

  const tenantId = context.tenantId;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('canvas_template')
      .select('id, tenant_id, name, description, category, preview_image_url, is_starter, created_at, updated_at')
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .order('is_starter', { ascending: false })
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('[CanvasTemplates] GET error:', error);
      return res.status(500).json({ error: 'Failed to load templates' });
    }
    return res.status(200).json({ templates: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!body.design || typeof body.design !== 'object') return res.status(400).json({ error: 'design required' });
    const row = {
      tenant_id: tenantId,
      name: body.name.slice(0, 200),
      description: body.description || null,
      category: body.category || null,
      preview_image_url: body.preview_image_url || null,
      design: body.design,
      is_starter: false,
      created_by: context.memberId || null,
    };
    const { data, error } = await supabase.from('canvas_template').insert(row).select().single();
    if (error) {
      console.error('[CanvasTemplates] POST error:', error);
      return res.status(500).json({ error: 'Failed to create template' });
    }
    return res.status(201).json({ template: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
