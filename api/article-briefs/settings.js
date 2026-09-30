import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const DEFAULT_STAGES = [
  { key: 'new', label: 'New', color: '#6b7280' },
  { key: 'assigned', label: 'Assigned', color: '#3b82f6' },
  { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { key: 'changes_requested', label: 'Changes Requested', color: '#f97316' },
  { key: 'approved', label: 'Approved', color: '#22c55e' },
  { key: 'rejected', label: 'Rejected', color: '#ef4444' },
];

const DEFAULT_CATEGORIES = ['General', 'News', 'Feature', 'Opinion', 'Review', 'Interview', 'Tutorial'];

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const KEY_RE = /^[a-z0-9_]{1,64}$/;
const MAX_STAGES = 50;
const MAX_CATEGORIES = 100;
const MAX_LABEL_LENGTH = 100;

function validateStages(stages) {
  if (!Array.isArray(stages)) return 'stages must be an array';
  if (stages.length > MAX_STAGES) return `stages cannot exceed ${MAX_STAGES} items`;
  const keys = new Set();
  for (const s of stages) {
    if (!s || typeof s !== 'object') return 'each stage must be an object';
    if (!s.key || typeof s.key !== 'string' || !KEY_RE.test(s.key)) return `invalid stage key: "${s.key}"`;
    if (!s.label || typeof s.label !== 'string' || s.label.length > MAX_LABEL_LENGTH) return `invalid stage label for key "${s.key}"`;
    if (!s.color || typeof s.color !== 'string' || !COLOR_RE.test(s.color)) return `invalid stage color for key "${s.key}"`;
    if (keys.has(s.key)) return `duplicate stage key: "${s.key}"`;
    keys.add(s.key);
  }
  return null;
}

function validateCategories(categories) {
  if (!Array.isArray(categories)) return 'categories must be an array';
  if (categories.length > MAX_CATEGORIES) return `categories cannot exceed ${MAX_CATEGORIES} items`;
  const seen = new Set();
  for (const c of categories) {
    if (typeof c !== 'string' || c.length === 0 || c.length > MAX_LABEL_LENGTH) return `invalid category: "${c}"`;
    if (seen.has(c)) return `duplicate category: "${c}"`;
    seen.add(c);
  }
  return null;
}

async function getRoleExcludedFeatures(tenantCtx) {
  if (!tenantCtx.roleId || !supabase) return [];
  try {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', tenantCtx.roleId)
      .single();
    return role?.excluded_features || [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = tenantCtx.tenantId;

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('article_brief_settings')
        .select('*')
        .eq('tenant_id', tenantId)
        .single();

      if (error && error.code === 'PGRST116') {
        return res.json({
          tenant_id: tenantId,
          stages: DEFAULT_STAGES,
          categories: DEFAULT_CATEGORIES,
          notify_reviewer: false,
          notify_writer: false,
        });
      }

      if (error) {
        console.error('[BriefSettings GET] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data);
    }

    if (req.method === 'PUT') {
      const excludedFeatures = await getRoleExcludedFeatures(tenantCtx);
      if (isResourceExcluded(excludedFeatures, 'content.brief-settings')) {
        return res.status(403).json({ error: 'You do not have permission to modify brief settings' });
      }

      const { stages, categories, notify_reviewer, notify_writer } = req.body;

      if (stages !== undefined) {
        const err = validateStages(stages);
        if (err) return res.status(400).json({ error: err });
      }

      if (categories !== undefined) {
        const err = validateCategories(categories);
        if (err) return res.status(400).json({ error: err });
      }

      if (notify_reviewer !== undefined && typeof notify_reviewer !== 'boolean') {
        return res.status(400).json({ error: 'notify_reviewer must be a boolean' });
      }

      if (notify_writer !== undefined && typeof notify_writer !== 'boolean') {
        return res.status(400).json({ error: 'notify_writer must be a boolean' });
      }

      const payload = {
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      };

      if (stages !== undefined) payload.stages = stages;
      if (categories !== undefined) payload.categories = categories;
      if (notify_reviewer !== undefined) payload.notify_reviewer = notify_reviewer;
      if (notify_writer !== undefined) payload.notify_writer = notify_writer;

      const { data: existing } = await supabase
        .from('article_brief_settings')
        .select('id')
        .eq('tenant_id', tenantId)
        .single();

      let data, error;

      if (existing) {
        ({ data, error } = await supabase
          .from('article_brief_settings')
          .update(payload)
          .eq('tenant_id', tenantId)
          .select()
          .single());
      } else {
        ({ data, error } = await supabase
          .from('article_brief_settings')
          .insert({
            ...payload,
            stages: stages || DEFAULT_STAGES,
            categories: categories || DEFAULT_CATEGORIES,
            notify_reviewer: notify_reviewer || false,
            notify_writer: notify_writer || false,
          })
          .select()
          .single());
      }

      if (error) {
        console.error('[BriefSettings PUT] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[BriefSettings] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
