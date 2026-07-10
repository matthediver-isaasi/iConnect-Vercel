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
];

/**
 * Task #2561: max number of Canvas colour swatches stored per scope
 * (tenant or microsite). Keeps the branding_config JSON blob bounded.
 */
export const MAX_CANVAS_SWATCHES = 48;

/**
 * Normalise a submitted Canvas swatch list to an array of well-formed,
 * uppercased, de-duplicated hex-colour strings, capped at
 * MAX_CANVAS_SWATCHES. Anything invalid is dropped. Order is preserved
 * (swatch reordering is a supported action). Shared by the tenant branding
 * endpoint and the microsite endpoint so both scopes validate identically.
 */
export function normalizeCanvasSwatches(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(trimmed)) continue;
    const hex = trimmed.toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
    if (out.length >= MAX_CANVAS_SWATCHES) break;
  }
  return out;
}

/**
 * Keep only whitelisted, non-empty string values from a submitted
 * branding_config object. Returns a plain object (possibly empty).
 *
 * Task #2561: `canvas_swatches` (an array of hex strings powering the Canvas
 * colour palette for this microsite) is preserved here too — it is the one
 * non-string key allowed through the sanitizer.
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
