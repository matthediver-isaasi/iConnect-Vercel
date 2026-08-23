import { supabase } from './database.js';
import {
  PUBLIC_SIMPLE_EVENT_STATUSES,
  isImmediateEvent,
} from '../../shared/eventTiming.js';
import { getArticleUrlConfig } from './articleUrlPaths.js';
import { resolveBlogPostAuthors } from './blogPostAuthors.js';
import { resolveMicrositeByPrefix } from './microsites.js';
import { findPublishedArticleBySlug } from './articleSlugLookup.js';

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
    .select('id, title, slug, summary, description, image_url, start_date, location, status, tenant_id, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .is('member_group_id', null)
    .in('status', PUBLIC_SIMPLE_EVENT_STATUSES);
  if (slug) q = q.eq('slug', slug);
  else q = q.eq('id', id);
  let { data, error } = await q.maybeSingle();
  if (error?.code === '42703') {
    let fb = supabase
      .from('event')
      .select('id, title, slug, summary, description, image_url, start_date, location, status, seo_title, seo_description, og_image_url')
      .is('member_group_id', null)
      .in('status', PUBLIC_SIMPLE_EVENT_STATUSES);
    if (slug) fb = fb.eq('slug', slug);
    else fb = fb.eq('id', id);
    let r = await fb.maybeSingle();
    if (r.error?.code === '42703') {
      // Even older schemas without any seo_* columns.
      let fb2 = supabase
        .from('event')
        .select('id, title, slug, summary, description, image_url, start_date, location, status')
        .is('member_group_id', null)
        .in('status', PUBLIC_SIMPLE_EVENT_STATUSES);
      if (slug) fb2 = fb2.eq('slug', slug);
      else fb2 = fb2.eq('id', id);
      r = await fb2.maybeSingle();
    }
    data = r.data;
  }
  if (!data) return null;
  const dateStr = !isImmediateEvent(data) && data.start_date
    ? new Date(data.start_date).toLocaleDateString('en-GB', { dateStyle: 'long' })
    : '';
  const descBase = stripHtml(data.summary || data.description);
  const autoDescription = truncate(
    [dateStr, data.location, descBase].filter(Boolean).join(' · '),
    300
  );
  return {
    title: (data.seo_title?.trim() || data.title) || null,
    description: data.seo_description?.trim() || autoDescription,
    image: data.og_image_url?.trim() || data.image_url || null,
    canonicalPath: data.slug ? `/events/${data.slug}` : `/EventDetails?id=${data.id}`,
  };
}

async function resolveBlogPostBySlug(tenantId, slug, authorHandle, articleBasePath) {
  if (!supabase || !slug) return null;
  let q = supabase
    .from('blog_post')
    .select(
      'id, title, slug, summary, content, feature_image_url, status, tenant_id, author_id, guest_writer_id, seo_title, seo_description, og_image_url'
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
    if (member) {
      q = q.eq('author_id', member.id);
    } else {
      // Unknown/placeholder segment (e.g. 'member' for a handle-less author,
      // or a stale handle): fall through to the tolerant slug-only fallback.
      q = null;
    }
  } else if (authorHandle === 'guest') {
    q = q.not('guest_writer_id', 'is', null);
  }
  let data = null;
  if (q) {
    ({ data } = await q.maybeSingle());
  }
  if (!data && authorHandle) {
    // Tolerant fallback: resolve the published article by slug alone so
    // placeholder/stale author segments still get article metadata (mirrors
    // api/public/article.js).
    data = await findPublishedArticleBySlug(
      supabase,
      tenantId,
      slug,
      'id, title, slug, summary, content, feature_image_url, status, tenant_id, author_id, guest_writer_id, seo_title, seo_description, og_image_url'
    );
    // Re-derive the canonical handle from the actual article below.
    if (data) resolvedAuthorHandle = null;
  }
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
    title: data.seo_title?.trim() || data.title,
    description: data.seo_description?.trim()
      || truncate(stripHtml(data.summary || data.content), 300),
    image: data.og_image_url?.trim() || data.feature_image_url || null,
    ogType: 'article',
  };
  if (articleBasePath && resolvedAuthorHandle) {
    result.canonicalPath = `${articleBasePath}/${encodeURIComponent(resolvedAuthorHandle)}/${encodeURIComponent(data.slug)}`;
  }

  // Task #1226: surface every ordered contributor for article:author tags.
  // The post's primary author stays first (display_order 0); co-authors follow.
  try {
    const authors = await resolveBlogPostAuthors(supabase, data);
    const names = (authors || [])
      .map((a) => (a?.name || '').trim())
      .filter(Boolean);
    if (names.length > 0) result.authors = names;
  } catch (err) {
    console.error('[entityMeta] author resolution failed:', err?.message);
  }
  return result;
}

async function resolveNews(tenantId, slug) {
  if (!supabase || !slug) return null;
  const { data } = await supabase
    .from('news_post')
    .select('id, title, slug, summary, content, feature_image_url, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (!data) return null;
  return {
    title: data.seo_title?.trim() || data.title,
    description: data.seo_description?.trim()
      || truncate(stripHtml(data.summary || data.content), 300),
    image: data.og_image_url?.trim() || data.feature_image_url || null,
    canonicalPath: `/NewsView?slug=${encodeURIComponent(data.slug)}`,
  };
}

async function resolveComplexEvent(tenantId, { id, slug }) {
  if (!supabase || (!id && !slug)) return null;
  let q = supabase
    .from('complex_event')
    .select('id, title, slug, summary, description, image_url, start_date, location, status, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .in('status', ['published', 'tbc']);
  if (slug) q = q.eq('slug', slug);
  else q = q.eq('id', id);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  const dateStr = data.start_date
    ? new Date(data.start_date).toLocaleDateString('en-GB', { dateStyle: 'long' })
    : '';
  const descBase = stripHtml(data.summary || data.description);
  const autoDescription = truncate(
    [dateStr, data.location, descBase].filter(Boolean).join(' · '),
    300
  );
  return {
    title: data.seo_title?.trim() || data.title,
    description: data.seo_description?.trim() || autoDescription,
    image: data.og_image_url?.trim() || data.image_url || null,
    canonicalPath: data.slug ? `/complex-event/${data.slug}` : `/ComplexEventDetail?id=${data.id}`,
  };
}

async function resolveJob(tenantId, id) {
  if (!supabase || !id) return null;
  const { data } = await supabase
    .from('job_posting')
    .select('id, title, description, company_name, company_logo_url, location, salary_range, job_type, status')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .eq('status', 'active')
    .maybeSingle();
  if (!data) return null;
  const descParts = [data.company_name, data.location, data.job_type, data.salary_range].filter(Boolean);
  const descBase = stripHtml(data.description);
  const description = truncate(
    [descParts.join(' · '), descBase].filter(Boolean).join(' — '),
    300
  );
  const title = data.company_name ? `${data.title} — ${data.company_name}` : data.title;
  return {
    title,
    description,
    image: data.company_logo_url || null,
    canonicalPath: `/JobDetails?id=${data.id}`,
  };
}

async function resolveForumThread(tenantId, { id, slug }) {
  if (!supabase || (!id && !slug)) return null;
  let q = supabase
    .from('forum_thread')
    .select('id, title, slug, post_count, view_count, is_hidden, tenant_id')
    .eq('tenant_id', tenantId)
    .eq('is_hidden', false);
  if (slug) q = q.eq('slug', slug);
  else q = q.eq('id', id);
  const { data: thread } = await q.maybeSingle();
  if (!thread) return null;
  // Try to grab the opening post for description
  let descBase = '';
  const { data: firstPost } = await supabase
    .from('forum_post')
    .select('content')
    .eq('thread_id', thread.id)
    .eq('is_hidden', false)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstPost?.content) descBase = stripHtml(firstPost.content);
  const meta = [
    typeof thread.post_count === 'number' ? `${thread.post_count} ${thread.post_count === 1 ? 'reply' : 'replies'}` : null,
  ].filter(Boolean).join(' · ');
  const description = truncate([meta, descBase].filter(Boolean).join(' — '), 300);
  return {
    title: thread.title,
    description,
    image: null,
    canonicalPath: `/ForumThread?threadId=${thread.id}`,
  };
}

async function resolveResource(tenantId, identifier) {
  if (!supabase || !identifier) return null;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  let q = supabase
    .from('resource')
    .select('id, title, description, image_url, slug, status, author_name, resource_type, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .eq('status', 'active');
  q = isUUID ? q.eq('id', identifier) : q.eq('slug', identifier);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  const resourceTypeName = data.resource_type === 'tenant_form'
    ? 'Tenant form'
    : String(data.resource_type || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const descParts = [resourceTypeName, data.author_name].filter(Boolean).join(' · ');
  const descBase = stripHtml(data.description);
  const autoDescription = truncate([descParts, descBase].filter(Boolean).join(' — '), 300);
  return {
    title: data.seo_title?.trim() || data.title,
    description: data.seo_description?.trim() || autoDescription,
    image: data.og_image_url?.trim() || data.image_url || null,
    canonicalPath: data.slug ? `/resources/${data.slug}` : `/Resources?resourceId=${data.id}`,
  };
}

async function resolveDynamicDirectory(tenantId, slug) {
  if (!supabase || !slug) return null;
  const { data } = await supabase
    .from('dynamic_directory')
    .select('id, name, description, slug, is_active, entity_type, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  return {
    title: data.seo_title?.trim() || data.name,
    description: data.seo_description?.trim() || truncate(stripHtml(data.description), 300),
    image: data.og_image_url?.trim() || null,
    canonicalPath: `/directory/${encodeURIComponent(data.slug)}`,
  };
}

async function resolveGallery(tenantId, id) {
  if (!supabase || !id) return null;
  const { data: gallery } = await supabase
    .from('gallery')
    .select('id, title, description, is_public, cover_photo_id')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .eq('is_public', true)
    .maybeSingle();
  if (!gallery) return null;
  let image = null;
  if (gallery.cover_photo_id) {
    const { data: photo } = await supabase
      .from('gallery_photo')
      .select('file_url')
      .eq('id', gallery.cover_photo_id)
      .eq('gallery_id', gallery.id)
      .maybeSingle();
    if (photo?.file_url) image = photo.file_url;
  }
  if (!image) {
    const { data: firstPhoto } = await supabase
      .from('gallery_photo')
      .select('file_url')
      .eq('gallery_id', gallery.id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstPhoto?.file_url) image = firstPhoto.file_url;
  }
  return {
    title: gallery.title || 'Photo Gallery',
    description: truncate(stripHtml(gallery.description), 300),
    image,
    canonicalPath: `/galleries/${gallery.id}`,
  };
}

async function resolveCampaign(tenantId, slug) {
  if (!supabase || !slug) return null;
  const { data } = await supabase
    .from('fundraising_campaign')
    .select('id, name, slug, description, public_description, cover_image_url, status, seo_title, seo_description, og_image_url')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();
  if (!data) return null;
  return {
    title: data.seo_title?.trim() || data.name,
    description: data.seo_description?.trim()
      || truncate(stripHtml(data.public_description || data.description), 300),
    image: data.og_image_url?.trim() || data.cover_image_url || null,
    canonicalPath: `/fundraise/${encodeURIComponent(data.slug)}`,
  };
}

async function resolveMember(tenantId, id) {
  if (!supabase || !id) return null;
  const { data } = await supabase
    .from('member')
    .select('id, first_name, last_name, handle, profile_image_url, job_title, biography, show_in_directory')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  // Respect directory privacy: members hidden from directory should not unfurl
  // with personal details.
  if (data.show_in_directory === false) return null;
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  const descBase = stripHtml(data.biography);
  const description = truncate(
    [data.job_title, descBase].filter(Boolean).join(' — '),
    300
  );
  return {
    title: name || 'Member profile',
    description,
    image: data.profile_image_url || null,
    canonicalPath: `/members/${data.id}`,
  };
}

// CMS page (IEditPage) content extraction. Mirrors the field lists used by
// `api/public/prerender.js` so unfurls pick up the same hero text/image the
// SEO body uses.
const CMS_TEXT_FIELDS = [
  'heading', 'text', 'content_text', 'header_content', 'header', 'subheading',
  'subtitle', 'description', 'quote_text', 'attribution', 'author_name',
  'left_heading', 'left_text', 'right_heading', 'right_text',
  'header_title', 'header_subtitle', 'text_content', 'body_content',
  'title', 'body', 'name', 'label', 'quote', 'content',
];
const CMS_IMAGE_FIELDS = [
  'image_url', 'background_image', 'hero_image', 'image',
  'background_image_url', 'left_image_url', 'right_image_url',
  'profile_image_url', 'mobile_image_url',
];
const CMS_TEXT_FIELDS_SET = new Set(CMS_TEXT_FIELDS);
const CMS_IMAGE_FIELDS_SET = new Set(CMS_IMAGE_FIELDS);

function extractCmsTexts(obj, seen) {
  if (!obj || typeof obj !== 'object') return [];
  if (!seen) seen = new WeakSet();
  if (seen.has(obj)) return [];
  seen.add(obj);
  const out = [];
  if (Array.isArray(obj)) {
    for (const item of obj) out.push(...extractCmsTexts(item, seen));
    return out;
  }
  for (const f of CMS_TEXT_FIELDS) {
    if (typeof obj[f] === 'string') {
      const cleaned = stripHtml(obj[f]);
      if (cleaned) out.push(cleaned);
    }
  }
  for (const k of Object.keys(obj)) {
    if (CMS_TEXT_FIELDS_SET.has(k) || CMS_IMAGE_FIELDS_SET.has(k)) continue;
    const v = obj[k];
    if (v && typeof v === 'object') out.push(...extractCmsTexts(v, seen));
  }
  return out;
}

function extractCmsImage(obj, seen) {
  if (!obj || typeof obj !== 'object') return null;
  if (!seen) seen = new WeakSet();
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const img = extractCmsImage(item, seen);
      if (img) return img;
    }
    return null;
  }
  for (const f of CMS_IMAGE_FIELDS) {
    if (typeof obj[f] === 'string' && obj[f].startsWith('http')) return obj[f];
  }
  if (obj.media && typeof obj.media.src === 'string' && obj.media.src.startsWith('http')) {
    return obj.media.src;
  }
  if (Array.isArray(obj.media_items)) {
    for (const m of obj.media_items) {
      if (m && typeof m.src === 'string' && m.src.startsWith('http')) return m.src;
    }
  }
  for (const k of Object.keys(obj)) {
    if (CMS_IMAGE_FIELDS_SET.has(k) || CMS_TEXT_FIELDS_SET.has(k)) continue;
    const v = obj[k];
    if (v && typeof v === 'object') {
      const img = extractCmsImage(v, seen);
      if (img) return img;
    }
  }
  return null;
}

async function resolveIEditPage(tenantId, slug, microsite = null) {
  if (!supabase || !slug) return null;
  // Match the public page endpoint: only published public/hybrid pages
  // unfurl. Member-only pages stay private and fall back to tenant defaults.
  // Task #2426: with `microsite` set, resolve the slug within that microsite
  // (canonical URL is the prefixed path); without it, pages assigned to a
  // microsite must NOT resolve at their bare slug. Legacy-tolerant: if the
  // microsite_id column doesn't exist yet, retry without it.
  const baseColumns = 'id, title, slug, description, meta_title, meta_description, seo_title, seo_description, og_image_url, status, layout_type, builder_type, canvas_design, static_html';
  let page = null;
  const { data, error } = await supabase
    .from('i_edit_page')
    .select(`${baseColumns}, microsite_id`)
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('status', 'published')
    .in('layout_type', ['public', 'hybrid'])
    .maybeSingle();
  if (error && error.code === '42703') {
    if (microsite) return null;
    const retry = await supabase
      .from('i_edit_page')
      .select(baseColumns)
      .eq('tenant_id', tenantId)
      .eq('slug', slug)
      .eq('status', 'published')
      .in('layout_type', ['public', 'hybrid'])
      .maybeSingle();
    page = retry.data || null;
  } else {
    page = data || null;
    if (page) {
      if (microsite) {
        if (page.microsite_id !== microsite.id) return null;
      } else if (page.microsite_id) {
        // Microsite page requested at its bare slug — not served there.
        return null;
      }
    }
  }
  if (!page) return null;

  // task-711: explicit admin overrides win over auto-derived values.
  // task-712: when overrides are blank, fall back to meta_*, then crawl
  // the page's elements to lift a hero title/image/description.
  const overrideTitle = page.seo_title?.trim() || null;
  const overrideDescription = page.seo_description?.trim() || null;
  const overrideImage = page.og_image_url?.trim() || null;

  const title = overrideTitle || page.meta_title || page.title || page.slug;
  let description = overrideDescription
    || page.meta_description
    || stripHtml(page.description)
    || '';
  let image = overrideImage;

  // Canvas Builder pages store content in `canvas_design` (jsonb) instead
  // of the i_edit_page_element table. Phase 1 keeps the fallback minimal:
  // walk the design tree for any text/image content using the same
  // CMS_TEXT_FIELDS / CMS_IMAGE_FIELDS extractors used for iEdit elements.
  if (page.builder_type === 'ai_static') {
    // Static AI-generated pages (Task #3371): derive description/image from
    // the store-time-sanitized HTML body.
    if (!description && page.static_html) {
      description = stripHtml(page.static_html);
    }
    if (!image && page.static_html) {
      const imgMatch = String(page.static_html).match(/<img[^>]+src="([^"]+)"/i);
      if (imgMatch) image = imgMatch[1];
    }
  } else if (page.builder_type === 'canvas') {
    if ((!description || !image) && page.canvas_design && typeof page.canvas_design === 'object') {
      if (!image) image = extractCmsImage(page.canvas_design);
      if (!description) {
        const texts = extractCmsTexts(page.canvas_design);
        if (texts.length) description = texts.join(' ');
      }
    }
  } else if (!description || !image) {
    const { data: elements } = await supabase
      .from('i_edit_page_element')
      .select('element_type, content')
      .eq('page_id', page.id)
      .order('display_order', { ascending: true });
    if (elements?.length) {
      const texts = [];
      for (const el of elements) {
        if (!image && el.content && typeof el.content === 'object') {
          image = extractCmsImage(el.content);
        }
        if (!description) {
          if (typeof el.content === 'string') {
            const t = stripHtml(el.content);
            if (t) texts.push(t);
          } else if (el.content && typeof el.content === 'object') {
            texts.push(...extractCmsTexts(el.content));
          }
        }
        if (description ? image : (image && texts.length > 0)) break;
      }
      if (!description && texts.length) description = texts.join(' ');
    }
  }

  return {
    title,
    description: description ? truncate(description, 300) : null,
    image: image || null,
    canonicalPath: microsite
      ? `/${encodeURIComponent(microsite.path_prefix)}/${encodeURIComponent(page.slug)}`
      : `/${encodeURIComponent(page.slug)}`,
  };
}

async function resolveForm(tenantId, slug, { canonicalPath = null } = {}) {
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
    canonicalPath: canonicalPath || `/FormView?slug=${encodeURIComponent(data.slug)}`,
  };
}

// task-710: section/list routes — for any of these we return a
// descriptive title + description so the page does not unfurl with just
// the bare tenant name. image is left null so renderHtml falls back to
// tenant.social_image_url. The matched array is the *first* element to
// match the pathname (case-insensitive, exact + optional trailing slash).
const LIST_ROUTE_META = [
  { paths: ['/Events', '/PublicEvents', '/EventsList'], label: 'Events', blurb: 'Upcoming events and bookings' },
  { paths: ['/Articles', '/Blog'], label: 'Articles', blurb: 'Latest articles and insights' },
  { paths: ['/News'], label: 'News', blurb: 'Latest news and announcements' },
  { paths: ['/Resources', '/PublicResources'], label: 'Resources', blurb: 'Resources and downloads' },
  { paths: ['/JobBoard'], label: 'Job Board', blurb: 'Latest job opportunities' },
  { paths: ['/Forum'], label: 'Community Forum', blurb: 'Discussions from the community' },
  { paths: ['/CampaignsPage', '/Fundraising', '/Donate', '/DonatePage'], label: 'Support us', blurb: 'Fundraising campaigns and ways to give' },
  { paths: ['/PhotoGalleries', '/Galleries'], label: 'Photo Galleries', blurb: 'Photo galleries and albums' },
  { paths: ['/MemberDirectory'], label: 'Member Directory', blurb: 'Browse our members' },
  { paths: ['/PublicAbout'], label: 'About', blurb: 'About us' },
  { paths: ['/PublicContact'], label: 'Contact', blurb: 'Get in touch' },
];

function resolveListRouteMeta(pathname, tenant) {
  if (!pathname) return null;
  const lower = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  for (const entry of LIST_ROUTE_META) {
    const match = entry.paths.some((p) => p.toLowerCase() === lower);
    if (match) {
      const tenantName = tenant?.name || '';
      const blurb = tenant?.tagline
        ? `${entry.blurb} at ${tenantName} — ${tenant.tagline}`
        : tenantName
          ? `${entry.blurb} at ${tenantName}`
          : entry.blurb;
      return {
        title: entry.label,
        description: truncate(blurb, 300),
        image: null,
      };
    }
  }
  return null;
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

    // Complex events
    const complexSlugMatch = pathname.match(/^\/(?:complex-event|session-events)\/([^/]+)\/?$/i);
    if (complexSlugMatch) {
      return await resolveComplexEvent(tenant.id, {
        slug: decodeURIComponent(complexSlugMatch[1]),
      });
    }
    if (/^\/ComplexEventDetail\/?$/i.test(pathname)) {
      const id = getQueryParam(search, 'id');
      const slug = getQueryParam(search, 'slug');
      if (id || slug) return await resolveComplexEvent(tenant.id, { id, slug });
    }

    // Job postings
    const jobSlugMatch = pathname.match(/^\/jobs\/([^/]+)\/?$/i);
    if (jobSlugMatch) {
      return await resolveJob(tenant.id, decodeURIComponent(jobSlugMatch[1]));
    }
    if (/^\/JobDetails\/?$/i.test(pathname)) {
      const id = getQueryParam(search, 'id');
      if (id) return await resolveJob(tenant.id, id);
    }

    // Forum threads
    const forumSlugMatch = pathname.match(/^\/forum\/([^/]+)\/?$/i);
    if (forumSlugMatch) {
      return await resolveForumThread(tenant.id, {
        slug: decodeURIComponent(forumSlugMatch[1]),
      });
    }
    if (/^\/ForumThread\/?$/i.test(pathname)) {
      const threadId = getQueryParam(search, 'threadId') || getQueryParam(search, 'id');
      const slug = getQueryParam(search, 'slug');
      if (threadId || slug) return await resolveForumThread(tenant.id, { id: threadId, slug });
    }

    // Resources
    const resourceSlugMatch = pathname.match(/^\/resources\/([^/]+)\/?$/i);
    if (resourceSlugMatch) {
      return await resolveResource(tenant.id, decodeURIComponent(resourceSlugMatch[1]));
    }
    if (/^\/(?:Resources|PublicResources)\/?$/i.test(pathname)) {
      const id = getQueryParam(search, 'resourceId') || getQueryParam(search, 'id');
      const slug = getQueryParam(search, 'slug');
      if (id || slug) {
        const meta = await resolveResource(tenant.id, id || slug);
        if (meta) return meta;
      }
    }

    // Dynamic directories
    const dirMatch = pathname.match(/^\/directory\/([^/]+)\/?$/i);
    if (dirMatch) {
      return await resolveDynamicDirectory(tenant.id, decodeURIComponent(dirMatch[1]));
    }

    // Photo galleries
    const galleryMatch = pathname.match(/^\/galleries\/([^/]+)\/?$/i);
    if (galleryMatch) {
      return await resolveGallery(tenant.id, decodeURIComponent(galleryMatch[1]));
    }
    if (/^\/PhotoGalleries\/?$/i.test(pathname)) {
      const id = getQueryParam(search, 'galleryId') || getQueryParam(search, 'id');
      if (id) {
        const meta = await resolveGallery(tenant.id, id);
        if (meta) return meta;
      }
    }

    // Fundraising campaigns
    const campaignMatch = pathname.match(/^\/(?:fundraise|campaign|campaigns)\/([^/]+)\/?$/i);
    if (campaignMatch) {
      const slug = decodeURIComponent(campaignMatch[1]);
      const meta = await resolveCampaign(tenant.id, slug);
      if (meta) return meta;
    }

    // Member profiles
    const memberMatch = pathname.match(/^\/members\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
    if (memberMatch) {
      return await resolveMember(tenant.id, memberMatch[1]);
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
    // Task #2426: microsite pages at /{prefix}/{slug}. Checked before the
    // single-segment CMS match; the prefix must resolve to an active
    // microsite of this tenant, and the slug to a published page assigned
    // to it. Non-matches fall through to the existing handlers unchanged.
    const micrositeMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (micrositeMatch && supabase) {
      const prefix = decodeURIComponent(micrositeMatch[1]).toLowerCase();
      const msSlug = decodeURIComponent(micrositeMatch[2]);
      const microsite = await resolveMicrositeByPrefix(supabase, tenant.id, prefix);
      if (microsite) {
        const meta = await resolveIEditPage(tenant.id, msSlug, microsite);
        if (meta) return meta;
      }
    }

    // CMS pages built with the IEditPage page builder. These are served by
    // DynamicPage at top-level single-segment routes (`/:slug`). Try this
    // last so dedicated entity handlers above always win, but before the
    // list-route fallback so a tenant's own CMS page provides richer meta.
    // Honors per-page seo_title/seo_description/og_image_url overrides
    // (task-711) and falls back to element-derived content (task-712).
    const cmsMatch = pathname.match(/^\/([^/]+)\/?$/);
    if (cmsMatch) {
      const cmsSlug = decodeURIComponent(cmsMatch[1]);
      const meta = await resolveIEditPage(tenant.id, cmsSlug);
      if (meta) return meta;
      // Task #2785: pretty form URLs — a bare /{slug} matching no CMS page
      // may be an active form served by the client-side form fallback. Give
      // it the same meta as /FormView?slug=..., canonicalised to the pretty
      // path itself.
      const formMeta = await resolveForm(tenant.id, cmsSlug, {
        canonicalPath: `/${encodeURIComponent(cmsSlug)}`,
      });
      if (formMeta) return formMeta;
    }
  } catch (err) {
    console.error('[entityMeta] resolution failed:', err?.message);
  }

  // Fallback: section/list routes get a descriptive title.
  return resolveListRouteMeta(pathname, tenant);
}
