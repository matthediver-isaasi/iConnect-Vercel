import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import {
  EMPTY_CANVAS_FOOTER_DESIGN,
  normalizeCanvasFooterDesign,
} from '../../_lib/canvasFooters.js';

const LEGACY_COLUMNS = 'id, tenant_id, name, design, created_by, updated_by, created_at, updated_at';
const COLUMNS = `${LEGACY_COLUMNS}, microsite_id`;

function cleanName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}

function cleanMicrositeId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id || null;
}

function isMissingContextColumn(error) {
  return (error?.code === '42703' || /^PGRST/.test(error?.code || ''))
    && /microsite_id/i.test(error.message || '')
    && /column|schema cache|does not exist/i.test(error.message || '');
}

async function loadFooters(tenantId, id = null) {
  const run = (columns) => {
    let query = supabase.from('canvas_footer').select(columns).eq('tenant_id', tenantId).order('updated_at', { ascending: false });
    if (id) query = query.eq('id', id).maybeSingle();
    return query;
  };
  let { data, error } = await run(COLUMNS);
  if (isMissingContextColumn(error)) {
    ({ data, error } = await run(LEGACY_COLUMNS));
    if (!error) {
      data = id
        ? (data ? { ...data, microsite_id: null } : null)
        : (data || []).map((row) => ({ ...row, microsite_id: null }));
    }
  }
  return { data, error };
}

async function loadMicrosites(tenantId) {
  const query = supabase
    .from('microsite')
    .select('id, name, path_prefix, is_active')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function attachMicrosite(footer, microsites) {
  if (!footer) return footer;
  const microsite = footer.microsite_id
    ? microsites.find((row) => String(row.id) === String(footer.microsite_id)) || null
    : null;
  return { ...footer, microsite };
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

async function canManageMicrosites(context) {
  if (await hasAdminAccess(context)) return true;
  return !!context.roleId
    && await hasFeatureAccess(context.roleId, 'site-builder.micro-sites');
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const context = await authorize(req, res);
  if (!context) return;
  const tenantId = context.tenantId;
  const id = req.query?.id || null;

  try {
    if (req.method === 'GET') {
      const [{ data, error }, microsites] = await Promise.all([
        loadFooters(tenantId, id),
        loadMicrosites(tenantId),
      ]);
      if (error) return res.status(error.code === '42P01' ? 200 : 500).json(id ? { footer: null } : { footers: [] });
      if (id) {
        return res.status(200).json({ footer: attachMicrosite(data || null, microsites) });
      }
      return res.status(200).json({
        footers: (data || []).map((footer) => attachMicrosite(footer, microsites)),
        microsites: microsites.filter((microsite) => microsite.is_active !== false),
      });
    }

    if (req.method === 'POST') {
      const name = cleanName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Name must be between 1 and 120 characters' });
      const design = normalizeCanvasFooterDesign(req.body?.design) || EMPTY_CANVAS_FOOTER_DESIGN;
      const micrositeId = cleanMicrositeId(req.body?.microsite_id);
      if (micrositeId && !await canManageMicrosites(context)) {
        return res.status(403).json({ error: 'Microsite management access is required' });
      }
      let data;
      let error;
      if (micrositeId) {
        ({ data, error } = await supabase.rpc('create_canvas_footer_for_context', {
          p_tenant_id: tenantId,
          p_name: name,
          p_design: design,
          p_created_by: context.memberId || null,
          p_microsite_id: micrositeId,
          p_assign_to_microsite: req.body?.assign_to_microsite === true,
        }).single());
      } else {
        const payload = {
          tenant_id: tenantId,
          name,
          design,
          microsite_id: null,
          created_by: context.memberId || null,
          updated_by: context.memberId || null,
        };
        ({ data, error } = await supabase.from('canvas_footer').insert(payload).select(COLUMNS).single());
        if (isMissingContextColumn(error)) {
          delete payload.microsite_id;
          ({ data, error } = await supabase.from('canvas_footer').insert(payload).select(LEGACY_COLUMNS).single());
          if (!error && data) data = { ...data, microsite_id: null };
        }
      }
      if (error) {
        if (error.code === '23514' || error.code === '22P02') {
          return res.status(400).json({ error: 'Select an active microsite owned by this tenant' });
        }
        return res.status(500).json({ error: 'Failed to create Canvas footer' });
      }
      const microsites = micrositeId ? await loadMicrosites(tenantId) : [];
      return res.status(201).json({ success: true, footer: attachMicrosite(data, microsites) });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'Footer id is required' });
      const { data: existing, error: existingError } = await loadFooters(tenantId, id);
      if (existingError) return res.status(500).json({ error: 'Failed to load Canvas footer' });
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
      let { data, error } = await supabase.from('canvas_footer').update(update)
        .eq('id', id).eq('tenant_id', tenantId).select(COLUMNS).maybeSingle();
      if (isMissingContextColumn(error)) {
        ({ data, error } = await supabase.from('canvas_footer').update(update)
          .eq('id', id).eq('tenant_id', tenantId).select(LEGACY_COLUMNS).maybeSingle());
        if (!error && data) data = { ...data, microsite_id: null };
      }
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