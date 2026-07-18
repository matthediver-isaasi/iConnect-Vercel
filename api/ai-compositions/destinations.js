// AI Composition link destinations — tenant-scoped search (Task #2850, spec §16).
//
// GET /api/ai-compositions/destinations?q=<phrase>&kinds=page,event_registration,...
//   → { destinations: [{ kind, id, title, detail }] }
//
// The AI never invents internal URLs: link destinations are record IDs the
// user picks from these tenant-scoped results.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

const SEARCHERS = {
  page: async (tenantId, q) => {
    const { data } = await supabase
      .from('i_edit_page')
      .select('id, title, slug, status')
      .eq('tenant_id', tenantId)
      .is('microsite_id', null)
      .ilike('title', `%${q}%`)
      .limit(8);
    return (data || []).map((r) => ({
      kind: 'page', id: r.id, slug: r.slug, title: r.title || r.slug,
      detail: r.status === 'published' ? `/${r.slug}` : `/${r.slug} (draft)`,
    }));
  },
  event_registration: async (tenantId, q) => {
    const { data } = await supabase
      .from('event')
      .select('id, title, start_date')
      .eq('tenant_id', tenantId)
      .ilike('title', `%${q}%`)
      .order('start_date', { ascending: false })
      .limit(8);
    return (data || []).map((r) => ({
      kind: 'event_registration', id: r.id, title: r.title,
      detail: r.start_date ? `Event · ${String(r.start_date).slice(0, 10)}` : 'Event',
    }));
  },
  form: async (tenantId, q) => {
    const { data } = await supabase
      .from('form')
      .select('id, name, slug, is_active')
      .eq('tenant_id', tenantId)
      .ilike('name', `%${q}%`)
      .limit(8);
    return (data || []).map((r) => ({
      kind: 'form', id: r.id, slug: r.slug || null, title: r.name,
      detail: r.is_active === false ? 'Form (inactive)' : 'Form',
    }));
  },
  document: async (tenantId, q) => {
    const { data } = await supabase
      .from('file_repository')
      .select('id, file_name, file_type')
      .eq('tenant_id', tenantId)
      .ilike('file_name', `%${q}%`)
      .limit(8);
    return (data || []).map((r) => ({
      kind: 'document', id: r.id, title: r.file_name,
      detail: r.file_type ? `Document · ${r.file_type}` : 'Document',
    }));
  },
  membership_application: async (tenantId, q) => {
    const { data } = await supabase
      .from('membership_tier_config')
      .select('id, name, is_active')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .ilike('name', `%${q}%`)
      .limit(8);
    return (data || []).map((r) => ({
      kind: 'membership_application', id: r.id, title: r.name, detail: 'Membership tier',
    }));
  },
};

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  let canEdit = !!context.tenantUserId;
  if (!canEdit && context.roleId) {
    canEdit = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEdit) return res.status(404).json({ error: 'Not found' });

  const q = String(req.query?.q || '').trim().slice(0, 100);
  if (!q) return res.status(200).json({ destinations: [] });
  const kindsParam = String(req.query?.kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const kinds = kindsParam.length
    ? kindsParam.filter((k) => SEARCHERS[k])
    : Object.keys(SEARCHERS);

  try {
    const results = await Promise.all(kinds.map((k) => SEARCHERS[k](context.tenantId, q)));
    return res.status(200).json({ destinations: results.flat().slice(0, 24) });
  } catch {
    return res.status(500).json({ error: 'Destination search failed' });
  }
}
