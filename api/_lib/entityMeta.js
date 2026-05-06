import { supabase } from './database.js';
import { getArticleUrlConfig } from './articleUrlPaths.js';

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, max = 200) {
  if (!str) return '';
  const s = String(str).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function parsePath(req) {
  // Header precedence: x-original-uri / x-forwarded-uri can include the
  // query string; x-vercel-original-pathname is pathname-only. Pick the
  // best-available pathname source, then fall back to req.url's query
  // when the chosen source lacks one.
  const fullUri = req.headers['x-original-uri'] || req.headers['x-forwarded-uri'] || null;
  const pathOnly = req.headers['x-vercel-original-pathname'] || null;
  const reqUrl = req.url || '/';

  let pathname = '/';
  let search = '';

  if (fullUri) {
    const [p, q = ''] = fullUri.split('?');
    pathname = p || '/';
    search = q;
  } else if (pathOnly) {
    pathname = pathOnly;
  } else {
    let raw = reqUrl;
    if (/^\/api\/render(\?|$)/i.test(raw)) raw = '/';
    const [p, q = ''] = raw.split('?');
    pathname = p || '/';
    search = q;
  }

  // If the picked source had no query, merge in req.url's query (Vercel
  // rewrites preserve the original query on req.url even when the path is
  // rewritten to /api/render).
  if (!search && reqUrl.includes('?')) {
    search = reqUrl.split('?').slice(1).join('?');
  }

  return { pathname, search };
}

function getQueryParam(search, key) {
  if (!search) return null;
  try {
    const params = new URLSearchParams(search);
    return params.get(key);
  } catch {
    return null;
  }
}

async function resolveEvent(tenantId, { id, slug }) {
  if (!supabase || (!id && !slug)) return null;
  let q = supabase
    .from('event')
    .select('id, title, slug, summary, description, image_url, start_date, location, status, tenant_id')
    .eq('tenant_id', tenantId)
    .in('status', ['published', 'tbc']);
  if (slug) q = q.eq('slug', slug);
  else q = q.eq('id', id);
  let { data, error } = await q.maybeSingle();
  if (error?.code === '42703') {
    let fb = supabase
      .from('event')
      .select('id, title, slug, summary, description, image_url, start_date, location, status')
      .in('status', ['published', 'tbc']);
    if (slug) fb = fb.eq('slug', slug);
    else fb = fb.eq('id', id);
    const r = await fb.maybeSingle();
    data = r.data;
  }
  if (!data) return null;
  const dateStr = data.start_date
    ? new Date(data.start_date).toLocaleDateString('en-GB', { dateStyle: 'long' })
    : '';
  const descBase = stripHtml(data.summary || data.description);
  const description = truncate(
    [dateStr, data.location, descBase].filter(Boolean).join(' · '),
    300
  );
  return {
    title: data.title,
    description,
    image: data.image_url || null,
    canonicalPath: data.slug ? `/events/${data.slug}` : `/EventDetails?id=${data.id}`,
  };
}

async function resolveBlogPostBySlug(tenantId, slug, authorHandle, articleBasePath) {
  if (!supabase || !slug) return null;
  let q = supabase
    .from('blog_post')
    .select(
      'id, title, slug, summary, content, feature_image_url, status, tenant_id, author_id, guest_writer_id'
    )
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .or(`slug.eq.${slug},slug.like.${slug}-by-%`);
  let resolvedAuthorHandle = authorHandle || null;
  if (authorHandle && authorHandle !== 'guest') {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('handle', authorHandle)
      .maybeSingle();
    if (!member) return null;
    q = q.eq('author_id', member.id);
  } else if (authorHandle === 'guest') {
    q = q.not('guest_writer_id', 'is', null);
  }
  const { data } = await q.maybeSingle();
  if (!data) return null;

  // For legacy /ArticleView?slug=… we don't know the author handle up
  // front. Look it up so we can produce a stable canonical folder URL.
  if (!resolvedAuthorHandle) {
    if (data.author_id) {
      const { data: author } = await supabase
        .from('member')
        .select('handle')
        .eq('id', data.author_id)
        .maybeSingle();
      if (author?.handle) resolvedAuthorHandle = author.handle;
    } else if (data.guest_writer_id) {
      resolvedAuthorHandle = 'guest';
    }
  }

  const result = {
    title: data.title,
    description: truncate(stripHtml(data.summary || data.content), 300),
    image: data.feature_image_url || null,
  };
  if (articleBasePath && resolvedAuthorHandle) {
    result.canonicalPath = `${articleBasePath}/${encodeURIComponent(resolvedAuthorHandle)}/${encodeURIComponent(data.slug)}`;
  }
  return result;
}

async function resolveNews(tenantId, slug) {
  if (!supabase || !slug) return null;
  const { data } = await supabase
    .from('news_post')
    .select('id, title, slug, summary, content, feature_image_url')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (!data) return null;
  return {
    title: data.title,
    description: truncate(stripHtml(data.summary || data.content), 300),
    image: data.feature_image_url || null,
    canonicalPath: `/NewsView?slug=${encodeURIComponent(data.slug)}`,
  };
}

async function resolveForm(tenantId, slug) {
  if (!supabase || !slug) return null;
  const { data } = await supabase
    .from('form')
    .select('id, name, slug, description, is_active')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  return {
    title: data.name,
    description: truncate(stripHtml(data.description), 300),
    image: null,
    canonicalPath: `/FormView?slug=${encodeURIComponent(data.slug)}`,
  };
}

/**
 * Resolve per-page metadata for the request URL on the given tenant.
 * Returns { title, description, image, canonicalPath } or null when no
 * known entity matches the path. Callers should fall back to tenant
 * defaults for any null fields.
 */
export async function resolveEntityMeta(req, tenant) {
  if (!tenant?.id || !supabase) return null;
  const { pathname, search } = parsePath(req);

  try {
    // Events
    const eventSlugMatch = pathname.match(/^\/events\/([^/]+)\/?$/i);
    if (eventSlugMatch) {
      return await resolveEvent(tenant.id, {
        slug: decodeURIComponent(eventSlugMatch[1]),
      });
    }
    if (/^\/EventDetails\/?$/i.test(pathname)) {
      const id = getQueryParam(search, 'id');
      if (id) return await resolveEvent(tenant.id, { id });
    }

    // Public forms
    if (/^\/FormView\/?$/i.test(pathname)) {
      const slug = getQueryParam(search, 'slug');
      if (slug) return await resolveForm(tenant.id, slug);
    }
    if (/^\/EmbedForm\/?$/i.test(pathname)) {
      const slug = getQueryParam(search, 'slug');
      if (slug) return await resolveForm(tenant.id, slug);
    }

    // News
    if (/^\/NewsView\/?$/i.test(pathname)) {
      const slug = getQueryParam(search, 'slug');
      if (slug) return await resolveNews(tenant.id, slug);
    }

    // Articles - load article URL config once for both legacy and folder routes
    let articleCfg = null;
    try {
      articleCfg = await getArticleUrlConfig(supabase, tenant.id);
    } catch (err) {
      console.error('[entityMeta] article cfg load failed:', err?.message);
    }
    const articleBasePath = articleCfg?.canonicalBasePath || '/articles';

    // Articles via legacy ?slug=
    if (/^\/ArticleView\/?$/i.test(pathname)) {
      const slug = getQueryParam(search, 'slug');
      if (slug) return await resolveBlogPostBySlug(tenant.id, slug, null, articleBasePath);
    }

    // Articles via folder routing (/<base>/<authorHandle>/<articleSlug>)
    if (articleCfg) {
      for (const basePath of articleCfg.supportedBasePaths) {
        const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = pathname.match(new RegExp(`^${escaped}\\/([^/]+)\\/([^/]+)\\/?$`, 'i'));
        if (m) {
          const authorHandle = decodeURIComponent(m[1]);
          const articleSlug = decodeURIComponent(m[2]);
          // Skip the author-listing route: /<base>/author/<handle>
          if (authorHandle.toLowerCase() === 'author') continue;
          const meta = await resolveBlogPostBySlug(tenant.id, articleSlug, authorHandle, articleBasePath);
          if (meta) return meta;
        }
      }
    }
  } catch (err) {
    console.error('[entityMeta] resolution failed:', err?.message);
  }

  return null;
}
