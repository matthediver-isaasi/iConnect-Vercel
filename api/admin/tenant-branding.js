import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
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

const ALLOWED_NAV_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const ALLOWED_NAV_FONT_FAMILIES = [
  'Poppins, sans-serif',
  'Urbanist, sans-serif',
  "'Degular Medium', 'Poppins', sans-serif",
  'Georgia, serif',
  'Arial, sans-serif',
  "'Times New Roman', serif"
];

function validateNavFontWeight(weight) {
  const n = parseInt(weight, 10);
  return ALLOWED_NAV_FONT_WEIGHTS.includes(n) ? n : null;
}

function validateNavFontFamily(family) {
  return (typeof family === 'string' && ALLOWED_NAV_FONT_FAMILIES.includes(family)) ? family : null;
}

// Validate a per-bar active-indicator config. `gradientValidator` is the
// handler-scoped validateGradientStops helper. Returns a sanitized object or
// null when the input is not an object.
function validateIndicatorConfig(indicator, gradientValidator) {
  if (!indicator || typeof indicator !== 'object') return null;
  const out = { enabled: !!indicator.enabled };
  const h = parseInt(indicator.height, 10);
  if (Number.isFinite(h)) {
    out.height = Math.max(1, Math.min(50, h));
  }
  if (Array.isArray(indicator.gradientStops)) {
    const stops = gradientValidator(indicator.gradientStops);
    if (stops.length > 0) {
      out.gradientStops = stops;
    }
  }
  return out;
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

  // Resolve tenant via the shared tenant-context helper so we support both
  // tenant_user (admin dashboard) sessions and member sessions with admin
  // permissions. Hard-fail without a tenant context per the strict-tenant rule.
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!context.tenantId) {
    return res.status(400).json({ error: 'Tenant context not found' });
  }

  const tenantId = context.tenantId;

  if (req.method === 'GET') {
    try {
      const { data: tenant, error } = await supabase
        .from('tenant')
        .select('id, primary_color, secondary_color, tagline, description, social_image_url, logo_url, header_logo_url, header_config, footer_config, branding_config, platform_branding')
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
    // PATCH requires admin-level access in the same tenant (tenant_user OR
    // member with admin role permissions).
    const isAdmin = await hasAdminAccess(context);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const allowedFields = [
        'primary_color',
        'secondary_color', 
        'tagline',
        'description',
        'social_image_url',
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

      const validateGradientStops = (stops) => {
        const validatedStops = [];
        for (const stop of stops) {
          if (typeof stop === 'object' && stop.color && typeof stop.position === 'number') {
            const normalized = normalizeHexColor(stop.color);
            if (normalized) {
              const position = Math.max(0, Math.min(100, Math.round(stop.position)));
              validatedStops.push({ color: normalized, position });
            }
          }
        }
        validatedStops.sort((a, b) => a.position - b.position);
        return validatedStops;
      };

      if (updates.header_config?.gradientStops) {
        const validatedStops = validateGradientStops(updates.header_config.gradientStops);
        if (validatedStops.length > 0) {
          updates.header_config.gradientStops = validatedStops;
        }
      }

      // Clamp top navigation bar height (px) to a sensible range
      if (updates.header_config && updates.header_config.topBarHeight !== undefined) {
        const h = parseInt(updates.header_config.topBarHeight, 10);
        if (Number.isFinite(h)) {
          updates.header_config.topBarHeight = Math.max(20, Math.min(300, h));
        } else {
          delete updates.header_config.topBarHeight;
        }
      }

      // Validate top-nav link text color
      if (updates.header_config && updates.header_config.topNavTextColor !== undefined) {
        const tc = normalizeHexColor(updates.header_config.topNavTextColor);
        if (tc) {
          updates.header_config.topNavTextColor = tc;
        } else {
          delete updates.header_config.topNavTextColor;
        }
      }

      // Clamp top-nav link font size (px) to a sensible range
      if (updates.header_config && updates.header_config.topNavFontSize !== undefined) {
        const tf = parseInt(updates.header_config.topNavFontSize, 10);
        if (Number.isFinite(tf)) {
          updates.header_config.topNavFontSize = Math.max(8, Math.min(48, tf));
        } else {
          delete updates.header_config.topNavFontSize;
        }
      }

      // Validate top-nav link hover color
      if (updates.header_config && updates.header_config.topNavHoverColor !== undefined) {
        const hc = normalizeHexColor(updates.header_config.topNavHoverColor);
        if (hc) {
          updates.header_config.topNavHoverColor = hc;
        } else {
          delete updates.header_config.topNavHoverColor;
        }
      }

      // Validate top-nav link font weight against the allowed weight scale
      if (updates.header_config && updates.header_config.topNavFontWeight !== undefined) {
        const fw = validateNavFontWeight(updates.header_config.topNavFontWeight);
        if (fw) {
          updates.header_config.topNavFontWeight = fw;
        } else {
          delete updates.header_config.topNavFontWeight;
        }
      }

      // Validate top-nav base font family against the installed-font list
      if (updates.header_config && updates.header_config.topNavFontFamily !== undefined) {
        const ff = validateNavFontFamily(updates.header_config.topNavFontFamily);
        if (ff) {
          updates.header_config.topNavFontFamily = ff;
        } else {
          delete updates.header_config.topNavFontFamily;
        }
      }

      // Validate top-nav active-item indicator config
      if (updates.header_config && updates.header_config.topNavIndicator !== undefined) {
        const ind = validateIndicatorConfig(updates.header_config.topNavIndicator, validateGradientStops);
        if (ind) {
          updates.header_config.topNavIndicator = ind;
        } else {
          delete updates.header_config.topNavIndicator;
        }
      }

      // Validate the secondary (lower) navigation bar config
      if (updates.header_config && updates.header_config.secondaryBar !== undefined) {
        const sb = updates.header_config.secondaryBar;
        if (sb && typeof sb === 'object') {
          const sanitizedSecondaryBar = { enabled: !!sb.enabled };

          const sh = parseInt(sb.height, 10);
          if (Number.isFinite(sh)) {
            sanitizedSecondaryBar.height = Math.max(20, Math.min(300, sh));
          }

          if (Array.isArray(sb.gradientStops)) {
            const validatedSecondaryStops = validateGradientStops(sb.gradientStops);
            if (validatedSecondaryStops.length > 0) {
              sanitizedSecondaryBar.gradientStops = validatedSecondaryStops;
            }
          }

          const stc = normalizeHexColor(sb.textColor);
          if (stc) {
            sanitizedSecondaryBar.textColor = stc;
          }

          const sf = parseInt(sb.fontSize, 10);
          if (Number.isFinite(sf)) {
            sanitizedSecondaryBar.fontSize = Math.max(8, Math.min(48, sf));
          }

          const shc = normalizeHexColor(sb.hoverColor);
          if (shc) {
            sanitizedSecondaryBar.hoverColor = shc;
          }

          const sfw = validateNavFontWeight(sb.fontWeight);
          if (sfw) {
            sanitizedSecondaryBar.fontWeight = sfw;
          }

          const sff = validateNavFontFamily(sb.fontFamily);
          if (sff) {
            sanitizedSecondaryBar.fontFamily = sff;
          }

          const sInd = validateIndicatorConfig(sb.indicator, validateGradientStops);
          if (sInd) {
            sanitizedSecondaryBar.indicator = sInd;
          }

          updates.header_config.secondaryBar = sanitizedSecondaryBar;
        } else {
          delete updates.header_config.secondaryBar;
        }
      }

      // Validate the login-link button config. header_config is rebuilt from a
      // whitelist, so this block must explicitly copy each supported field or it
      // is silently dropped on save.
      if (updates.header_config && updates.header_config.loginLink !== undefined) {
        const ll = updates.header_config.loginLink;
        if (ll && typeof ll === 'object') {
          const sanitizedLoginLink = {
            asButton: !!ll.asButton,
            backgroundMode: ll.backgroundMode === 'gradient' ? 'gradient' : 'solid',
            position: ll.position === 'right' ? 'right' : 'left'
          };

          const llSolid = normalizeHexColor(ll.solidColor);
          if (llSolid) {
            sanitizedLoginLink.solidColor = llSolid;
          }

          if (Array.isArray(ll.gradientStops)) {
            const validatedLoginStops = validateGradientStops(ll.gradientStops);
            if (validatedLoginStops.length > 0) {
              sanitizedLoginLink.gradientStops = validatedLoginStops;
            }
          }

          const llRadius = parseInt(ll.cornerRadius, 10);
          if (Number.isFinite(llRadius)) {
            sanitizedLoginLink.cornerRadius = Math.max(0, Math.min(50, llRadius));
          }

          const llBorderWidth = parseInt(ll.borderWidth, 10);
          if (Number.isFinite(llBorderWidth)) {
            sanitizedLoginLink.borderWidth = Math.max(0, Math.min(10, llBorderWidth));
          }

          const llBorderColor = normalizeHexColor(ll.borderColor);
          if (llBorderColor) {
            sanitizedLoginLink.borderColor = llBorderColor;
          }

          const ALLOWED_BORDER_STYLES = ['solid', 'dashed', 'dotted', 'none'];
          if (ALLOWED_BORDER_STYLES.includes(ll.borderStyle)) {
            sanitizedLoginLink.borderStyle = ll.borderStyle;
          }

          updates.header_config.loginLink = sanitizedLoginLink;
        } else {
          delete updates.header_config.loginLink;
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
        .select('id, slug, domain, primary_color, secondary_color, tagline, description, social_image_url, logo_url, header_logo_url, header_config, footer_config, branding_config, platform_branding')
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
