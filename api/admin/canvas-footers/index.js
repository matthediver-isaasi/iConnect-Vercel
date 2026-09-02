import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import {
  EMPTY_CANVAS_FOOTER_DESIGN,
  normalizeCanvasFooterDesign,
} from '../../_lib/canvasFooters.js';

const COLUMNS = 'id, tenant_id, name, design, created_by, updated_by, created_at, updated_at';

function cleanName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  let allowed = !!context.tenantUserId;
  if (!allowed && context.roleId) {
    const feature = req.method === 'GET' ? 'site-builder.pages' : 'site-builder.page-editor';
    allowed = await hasFeatureAccess(context.roleId, feature);
  }
  if (!context.tenantId || !allowed) {
    res.status(404).json({ error: 'Canvas footer not found' });
    return null;
  }
  return context;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const context = await authorize(req, res);
  if (!context) return;
  const tenantId = context.tenantId;
  const id = req.query?.id || null;

  try {
    if (req.method === 'GET') {
      let query = supabase.from('canvas_footer').select(COLUMNS).eq('tenant_id', tenantId).order('updated_at', { ascending: false });
      if (id) query = query.eq('id', id).maybeSingle();
      const { data, error } = await query;
      if (error) return res.status(error.code === '42P01' ? 200 : 500).json(id ? { footer: null } : { footers: [] });
      return res.status(200).json(id ? { footer: data || null } : { footers: data || [] });
    }

    if (req.method === 'POST') {
      const name = cleanName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Name must be between 1 and 120 characters' });
      const design = normalizeCanvasFooterDesign(req.body?.design) || EMPTY_CANVAS_FOOTER_DESIGN;
      const { data, error } = await supabase.from('canvas_footer').insert({
        tenant_id: tenantId,
        name,
        design,
        created_by: context.memberId || null,
        updated_by: context.memberId || null,
      }).select(COLUMNS).single();
      if (error) return res.status(500).json({ error: 'Failed to create Canvas footer' });
      return res.status(201).json({ success: true, footer: data });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'Footer id is required' });
      const { data: existing } = await supabase.from('canvas_footer')
        .select('id, name, design').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      if (!existing) return res.status(404).json({ error: 'Canvas footer not found' });
      const update = { updated_at: new Date().toISOString(), updated_by: context.memberId || null };
      if (req.body?.name !== undefined) {
        const name = cleanName(req.body.name);
        if (!name) return res.status(400).json({ error: 'Name must be between 1 and 120 characters' });
        update.name = name;
      }
      if (req.body?.design !== undefined) {
        const design = normalizeCanvasFooterDesign(req.body.design);
        if (!design) return res.status(400).json({ error: 'A valid Canvas design is required' });
        update.design = design;
        await supabase.from('canvas_footer_version').insert({
          footer_id: id,
          tenant_id: tenantId,
          design: existing.design,
          name: existing.name,
          created_by: context.memberId || null,
        });
      }
      const { data, error } = await supabase.from('canvas_footer').update(update)
        .eq('id', id).eq('tenant_id', tenantId).select(COLUMNS).maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to update Canvas footer' });
      if (!data) return res.status(404).json({ error: 'Canvas footer not found' });
      if (update.design) {
        const { data: oldVersions } = await supabase.from('canvas_footer_version')
          .select('id').eq('footer_id', id).eq('tenant_id', tenantId)
          .order('created_at', { ascending: false }).range(10, 1000);
        const ids = (oldVersions || []).map((row) => row.id);
        if (ids.length) await supabase.from('canvas_footer_version').delete().in('id', ids).eq('tenant_id', tenantId);
      }
      return res.status(200).json({ success: true, footer: data });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Footer id is required' });
      const [{ data: tenantUse }, { data: micrositeUse }] = await Promise.all([
        supabase.from('tenant').select('id').eq('id', tenantId).eq('canvas_footer_id', id).maybeSingle(),
        supabase.from('microsite').select('id').eq('tenant_id', tenantId).eq('canvas_footer_id', id).limit(1),
      ]);
      if (tenantUse || (micrositeUse || []).length > 0) {
        return res.status(409).json({ error: 'This footer is assigned and cannot be deleted. Switch assignments first.' });
      }
      const { data, error } = await supabase.from('canvas_footer').delete()
        .eq('id', id).eq('tenant_id', tenantId).select('id').maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to delete Canvas footer' });
      if (!data) return res.status(404).json({ error: 'Canvas footer not found' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Admin Canvas footers] Error:', error);
    return res.status(500).json({ error: 'Canvas footer request failed' });
  }
}