import { validateMicrositeHeaderLogoConfig } from '../../shared/micrositeHeaderLogo.js';

/**
 * Task #2426: tenant microsites — shared server-side helpers.
 *
 * A microsite is a group of public pages served under /{path_prefix}/{slug}
 * with its own header/footer/nav chrome. NULL microsite_id everywhere means
 * "default tenant site" so existing tenants see zero change.
 *
 * All helpers are legacy-tolerant: if the `microsite` table or the
 * `microsite_id` columns do not exist yet (undefined_table 42P01 /
 * undefined_column 42703 — e.g. the stale dev database), they degrade to
 * "no microsites" instead of erroring, so the default site keeps working.
 */

const MISSING_SCHEMA_CODES = new Set(['42P01', '42703']);

export function isMissingMicrositeSchema(error) {
  return !!error && MISSING_SCHEMA_CODES.has(error.code);
}

// Reserved first path segments that can never be used as a microsite prefix.
// Covers app shell routes, API namespaces, and public entity sections.
export const RESERVED_MICROSITE_PREFIXES = new Set([
  'api', 'admin', 'assets', 'static', 'public',
  'login', 'logout', 'signup', 'signin', 'register', 'auth', 'verify',
  'onboarding', 'reset-password', 'forgot-password',
  'events', 'event', 'eventdetails', 'complex-event', 'session-events',
  'articles', 'article', 'articleview', 'blog', 'news', 'newsview',
  'resources', 'publicresources', 'directory', 'members', 'member',
  'galleries', 'photogalleries', 'gallery', 'forum', 'forumthread',
  'jobs', 'jobdetails', 'vacancies', 'fundraise', 'campaign', 'campaigns',
  'formview', 'embedform', 'forms', 'form', 'book', 'booking',
  'inbox', 'help', 'search', 'sitemap.xml', 'robots.txt', 'favicon.ico',
  'dashboard', 'portal', 'profile', 'settings', 'account',
  'canvasbuilder', 'iedit', 'viewpage', 'pagebuilder',
  'www', 'app', 'dev', 'staging', 'preview',
]);

export const MICROSITE_PREFIX_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/**
 * Validate a candidate path prefix. Returns { ok: true } or
 * { ok: false, error } with a human-readable reason.
 */
export function validateMicrositePrefix(prefix) {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return { ok: false, error: 'Path prefix is required' };
  if (p.length < 2 || p.length > 50) {
    return { ok: false, error: 'Path prefix must be 2-50 characters' };
  }
  if (!MICROSITE_PREFIX_REGEX.test(p)) {
    return { ok: false, error: 'Path prefix may only contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen' };
  }
  if (RESERVED_MICROSITE_PREFIXES.has(p)) {
    return { ok: false, error: `"${p}" is a reserved route and cannot be used as a microsite prefix` };
  }
  return { ok: true };
}

/**
 * Look up an ACTIVE microsite by its path prefix for a tenant.
 * Returns the row or null (including when the schema is missing).
 */
export async function resolveMicrositeByPrefix(supabase, tenantId, prefix) {
  if (!supabase || !tenantId || !prefix) return null;
  const { data, error } = await supabase
    .from('microsite')
    .select('id, tenant_id, name, path_prefix, description, is_active, logo_url, header_config, footer_config, branding_config, home_page_id')
    .eq('tenant_id', tenantId)
    .eq('path_prefix', String(prefix).toLowerCase())
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    if (!isMissingMicrositeSchema(error)) {
      console.error('[Microsites] prefix lookup failed:', error.message || error.code);
    }
    return null;
  }
  return data || null;
}

/**
 * List ACTIVE microsites for a tenant. Returns [] when none / schema missing.
 */
export async function listActiveMicrosites(supabase, tenantId) {
  if (!supabase || !tenantId) return [];
  const { data, error } = await supabase
    .from('microsite')
    .select('id, name, path_prefix, is_active, logo_url, home_page_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) {
    if (!isMissingMicrositeSchema(error)) {
      console.error('[Microsites] list failed:', error.message || error.code);
    }
    return [];
  }
  return data || [];
}

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

/**
 * Merge a microsite config over the tenant config, key-by-key. Any microsite
 * key left empty (null / '' / [] / {}) falls back to the tenant value —
 * per-spec: "Fall back to tenant configs for any microsite field left empty."
 */
export function mergeMicrositeConfig(tenantConfig, micrositeConfig) {
  const base = (tenantConfig && typeof tenantConfig === 'object') ? tenantConfig : {};
  const over = (micrositeConfig && typeof micrositeConfig === 'object') ? micrositeConfig : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (!isEmptyValue(value)) merged[key] = value;
  }
  return merged;
}

/**
 * PATCH requests merge header_config by default so a focused update cannot
 * erase unrelated chrome settings. The full microsite chrome editor opts into
 * replacement because its Override switches intentionally remove managed keys.
 */
export function resolveMicrositeHeaderConfigUpdate(existingConfig, submittedConfig, replace = false) {
  const existing = existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
    ? existingConfig
    : {};
  const submitted = submittedConfig && typeof submittedConfig === 'object' && !Array.isArray(submittedConfig)
    ? submittedConfig
    : {};
  if (replace) return { ...submitted };
  const merged = { ...existing };
  const nullableLogoKeys = new Set([
    'logoHeight',
    'logoWidth',
    'logoShrinkOnScroll',
    'logoScrolledHeight',
  ]);
  for (const [key, value] of Object.entries(submitted)) {
    if (nullableLogoKeys.has(key) && (value === null || value === '')) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Task #2525: whitelisted per-microsite branding override keys stored in
 * microsite.branding_config. Anything else sent by a client is dropped.
 * Custom social SVGs (socialIconCustomSvgs) intentionally stay tenant-only.
 */
export const MICROSITE_BRANDING_KEYS = [
  'primary_color',
  'secondary_color',
  'logo_url',
  'header_logo_url',
  'social_image_url',
  'tagline',
  'description',
  'headerSocialIconColor',
  'footerSocialIconColor',
  // Search results page overrides (Task #2628): base font + single type-label
  // colour. Validated/normalised further by normalizeSearchResultsBranding.
  'searchResultsFont',
  'searchResultsTypeLabelColor',
];

/**
 * Task #2628: normalise the search-results branding overrides stored inside a
 * microsite's branding_config in place. `searchResultsTypeLabelColor` is
 * normalised to an uppercased hex string (dropped when malformed);
 * `searchResultsFont` is kept only when it is one of the tenant's allowed font
 * families. `allowedFonts` is a Set of permitted font-family strings (system
 * stacks + the tenant's installed fonts). Mirrors the tenant branding
 * endpoint's validation so both scopes behave identically.
 */
export function normalizeSearchResultsBranding(brandingConfig, allowedFonts) {
  if (!brandingConfig || typeof brandingConfig !== 'object') return brandingConfig;
  if (brandingConfig.searchResultsTypeLabelColor !== undefined) {
    const raw = String(brandingConfig.searchResultsTypeLabelColor || '').trim();
    if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(raw)) {
      brandingConfig.searchResultsTypeLabelColor = raw.toUpperCase();
    } else {
      delete brandingConfig.searchResultsTypeLabelColor;
    }
  }
  if (brandingConfig.searchResultsFont !== undefined) {
    const fam = String(brandingConfig.searchResultsFont || '').trim();
    if (!fam || !(allowedFonts instanceof Set) || !allowedFonts.has(fam)) {
      delete brandingConfig.searchResultsFont;
    } else {
      brandingConfig.searchResultsFont = fam;
    }
  }
  return brandingConfig;
}

// Always-allowed base font stacks (kept in sync with the tenant branding
// endpoint's ALLOWED_SYSTEM_FONT_FAMILIES). Merged with the tenant's installed
// fonts to build the set a microsite may save.
const ALLOWED_SYSTEM_FONT_FAMILIES = [
  'Poppins, sans-serif',
  'Urbanist, sans-serif',
  "'Degular Medium', 'Poppins', sans-serif",
  "'Source Sans Pro', sans-serif",
  'Georgia, serif',
  'Arial, sans-serif',
  "'Times New Roman', serif",
];

/**
 * Build the Set of font-family stacks a tenant may save: the always-on system
 * stacks plus every font_stack in the tenant's installed_font table. Degrades
 * to just the system stacks when the table/query fails.
 */
export async function resolveAllowedFontFamilies(supabase, tenantId) {
  const allowed = new Set(ALLOWED_SYSTEM_FONT_FAMILIES);
  if (!supabase || !tenantId) return allowed;
  try {
    const { data, error } = await supabase
      .from('installed_font')
      .select('font_stack')
      .eq('tenant_id', tenantId);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const stack = (row && typeof row.font_stack === 'string') ? row.font_stack.trim() : '';
        if (stack) allowed.add(stack);
      }
    }
  } catch (err) {
    console.error('[Microsites] resolveAllowedFontFamilies error:', err?.message);
  }
  return allowed;
}

/**
 * Task #2561: max number of Canvas colour swatches stored per scope
 * (tenant or microsite). Keeps the branding_config JSON blob bounded.
 */
export const MAX_CANVAS_SWATCHES = 48;

/**
 * Task #2698: max length of an optional per-swatch label. Labels are trimmed
 * and truncated to this length; longer input is silently capped.
 */
export const MAX_CANVAS_SWATCH_LABEL_LEN = 60;

/**
 * Normalise a submitted Canvas swatch list to an array of well-formed,
 * de-duplicated `{ hex, label }` entries, capped at MAX_CANVAS_SWATCHES.
 * `hex` is uppercased/validated; `label` is an optional, trimmed, length-capped
 * string (defaults to ''). Anything invalid is dropped. Order is preserved
 * (swatch reordering is a supported action). Shared by the tenant branding
 * endpoint and the microsite endpoint so both scopes validate identically.
 *
 * Task #2698: backward compatible — legacy entries stored as plain hex strings
 * are accepted and normalised to `{ hex, label: '' }`.
 */
export function normalizeCanvasSwatches(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    let hexSrc = null;
    let labelSrc = '';
    if (typeof raw === 'string') {
      hexSrc = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      hexSrc = raw.hex;
      labelSrc = raw.label;
    } else {
      continue;
    }
    if (typeof hexSrc !== 'string') continue;
    const trimmed = hexSrc.trim();
    if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(trimmed)) continue;
    const hex = trimmed.toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    const label = typeof labelSrc === 'string'
      ? labelSrc.trim().slice(0, MAX_CANVAS_SWATCH_LABEL_LEN)
      : '';
    out.push({ hex, label });
    if (out.length >= MAX_CANVAS_SWATCHES) break;
  }
  return out;
}

/**
 * Keep only whitelisted, non-empty string values from a submitted
 * branding_config object. Returns a plain object (possibly empty).
 *
 * Task #2561/#2698: `canvas_swatches` (an array of `{ hex, label }` entries
 * powering the Canvas colour palette for this microsite) is preserved here too
 * — it is the one non-string key allowed through the sanitizer.
 */
export function sanitizeMicrositeBrandingConfig(value) {
  const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const out = {};
  for (const key of MICROSITE_BRANDING_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  if (src.canvas_swatches !== undefined) {
    const swatches = normalizeCanvasSwatches(src.canvas_swatches);
    if (swatches.length > 0) out.canvas_swatches = swatches;
  }
  return out;
}

export { validateMicrositeHeaderLogoConfig };

/**
 * Return the microsite's branding override for `key`, or null when the
 * microsite doesn't override it (caller falls back to the tenant value).
 */
export function micrositeBrandingValue(microsite, key) {
  const cfg = microsite?.branding_config;
  if (!cfg || typeof cfg !== 'object') return null;
  const v = cfg[key];
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
}
