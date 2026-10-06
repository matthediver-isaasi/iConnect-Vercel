import { matchesRegisteredRoute } from '../../shared/registeredRoutes.js';

async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error('Homepage lookup failed', { cause: error });
  return data || [];
}

// An explicitly cleared modern setting wins over the legacy setting.
export async function readHomepageSlug(db, tenantId) {
  const settings = await rows(db.from('system_settings').select('setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', 'public_home_page_slug'));
  if (settings.length > 1) throw new Error('Ambiguous homepage setting');
  if (settings.length) return settings[0].setting_value || '';
  const tenants = await rows(db.from('tenant').select('settings').eq('id', tenantId));
  if (tenants.length !== 1) throw new Error('Homepage tenant unavailable');
  return tenants[0].settings?.home_page_slug || '';
}

export async function resolveHomepage(db, tenant) {
  try {
    const slug = await readHomepageSlug(db, tenant.id);
    if (!slug) return { state: 'absent' };
    if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(slug))
      return { state: 'invalid' };
    const pages = await rows(db.from('i_edit_page')
      .select('id, slug, status, layout_type, microsite_id')
      .eq('tenant_id', tenant.id).eq('slug', slug).is('microsite_id', null));
    const page = pages[0];
    if (pages.length !== 1 || page.status !== 'published' ||
      !['public', 'hybrid'].includes(page.layout_type)) return { state: 'invalid' };
    return { state: 'selected', slug, page };
  } catch {
    return { state: 'error' };
  }
}

export async function homepageRoute(db, tenant, input) {
  const url = new URL(input, 'https://homepage.invalid');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && !/^\/[^/]+$/.test(path)) return { state: 'unrelated' };
  if (url.searchParams.has('_canvasPreview')) return { state: 'preview' };
  const home = await resolveHomepage(db, tenant);
  if (home.state !== 'selected') return home;
  if (path === '/') return { ...home, root: true };
  const segment = decodeURIComponent(path.slice(1));
  const alias = /^(Home|home)$/.test(segment);
  if (!alias && segment !== home.slug) return { ...home };
  // Registered routes and active microsites own their paths, even when a CMS
  // page happens to use the same slug.
  if (!alias && matchesRegisteredRoute(path)) return home;
  const microsites = await rows(db.from('microsite').select('id')
    .eq('tenant_id', tenant.id).eq('is_active', true).eq('path_prefix', segment.toLowerCase()));
  if (microsites.length) return home;
  const settings = await rows(db.from('system_settings').select('setting_key, setting_value')
    .eq('tenant_id', tenant.id).in('setting_key', ['article_display_name', 'article_url_slug', 'member_display_name']));
  const values = Object.fromEntries(settings.map(row => [row.setting_key, row.setting_value]));
  let member = values.member_display_name;
  try { member = JSON.parse(member)?.plural; } catch {}
  const clean = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!alias && [values.article_display_name || 'Articles', values.article_url_slug, member]
    .filter(Boolean).some(value => clean(value) === segment.toLowerCase())) return home;
  return { ...home, target: `/${url.search}${url.hash}` };
}
