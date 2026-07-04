import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';

// Platform-owner CRUD for Help Center articles (Task #2199).
// Content is GLOBAL (shared across all tenants). Only the platform owner may
// create/update/delete/reorder; the portal reads published articles via the
// generic GLOBAL entity API.

const ALLOWED_STATUS = ['draft', 'published'];

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeFields(body) {
  const out = {};
  if (typeof body.title === 'string') out.title = body.title.trim();
  if (typeof body.category === 'string') out.category = body.category.trim() || null;
  if (typeof body.summary === 'string') out.summary = body.summary.trim() || null;
  if (typeof body.body === 'string') out.body = body.body;
  if (typeof body.required_feature === 'string') {
    out.required_feature = body.required_feature.trim() || null;
  } else if (body.required_feature === null) {
    out.required_feature = null;
  }
  if (typeof body.status === 'string' && ALLOWED_STATUS.includes(body.status)) {
    out.status = body.status;
  }
  if (body.sort_order !== undefined && body.sort_order !== null && !Number.isNaN(Number(body.sort_order))) {
    out.sort_order = Number(body.sort_order);
  }
  if (typeof body.slug === 'string' && body.slug.trim()) {
    out.slug = slugify(body.slug);
  }
  return out;
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(403).json({ error: 'Platform owner access required' });
  }

  try {
    if (req.method === 'GET') {
      // List ALL articles (including drafts) for the editor.
      const { data, error } = await supabase
        .from('help_article')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      // Reorder mode: { action: 'reorder', order: [id, id, ...] }
      if (req.body?.action === 'reorder' && Array.isArray(req.body.order)) {
        const ids = req.body.order.filter((id) => typeof id === 'string');
        for (let i = 0; i < ids.length; i++) {
          const { error } = await supabase
            .from('help_article')
            .update({ sort_order: i, updated_at: new Date().toISOString() })
            .eq('id', ids[i]);
          if (error) throw error;
        }
        return res.status(200).json({ success: true });
      }

      const fields = sanitizeFields(req.body || {});
      if (!fields.title) {
        return res.status(400).json({ error: 'Title is required' });
      }
      if (!fields.slug) {
        fields.slug = slugify(fields.title);
      }
      if (!fields.slug) {
        return res.status(400).json({ error: 'A valid slug could not be derived' });
      }
      if (fields.body === undefined) fields.body = '';
      if (fields.status === undefined) fields.status = 'draft';

      const { data, error } = await supabase
        .from('help_article')
        .insert(fields)
        .select()
        .single();
      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'An article with that slug already exists' });
        }
        throw error;
      }
      return res.status(201).json(data);
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }
      const fields = sanitizeFields(req.body || {});
      if ('title' in fields && !fields.title) {
        return res.status(400).json({ error: 'Title cannot be empty' });
      }
      if ('slug' in fields && !fields.slug) {
        return res.status(400).json({ error: 'Slug cannot be empty' });
      }
      fields.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('help_article')
        .update(fields)
        .eq('id', id)
        .select()
        .single();
      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'An article with that slug already exists' });
        }
        throw error;
      }
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }
      const { error } = await supabase.from('help_article').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Platform Help Articles] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
