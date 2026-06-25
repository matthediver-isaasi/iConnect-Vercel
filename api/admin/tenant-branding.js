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
  "'Source Sans Pro', sans-serif",
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

// --- Portal sidebar (authenticated portal nav) branding validators ---
// branding_config.portalNav drives the authenticated-portal sidebar background,
// nav text/icon colours and active-item treatment (Layout.jsx). Every field is
// whitelisted/clamped here; anything unrecognised is dropped so the stored blob
// stays well-formed. Background field names mirror the canvas Hero/Section block
// so the same CSS builders (client/src/lib/canvasBackground.js) render both.
const ALLOWED_PORTAL_NAV_BG_TYPES = ['solid', 'image', 'gradient'];
const ALLOWED_PORTAL_NAV_OVERLAY_STYLES = ['solid', 'gradient'];
const ALLOWED_PORTAL_NAV_GRADIENT_TYPES = ['linear', 'radial'];
const ALLOWED_PORTAL_NAV_OVERLAY_DIRECTIONS = [
  'to-top', 'to-bottom', 'to-right', 'to-left', 'to-bottom-right', 'to-top-right', 'custom'
];
const PORTAL_NAV_IMAGE_URL_MAX = 2048;

function clampOpacity(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampAngle(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(360, Math.round(n)));
}

// Validate a multi-point stops array that may carry per-stop opacity (image
// overlay / gradient). Returns a sorted array of 2+ stops, or null.
function validatePortalNavStops(stops) {
  if (!Array.isArray(stops)) return null;
  const out = [];
  for (const s of stops) {
    if (!s || typeof s !== 'object') continue;
    const color = normalizeHexColor(s.color);
    if (!color) continue;
    const pos = Math.round(Number(s.position));
    const stop = { color, position: Number.isFinite(pos) ? Math.max(0, Math.min(100, pos)) : 0 };
    if (s.opacity !== undefined) stop.opacity = clampOpacity(s.opacity, 1);
    out.push(stop);
  }
  out.sort((a, b) => a.position - b.position);
  return out.length >= 2 ? out : null;
}

function validatePortalNavBackground(bg) {
  if (!bg || typeof bg !== 'object') return null;
  const type = ALLOWED_PORTAL_NAV_BG_TYPES.includes(bg.type) ? bg.type : 'solid';
  const out = { type };

  const solid = normalizeHexColor(bg.solidColor);
  if (solid) out.solidColor = solid;

  if (type === 'image') {
    if (typeof bg.imageUrl === 'string') {
      const url = bg.imageUrl.trim();
      if (/^https?:\/\//i.test(url) && url.length <= PORTAL_NAV_IMAGE_URL_MAX) {
        out.imageUrl = url;
      }
    }
    if (bg.focalPoint && typeof bg.focalPoint === 'object') {
      const fx = Math.round(Number(bg.focalPoint.x));
      const fy = Math.round(Number(bg.focalPoint.y));
      out.focalPoint = {
        x: Number.isFinite(fx) ? Math.max(0, Math.min(100, fx)) : 50,
        y: Number.isFinite(fy) ? Math.max(0, Math.min(100, fy)) : 50,
      };
    }
    out.overlayStyle = ALLOWED_PORTAL_NAV_OVERLAY_STYLES.includes(bg.overlayStyle) ? bg.overlayStyle : 'solid';
    out.darkWash = clampOpacity(bg.darkWash, 0.4);
    const ostops = validatePortalNavStops(bg.overlayStops);
    if (ostops) out.overlayStops = ostops;
    if (ALLOWED_PORTAL_NAV_OVERLAY_DIRECTIONS.includes(bg.overlayDirection)) {
      out.overlayDirection = bg.overlayDirection;
    }
    const oa = clampAngle(bg.overlayAngle);
    if (oa !== null) out.overlayAngle = oa;
  }

  if (type === 'gradient') {
    out.gradientType = ALLOWED_PORTAL_NAV_GRADIENT_TYPES.includes(bg.gradientType) ? bg.gradientType : 'linear';
    const gstops = validatePortalNavStops(bg.gradientStops);
    if (gstops) out.gradientStops = gstops;
    const ga = clampAngle(bg.gradientAngle);
    if (ga !== null) out.gradientAngle = ga;
  }

  return out;
}

function validatePortalNav(portalNav) {
  if (!portalNav || typeof portalNav !== 'object') return null;
  const out = {};
  const bg = validatePortalNavBackground(portalNav.background);
  if (bg) out.background = bg;
  // Authenticated-portal main content area background (solid/gradient/image).
  // Reuses the nav-pane bg validator. Whitelisted explicitly so it is not
  // dropped on save. For image type, solidColor is preserved as the base
  // colour rendered beneath the (possibly transparent) image.
  const pageBg = validatePortalNavBackground(portalNav.pageBackground);
  if (pageBg) out.pageBackground = pageBg;
  for (const key of ['textColor', 'iconColor', 'activeBackgroundColor', 'activeTextColor', 'activeIconColor', 'hoverBackgroundColor', 'hoverTextColor']) {
    const c = normalizeHexColor(portalNav[key]);
    if (c) out[key] = c;
  }
  // Current-user card (signed-in member box at the bottom of the sidebar):
  // its own background (solid/gradient, reusing the nav-pane bg validator) and
  // text colour. Whitelisted explicitly so it is not dropped on save.
  if (portalNav.userCard && typeof portalNav.userCard === 'object') {
    const uc = {};
    const ucBg = validatePortalNavBackground(portalNav.userCard.background);
    if (ucBg) uc.background = ucBg;
    const ucText = normalizeHexColor(portalNav.userCard.textColor);
    if (ucText) uc.textColor = ucText;
    if (Object.keys(uc).length > 0) out.userCard = uc;
  }
  return Object.keys(out).length > 0 ? out : null;
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

const HEADER_LINK_LABEL_MAX_LENGTH = 60;
const ALLOWED_HEADER_LINK_BORDER_STYLES = ['solid', 'dashed', 'dotted', 'none'];

// Validate a header action-link button config (Login / Member Area). Both share
// the same control set: button-vs-link, solid/gradient background,
// corner radius, border, label colour, height, width, plus a custom label.
// Positioning is handled by navigation items (the account Header Element), not here.
// `gradientValidator` is the handler-scoped validateGradientStops helper.
// Returns a sanitized object, or null when the input is not an object.
function sanitizeHeaderLink(link, gradientValidator) {
  if (!link || typeof link !== 'object') return null;

  const sanitized = {
    asButton: !!link.asButton,
    backgroundMode: link.backgroundMode === 'gradient' ? 'gradient' : 'solid'
  };

  if (typeof link.label === 'string') {
    const trimmedLabel = link.label.trim().slice(0, HEADER_LINK_LABEL_MAX_LENGTH);
    sanitized.label = trimmedLabel;
  }

  const solid = normalizeHexColor(link.solidColor);
  if (solid) {
    sanitized.solidColor = solid;
  }

  if (Array.isArray(link.gradientStops)) {
    const validatedStops = gradientValidator(link.gradientStops);
    if (validatedStops.length > 0) {
      sanitized.gradientStops = validatedStops;
    }
  }

  const radius = parseInt(link.cornerRadius, 10);
  if (Number.isFinite(radius)) {
    sanitized.cornerRadius = Math.max(0, Math.min(50, radius));
  }

  const borderWidth = parseInt(link.borderWidth, 10);
  if (Number.isFinite(borderWidth)) {
    sanitized.borderWidth = Math.max(0, Math.min(10, borderWidth));
  }

  const borderColor = normalizeHexColor(link.borderColor);
  if (borderColor) {
    sanitized.borderColor = borderColor;
  }

  const labelColor = normalizeHexColor(link.labelColor);
  if (labelColor) {
    sanitized.labelColor = labelColor;
  }

  const height = parseInt(link.height, 10);
  if (Number.isFinite(height)) {
    sanitized.height = Math.max(0, Math.min(200, height));
  }

  const width = parseInt(link.width, 10);
  if (Number.isFinite(width)) {
    sanitized.width = Math.max(0, Math.min(400, width));
  }

  if (ALLOWED_HEADER_LINK_BORDER_STYLES.includes(link.borderStyle)) {
    sanitized.borderStyle = link.borderStyle;
  }

  return sanitized;
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

      // Coerce the optional "shrink logo on scroll" toggle to a boolean so it
      // survives the merge below without leaking arbitrary values.
      if (updates.header_config && updates.header_config.logoShrinkOnScroll !== undefined) {
        updates.header_config.logoShrinkOnScroll = !!updates.header_config.logoShrinkOnScroll;
      }

      // Clamp the optional scrolled logo height (px). Drop empty/invalid input.
      if (updates.header_config && updates.header_config.logoScrolledHeight !== undefined) {
        const sh = parseInt(updates.header_config.logoScrolledHeight, 10);
        if (Number.isFinite(sh)) {
          updates.header_config.logoScrolledHeight = Math.max(10, Math.min(600, sh));
        } else {
          delete updates.header_config.logoScrolledHeight;
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

      // Validate the desktop top-row Search display mode. Governs appearance
      // only (icon / label / both); the on/off visibility is handled separately
      // by the Header Icons config. Drop anything outside the allowed set so it
      // falls back to the 'both' default.
      if (updates.header_config && updates.header_config.searchDisplay !== undefined) {
        if (['icon', 'label', 'both'].includes(updates.header_config.searchDisplay)) {
          // keep as-is
        } else {
          delete updates.header_config.searchDisplay;
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

      // Validate the login-link button config (logged-out "Login" state).
      // header_config is rebuilt from a whitelist, so each supported field must
      // be explicitly copied via sanitizeHeaderLink or it is dropped on save.
      if (updates.header_config && updates.header_config.loginLink !== undefined) {
        const sanitizedLoginLink = sanitizeHeaderLink(updates.header_config.loginLink, validateGradientStops);
        if (sanitizedLoginLink) {
          updates.header_config.loginLink = sanitizedLoginLink;
        } else {
          delete updates.header_config.loginLink;
        }
      }

      // Validate the member-area-link button config (logged-in "Member Area"
      // state). Mirrors the loginLink control set so it can be styled and
      // labelled independently.
      if (updates.header_config && updates.header_config.memberAreaLink !== undefined) {
        const sanitizedMemberAreaLink = sanitizeHeaderLink(updates.header_config.memberAreaLink, validateGradientStops);
        if (sanitizedMemberAreaLink) {
          updates.header_config.memberAreaLink = sanitizedMemberAreaLink;
        } else {
          delete updates.header_config.memberAreaLink;
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

      // Validate the portal sidebar branding block + base portal font that live
      // inside branding_config. Invalid/empty input is set to null (explicitly
      // clearing) rather than left untouched so the admin can reset to defaults.
      if (updates.branding_config && typeof updates.branding_config === 'object') {
        if (updates.branding_config.portalNav !== undefined) {
          updates.branding_config.portalNav = validatePortalNav(updates.branding_config.portalNav);
        }
        if (updates.branding_config.basePortalFont !== undefined) {
          updates.branding_config.basePortalFont = validateNavFontFamily(updates.branding_config.basePortalFont);
        }
        if (updates.branding_config.resourceCategoryTitleColor !== undefined) {
          updates.branding_config.resourceCategoryTitleColor = normalizeHexColor(updates.branding_config.resourceCategoryTitleColor);
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
