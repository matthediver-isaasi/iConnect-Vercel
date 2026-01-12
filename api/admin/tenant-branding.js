import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { clearTenantCache } from '../_lib/tenantResolver.js';

function isValidHexColor(color) {
  if (!color || typeof color !== 'string') return false;
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(color);
}

function normalizeHexColor(color) {
  if (!color) return null;
  const trimmed = color.trim();
  if (isValidHexColor(trimmed)) {
    return trimmed.toUpperCase();
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantUser.tenant_id;

  if (req.method === 'GET') {
    try {
      const { data: tenant, error } = await supabase
        .from('tenant')
        .select('id, primary_color, secondary_color, tagline, logo_url, header_logo_url, header_config, footer_config, branding_config')
        .eq('id', tenantId)
        .single();

      if (error || !tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      res.json({ success: true, branding: tenant });
    } catch (error) {
      console.error('[Admin] Get tenant branding error:', error);
      res.status(500).json({ error: 'Failed to get tenant branding' });
    }
  } else if (req.method === 'PATCH') {
    try {
      const allowedFields = [
        'primary_color',
        'secondary_color', 
        'tagline',
        'logo_url',
        'header_logo_url',
        'header_config',
        'footer_config',
        'branding_config'
      ];
      
      const updates = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (updates.primary_color) {
        const normalized = normalizeHexColor(updates.primary_color);
        if (!normalized) {
          return res.status(400).json({ error: 'Invalid primary color format. Use hex format like #5C0085' });
        }
        updates.primary_color = normalized;
      }

      if (updates.secondary_color) {
        const normalized = normalizeHexColor(updates.secondary_color);
        if (!normalized) {
          return res.status(400).json({ error: 'Invalid secondary color format. Use hex format like #BA0087' });
        }
        updates.secondary_color = normalized;
      }

      if (updates.footer_config?.gradientColors) {
        const validatedColors = [];
        for (const color of updates.footer_config.gradientColors) {
          const normalized = normalizeHexColor(color);
          if (normalized) {
            validatedColors.push(normalized);
          }
        }
        updates.footer_config.gradientColors = validatedColors;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      updates.updated_at = new Date().toISOString();

      const { data: tenant, error } = await supabase
        .from('tenant')
        .update(updates)
        .eq('id', tenantId)
        .select('id, slug, domain, primary_color, secondary_color, tagline, logo_url, header_logo_url, header_config, footer_config, branding_config')
        .single();

      if (error) {
        console.error('[Admin] Update tenant branding error:', error);
        return res.status(500).json({ error: 'Failed to update branding' });
      }

      if (tenant.slug) {
        clearTenantCache(tenant.slug);
      }
      if (tenant.domain) {
        clearTenantCache(tenant.domain);
      }

      console.log('[Admin] Tenant branding updated:', tenantId);
      res.json({ success: true, branding: tenant });
    } catch (error) {
      console.error('[Admin] Update tenant branding error:', error);
      res.status(500).json({ error: 'Failed to update branding' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
