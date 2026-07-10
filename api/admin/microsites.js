import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import {
  validateMicrositePrefix,
  isMissingMicrositeSchema,
  sanitizeMicrositeBrandingConfig,
  normalizeSearchResultsBranding,
  resolveAllowedFontFamilies,
} from '../_lib/microsites.js';

/**
 * Task #2426: admin CRUD for tenant microsites.
 *
 * GET    /api/admin/microsites            → list all microsites for tenant
 * GET    /api/admin/microsites?id=<uuid>  → single microsite
 * POST   /api/admin/microsites            → create
 * PATCH  /api/admin/microsites?id=<uuid>  → update
 * DELETE /api/admin/microsites?id=<uuid>  → delete + unassign pages/nav
 *
 * Access: tenant-admin access (getTenantContext + hasAdminAccess —
 * getTenantIdFromSession alone only proves membership, not admin role) OR a
 * portal role that includes the `site-builder.micro-sites` feature (Task
 * #2523 — mirrors the canvas endpoints' dual-gate pattern so tenants can
 * grant microsite management to non-admin roles via Role Management).
 */

const MICROSITE_COLUMNS =
  'id, tenant_id, name, path_prefix, description, is_active, logo_url, header_config, footer_config, branding_config, home_page_id, created_at, updated_at';

function sanitizeConfigObject(value) {
  // Header/footer configs are free-form JSON objects edited by the microsite
  // editors. Accept plain objects only; anything else becomes {}.
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

async function prefixCollidesWithPageSlug(tenantId, prefix) {
  // A microsite prefix must not shadow an existing top-level page slug —
  // otherwise /{prefix} would become ambiguous.
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('slug', prefix)
    .limit(1);
  if (error) return false;
  return (data || []).length > 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!context.tenantId) {
    return res.status(400).json({ error: 'Tenant context not found' });
  }
  let canManageMicrosites = await hasAdminAccess(context);
  if (!canManageMicrosites && context.roleId) {
    canManageMicrosites = await hasFeatureAccess(context.roleId, 'site-builder.micro-sites');
  }
  if (!canManageMicrosites) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const tenantId = context.tenantId;
  const id = req.query?.id || null;

  try {
    if (req.method === 'GET') {
      if (id) {
        const { data, error } = await supabase
          .from('microsite')
          .select(MICROSITE_COLUMNS)
          .eq('tenant_id', tenantId)
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Microsite not found' });
        return res.json({ success: true, microsite: data });
      }
      const { data, error } = await supabase
        .from('microsite')
        .select(MICROSITE_COLUMNS)
        .eq('tenant_id', tenantId)
        .order('name', { ascending: true });
      if (error) {
        if (isMissingMicrositeSchema(error)) {
          return res.json({ success: true, microsites: [] });
        }
        throw error;
      }
      return res.json({ success: true, microsites: data || [] });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const prefix = String(body.path_prefix || '').trim().toLowerCase();
      const check = validateMicrositePrefix(prefix);
      if (!check.ok) return res.status(400).json({ error: check.error });
      if (await prefixCollidesWithPageSlug(tenantId, prefix)) {
        return res.status(400).json({ error: `"${prefix}" is already used as a page slug on your default site` });
      }

      const insert = {
        tenant_id: tenantId,
        name,
        path_prefix: prefix,
        description: body.description ? String(body.description) : null,
        is_active: body.is_active !== false,
        logo_url: body.logo_url ? String(body.logo_url) : null,
        header_config: sanitizeConfigObject(body.header_config),
        footer_config: sanitizeConfigObject(body.footer_config),
        branding_config: normalizeSearchResultsBranding(
          sanitizeMicrositeBrandingConfig(body.branding_config),
          await resolveAllowedFontFamilies(supabase, tenantId),
        ),
        home_page_id: body.home_page_id || null,
      };

      const { data, error } = await supabase
        .from('microsite')
        .insert(insert)
        .select(MICROSITE_COLUMNS)
        .single();
      if (error) {
        // Unique violation on (tenant_id, path_prefix)
        if (error.code === '23505') {
          return res.status(400).json({ error: `A microsite with the prefix "${prefix}" already exists` });
        }
        throw error;
      }
      return res.status(201).json({ success: true, microsite: data });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'Microsite id is required' });
      const body = req.body || {};

      // Confirm ownership before writing.
      const { data: existing, error: fetchError } = await supabase
        .from('microsite')
        .select('id, path_prefix')
        .eq('tenant_id', tenantId)
        .eq('id', id)
        .maybeSingle();
      if (fetchError) throw fetchError;
      if (!existing) return res.status(404).json({ error: 'Microsite not found' });

      const update = {};
      if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
        update.name = name;
      }
      if (body.path_prefix !== undefined) {
        const prefix = String(body.path_prefix || '').trim().toLowerCase();
        if (prefix !== existing.path_prefix) {
          const check = validateMicrositePrefix(prefix);
          if (!check.ok) return res.status(400).json({ error: check.error });
          if (await prefixCollidesWithPageSlug(tenantId, prefix)) {
            return res.status(400).json({ error: `"${prefix}" is already used as a page slug on your default site` });
          }
          update.path_prefix = prefix;
        }
      }
      if (body.description !== undefined) update.description = body.description ? String(body.description) : null;
      if (body.is_active !== undefined) update.is_active = body.is_active !== false;
      if (body.logo_url !== undefined) update.logo_url = body.logo_url ? String(body.logo_url) : null;
      if (body.header_config !== undefined) update.header_config = sanitizeConfigObject(body.header_config);
      if (body.footer_config !== undefined) update.footer_config = sanitizeConfigObject(body.footer_config);
      if (body.branding_config !== undefined) {
        update.branding_config = normalizeSearchResultsBranding(
          sanitizeMicrositeBrandingConfig(body.branding_config),
          await resolveAllowedFontFamilies(supabase, tenantId),
        );
      }
      if (body.home_page_id !== undefined) update.home_page_id = body.home_page_id || null;

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      update.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('microsite')
        .update(update)
        .eq('tenant_id', tenantId)
        .eq('id', id)
        .select(MICROSITE_COLUMNS)
        .single();
      if (error) {
        if (error.code === '23505') {
          return res.status(400).json({ error: 'A microsite with that prefix already exists' });
        }
        throw error;
      }
      return res.json({ success: true, microsite: data });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Microsite id is required' });

      const { data: existing, error: fetchError } = await supabase
        .from('microsite')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('id', id)
        .maybeSingle();
      if (fetchError) throw fetchError;
      if (!existing) return res.status(404).json({ error: 'Microsite not found' });

      // Unassign pages and navigation items back to the default site rather
      // than orphaning them (per spec).
      const { error: pageError } = await supabase
        .from('i_edit_page')
        .update({ microsite_id: null })
        .eq('tenant_id', tenantId)
        .eq('microsite_id', id);
      if (pageError && !isMissingMicrositeSchema(pageError)) throw pageError;

      const { error: navError } = await supabase
        .from('navigation_item')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('microsite_id', id);
      if (navError && !isMissingMicrositeSchema(navError)) throw navError;

      const { error } = await supabase
        .from('microsite')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('id', id);
      if (error) throw error;

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Admin Microsites] Error:', error);
    return res.status(500).json({ error: 'Failed to process microsite request' });
  }
}
