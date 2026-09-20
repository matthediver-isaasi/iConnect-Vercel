import { matchesRegisteredRoute } from '../../shared/registeredRoutes.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { isReservedMemberSlug } from '../../shared/memberAliases.js';

export function normalizeRoutePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\x00-\x20]/.test(value)) throw new Error('Invalid route path');
  const path = value.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  // Malformed encodings are errors, never proof of absence.
  decodeURIComponent(path);
  return path;
}

export function excludedRoute(path) {
  return path === '/' || /^\/(?:api|assets|@vite|@fs|src|node_modules|\.well-known)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:callback|webhook)(?:\/|$)/i.test(path)
    || /\.(?:js|mjs|css|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|pdf|zip|mp[34]|webm|wav)$/i.test(path);
}

async function rows(query) {
  const result = await query;
  if (result.error) throw new Error('Route lookup failed', { cause: result.error });
  return result.data || [];
}

const slugify = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export async function resolveRouteOutcome(db, tenant, input) {
  const path = normalizeRoutePath(input);
  if (excludedRoute(path) || matchesRegisteredRoute(path)) return 'existing';
  const parts = path.slice(1).split('/').map(decodeURIComponent);
  const settings = await rows(db.from('system_settings').select('setting_key, setting_value')
    .eq('tenant_id', tenant.id).in('setting_key', ['article_display_name', 'article_url_slug', 'member_display_name']));
  const values = Object.fromEntries(settings.map(row => [row.setting_key, row.setting_value]));
  const article = slugify(values.article_display_name || 'Articles');
  const articleRoots = [article, String(values.article_url_slug || '').replace(/^\/+/, '').toLowerCase()].filter(Boolean);
  const first = parts[0].toLowerCase();
  if ((parts.length === 1 && [article, `${article}view`, `${article}editor`, `my${article}`, `public${article}`].includes(first))
    || (parts.length === 3 && articleRoots.includes(first))) return 'existing';
  let plural = values.member_display_name;
  try { plural = JSON.parse(plural)?.plural; } catch { /* Legacy plain-string plural. */ }
  const member = slugify(plural);
  if (member && !isReservedMemberSlug(member) && first === member && parts.length <= 2) return 'existing';
  if (parts.length > 2) return 'missing';

  const microsites = await rows(db.from('microsite').select('id, path_prefix')
    .eq('tenant_id', tenant.id).eq('is_active', true).eq('path_prefix', first));
  const microsite = microsites[0];
  if (parts.length === 1 && microsite) return 'existing';
  if (parts.length === 2 && !microsite) return 'missing';
  if (microsite && parts[1]?.toLowerCase() === 'search') return 'existing';
  let pageQuery = db.from('i_edit_page').select('id, status, layout_type')
    .eq('tenant_id', tenant.id).eq('slug', parts.at(-1));
  pageQuery = microsite ? pageQuery.eq('microsite_id', microsite.id) : pageQuery.is('microsite_id', null);
  const pages = await rows(pageQuery);
  if (pages.length) {
    // A draft or protected page is not evidence of a missing URL.
    return pages[0].status !== 'published' || pages[0].layout_type === 'member' ? 'restricted' : 'existing';
  }
  if (parts.length === 2) return 'missing';
  const forms = await rows(db.from('form').select('id, is_active, deactivate_at, require_authentication, access_policy, form_type, survey_settings')
    .eq('tenant_id', tenant.id).eq('slug', parts[0]).eq('is_active', true));
  const form = forms.find(row => isFormScheduleAvailable(row));
  if (!form) return 'missing';
  // Preserve all active forms, including surveys and access-policy gates;
  // only their own access resolver may decide whether a viewer can enter.
  return form.require_authentication || form.access_policy || form.form_type === 'survey' ? 'restricted' : 'existing';
}

export function safeRedirectTarget(target, source) {
  if (typeof target !== 'string' || !target || /[\\\x00-\x20]/.test(target)
    || target.startsWith('//')) return null;
  if (!target.startsWith('/') && !/^https?:\/\//i.test(target)) return null;
  try {
    const url = new URL(target, 'https://route.invalid');
    if (url.username || url.password) return null;
    if (url.origin === 'https://route.invalid' && normalizeRoutePath(url.pathname).toLowerCase() === source.toLowerCase()) return null;
    return target;
  } catch { return null; }
}

export async function resolveUnknownPagePolicy(db, tenant, input, trail = []) {
  const path = normalizeRoutePath(input);
  const key = path.toLowerCase();
  if (trail.includes(key) || trail.length >= 8) throw new Error('Redirect loop detected');
  const route_outcome = await resolveRouteOutcome(db, tenant, path);
  if (route_outcome !== 'missing') return { found: false, route_outcome };
  const mappings = await rows(db.from('redirect_mapping').select('source_pattern, target_url, match_type, status_code')
    .eq('tenant_id', tenant.id).eq('is_active', true).order('priority', { ascending: true }));
  for (const mapping of mappings) {
    let target = null;
    const pattern = '/' + String(mapping.source_pattern || '').replace(/^\/+|\/+$/g, '');
    if (mapping.match_type === 'exact' && path.toLowerCase() === pattern.toLowerCase()) target = mapping.target_url;
    if (mapping.match_type === 'prefix' && path.toLowerCase().startsWith(pattern.toLowerCase())) {
      target = mapping.target_url?.endsWith('*') ? mapping.target_url.slice(0, -1) + path.slice(pattern.length) : mapping.target_url;
    }
    if (mapping.match_type === 'regex') {
      try {
        const regex = new RegExp(mapping.source_pattern, 'i');
        if (regex.test(path)) target = path.replace(regex, mapping.target_url);
      } catch { /* Invalid saved rules are ignored, as in the legacy resolver. */ }
    }
    if (target !== null) {
      target = safeRedirectTarget(target, path);
      // Invalid matching configuration must not turn into a homepage redirect.
      if (!target) throw new Error('Unsafe redirect target');
      // Validate local chains before emitting the first hop. Home is excluded,
      // so the default fallback cannot recurse through the homepage itself.
      const targetUrl = new URL(target, 'https://route.invalid');
      const targetHost = targetUrl.hostname.replace(/^www\./, '').toLowerCase();
      const localTarget = target.startsWith('/') || targetHost === String(tenant.domain || '').replace(/^www\./, '').toLowerCase()
        || targetHost === `${tenant.slug}.iconn.app`
        || ['dev', 'testing', 'preview', 'staging'].some(env => targetHost === `${tenant.slug}.${env}.iconn.app`);
      if (localTarget) {
        await resolveUnknownPagePolicy(db, tenant, targetUrl.pathname, [...trail, key]);
      }
      return { found: true, route_outcome, target_url: target,
        status_code: [301, 302, 307, 308].includes(mapping.status_code) ? mapping.status_code : 301 };
    }
  }
  // Tenant host resolution is cached across requests. Re-read this kill switch
  // at the decision point so disabling it works across server instances.
  const freshTenant = await rows(db.from('tenant').select('id, settings')
    .eq('id', tenant.id).eq('status', 'active'));
  if (freshTenant.length !== 1) throw new Error('Tenant settings could not be resolved');
  return freshTenant[0].settings?.redirect_unknown_pages_to_homepage === true
    ? { found: true, route_outcome, target_url: '/', status_code: 302 }
    : { found: false, route_outcome };
}