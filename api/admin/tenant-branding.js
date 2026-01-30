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
        .select('id, primary_color, secondary_color, tagline, logo_url, header_logo_url, header_config, footer_config, branding_config, platform_branding')
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
        'branding_config',
        'platform_branding'
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

      if (updates.header_config?.gradientStops) {
        const validatedStops = [];
        for (const stop of updates.header_config.gradientStops) {
          if (typeof stop === 'object' && stop.color && typeof stop.position === 'number') {
            const normalized = normalizeHexColor(stop.color);
            if (normalized) {
              const position = Math.max(0, Math.min(100, Math.round(stop.position)));
              validatedStops.push({ color: normalized, position });
            }
          }
        }
        if (validatedStops.length > 0) {
          validatedStops.sort((a, b) => a.position - b.position);
          updates.header_config.gradientStops = validatedStops;
        }
      }

      // Validate platform_branding colors if provided
      if (updates.platform_branding) {
        if (updates.platform_branding.backgroundColor) {
          const normalized = normalizeHexColor(updates.platform_branding.backgroundColor);
          if (normalized) {
            updates.platform_branding.backgroundColor = normalized;
          }
        }
        if (updates.platform_branding.textColor) {
          const normalized = normalizeHexColor(updates.platform_branding.textColor);
          if (normalized) {
            updates.platform_branding.textColor = normalized;
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      // For JSONB fields (header_config, footer_config, branding_config, platform_branding),
      // merge with existing data to prevent partial updates from overwriting other fields
      if (updates.footer_config || updates.header_config || updates.branding_config || updates.platform_branding) {
        const { data: existing, error: fetchError } = await supabase
          .from('tenant')
          .select('header_config, footer_config, branding_config, platform_branding')
          .eq('id', tenantId)
          .single();

        if (fetchError) {
          console.error('[Admin] Error fetching existing config:', fetchError);
          return res.status(500).json({ error: 'Failed to fetch existing config' });
        }

        // Deep merge JSONB fields
        if (updates.footer_config) {
          updates.footer_config = {
            ...(existing?.footer_config || {}),
            ...updates.footer_config,
            // Preserve nested objects (address, contact) if not explicitly updated
            address: updates.footer_config.address !== undefined 
              ? updates.footer_config.address 
              : existing?.footer_config?.address,
            contact: updates.footer_config.contact !== undefined
              ? updates.footer_config.contact
              : existing?.footer_config?.contact,
            columnAlignments: updates.footer_config.columnAlignments !== undefined
              ? updates.footer_config.columnAlignments
              : existing?.footer_config?.columnAlignments,
            gradientColors: updates.footer_config.gradientColors !== undefined
              ? updates.footer_config.gradientColors
              : existing?.footer_config?.gradientColors,
          };
        }

        if (updates.header_config) {
          updates.header_config = {
            ...(existing?.header_config || {}),
            ...updates.header_config,
          };
        }

        if (updates.branding_config) {
          updates.branding_config = {
            ...(existing?.branding_config || {}),
            ...updates.branding_config,
          };
        }

        if (updates.platform_branding) {
          updates.platform_branding = {
            ...(existing?.platform_branding || {}),
            ...updates.platform_branding,
          };
        }
      }

      updates.updated_at = new Date().toISOString();

      const { data: tenant, error } = await supabase
        .from('tenant')
        .update(updates)
        .eq('id', tenantId)
        .select('id, slug, domain, primary_color, secondary_color, tagline, logo_url, header_logo_url, header_config, footer_config, branding_config, platform_branding')
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
