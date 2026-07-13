import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getArticleUrlConfig } from '../_lib/articleUrlPaths.js';
import { resolveMicrositeByPrefix } from '../_lib/microsites.js';

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html) {
  if (!html) return '';
  const stripped = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return decodeHtmlEntities(stripped);
}

function truncate(str, maxLen = 160) {
  if (!str) return '';
  const clean = str.substring(0, maxLen);
  return clean.length < str.length ? clean + '...' : clean;
}

function buildJsonLd({ title, description, ogUrl, ogImage, tenantName }) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    'name': title || '',
    'description': description || '',
  };
  if (ogUrl) ld.url = ogUrl;
  if (ogImage) ld.image = ogImage;
  if (tenantName) {
    ld.publisher = {
      '@type': 'Organization',
      'name': tenantName,
    };
  }
  return JSON.stringify(ld);
}

function buildHtmlPage({ title, description, ogTitle, ogDescription, ogImage, ogUrl, canonicalUrl, bodyContent, tenantName, favicon, navLinks }) {
  const navHtml = (navLinks && navLinks.length > 0)
    ? `<nav aria-label="Main navigation"><ul>${navLinks.map(n => `<li><a href="${escapeHtml(n.url)}">${escapeHtml(n.label)}</a></li>`).join('')}</ul></nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(ogTitle || title)}">
  <meta property="og:description" content="${escapeHtml(ogDescription || description)}">
  <meta property="og:type" content="website">
  ${ogUrl ? `<meta property="og:url" content="${escapeHtml(ogUrl)}">` : ''}
  ${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(ogTitle || title)}">
  <meta name="twitter:description" content="${escapeHtml(ogDescription || description)}">
  ${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}">` : ''}
  ${canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : ''}
  ${favicon ? `<link rel="icon" href="${escapeHtml(favicon)}">` : ''}
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${buildJsonLd({ title, description, ogUrl, ogImage, tenantName })}</script>
</head>
<body>
  <header>
    <h1>${escapeHtml(tenantName || '')}</h1>
    ${navHtml}
  </header>
  <main>
    ${bodyContent}
  </main>
  <footer><p>&copy; ${new Date().getFullYear()} ${escapeHtml(tenantName || '')}</p></footer>
</body>
</html>`;
}

function getBaseUrl(req, tenant) {
  const protocol = 'https';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (tenant.domain) {
    if (host.startsWith('www.') && !tenant.domain.startsWith('www.')) {
      return `${protocol}://www.${tenant.domain}`;
    }
    return `${protocol}://${tenant.domain}`;
  }
  return `${protocol}://${host}`;
}

async function renderEventPage(supabaseClient, tenant, slug, eventId, baseUrl) {
  let query = supabaseClient
    .from('event')
    .select('id, title, slug, description, summary, start_date, end_date, location, image_url, status')
    .eq('tenant_id', tenant.id)
    .is('member_group_id', null);

  if (slug) {
    query = query.eq('slug', slug);
  } else if (eventId) {
    query = query.eq('id', eventId);
  } else {
    return null;
  }

  query = query.in('status', ['published', 'tbc']);

  let { data: event, error } = await query.single();

  if (error?.code === '42703') {
    let fallbackQuery = supabaseClient
      .from('event')
      .select('id, title, slug, description, summary, start_date, end_date, location, image_url, status')
      .is('member_group_id', null);
    if (slug) fallbackQuery = fallbackQuery.eq('slug', slug);
    else if (eventId) fallbackQuery = fallbackQuery.eq('id', eventId);
    fallbackQuery = fallbackQuery.in('status', ['published', 'tbc']);
    const fallbackResult = await fallbackQuery.single();
    event = fallbackResult.data;
  }

  if (!event) return null;

  const desc = truncate(stripHtml(event.summary || event.description));
  const dateStr = event.start_date ? new Date(event.start_date).toLocaleDateString('en-US', { dateStyle: 'long' }) : '';
  const locationStr = event.location ? ` | ${event.location}` : '';

  return {
    title: `${event.title} | ${tenant.name}`,
    description: desc,
    ogImage: event.image_url,
    ogUrl: event.slug ? `${baseUrl}/events/${event.slug}` : `${baseUrl}/EventDetails?id=${event.id}`,
    bodyContent: `
      <article>
        <h2>${escapeHtml(event.title)}</h2>
        ${dateStr ? `<p><strong>Date:</strong> ${escapeHtml(dateStr)}</p>` : ''}
        ${event.location ? `<p><strong>Location:</strong> ${escapeHtml(event.location)}</p>` : ''}
        ${event.summary ? `<p>${escapeHtml(stripHtml(event.summary))}</p>` : ''}
        ${event.description ? `<div>${escapeHtml(stripHtml(event.description))}</div>` : ''}
      </article>`
  };
}

async function renderArticlePage(supabaseClient, tenant, authorHandle, articleSlug, baseUrl, articleBasePath) {
  if (!authorHandle || !articleSlug) return null;

  let article = null;

  if (authorHandle && authorHandle !== 'guest') {
    const { data: member } = await supabaseClient
      .from('member')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('handle', authorHandle)
      .single();

    if (member) {
      const { data: found } = await supabaseClient
        .from('blog_post')
        .select('id, title, slug, summary, content, feature_image_url, published_date, author_id, guest_writer_id')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .eq('author_id', member.id)
        .or(`slug.eq.${articleSlug},slug.like.${articleSlug}-by-%`)
        .single();
      article = found;
    }
  } else if (authorHandle === 'guest') {
    const { data: found } = await supabaseClient
      .from('blog_post')
      .select('id, title, slug, summary, content, feature_image_url, published_date, author_id, guest_writer_id')
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .not('guest_writer_id', 'is', null)
      .or(`slug.eq.${articleSlug},slug.like.${articleSlug}-by-%`)
      .single();
    article = found;
  } else {
    const { data: found } = await supabaseClient
      .from('blog_post')
      .select('id, title, slug, summary, content, feature_image_url, published_date, author_id, guest_writer_id')
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .or(`slug.eq.${articleSlug},slug.like.${articleSlug}-by-%`)
      .single();
    article = found;
  }

  if (!article) return null;

  let authorName = '';
  if (article.author_id) {
    const { data: member } = await supabaseClient
      .from('member')
      .select('first_name, last_name')
      .eq('id', article.author_id)
      .single();
    if (member) authorName = `${member.first_name || ''} ${member.last_name || ''}`.trim();
  } else if (article.guest_writer_id) {
    const { data: gw } = await supabaseClient
      .from('guest_writer')
      .select('full_name')
      .eq('id', article.guest_writer_id)
      .single();
    if (gw) authorName = gw.full_name;
  }

  const desc = truncate(stripHtml(article.summary || article.content));

  return {
    title: `${article.title} | ${tenant.name}`,
    description: desc,
    ogImage: article.feature_image_url,
    ogUrl: `${baseUrl}${articleBasePath}/${authorHandle}/${articleSlug}`,
    bodyContent: `
      <article>
        <h2>${escapeHtml(article.title)}</h2>
        ${authorName ? `<p><strong>By:</strong> ${escapeHtml(authorName)}</p>` : ''}
        ${article.published_date ? `<p><strong>Published:</strong> ${escapeHtml(new Date(article.published_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}</p>` : ''}
        ${article.summary ? `<p>${escapeHtml(stripHtml(article.summary))}</p>` : ''}
        ${article.content ? `<div>${escapeHtml(truncate(stripHtml(article.content), 1000))}</div>` : ''}
      </article>`
  };
}

async function renderNewsPage(supabaseClient, tenant, newsSlug, baseUrl) {
  if (!newsSlug) return null;

  const { data: news } = await supabaseClient
    .from('news_post')
    .select('id, title, slug, summary, content, feature_image_url, published_date')
    .eq('tenant_id', tenant.id)
    .eq('slug', newsSlug)
    .eq('status', 'published')
    .single();

  if (!news) return null;

  const desc = truncate(stripHtml(news.summary || news.content));

  return {
    title: `${news.title} | ${tenant.name}`,
    description: desc,
    ogImage: news.feature_image_url,
    ogUrl: `${baseUrl}/NewsView?slug=${news.slug}`,
    bodyContent: `
      <article>
        <h2>${escapeHtml(news.title)}</h2>
        ${news.published_date ? `<p><strong>Published:</strong> ${escapeHtml(new Date(news.published_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}</p>` : ''}
        ${news.summary ? `<p>${escapeHtml(stripHtml(news.summary))}</p>` : ''}
        ${news.content ? `<div>${escapeHtml(truncate(stripHtml(news.content), 1000))}</div>` : ''}
      </article>`
  };
}

async function renderJobPage(supabaseClient, tenant, jobId, baseUrl) {
  if (!jobId) return null;

  const { data: job } = await supabaseClient
    .from('job_posting')
    .select('id, title, description, company_name, location, salary_range, job_type, hours')
    .eq('tenant_id', tenant.id)
    .eq('id', jobId)
    .eq('status', 'active')
    .single();

  if (!job) return null;

  const desc = truncate(stripHtml(job.description));

  return {
    title: `${job.title} at ${job.company_name || tenant.name} | ${tenant.name}`,
    description: desc,
    ogUrl: `${baseUrl}/JobDetails?id=${job.id}`,
    bodyContent: `
      <article>
        <h2>${escapeHtml(job.title)}</h2>
        ${job.company_name ? `<p><strong>Company:</strong> ${escapeHtml(job.company_name)}</p>` : ''}
        ${job.location ? `<p><strong>Location:</strong> ${escapeHtml(job.location)}</p>` : ''}
        ${job.job_type ? `<p><strong>Type:</strong> ${escapeHtml(job.job_type)}</p>` : ''}
        ${job.salary_range ? `<p><strong>Salary:</strong> ${escapeHtml(job.salary_range)}</p>` : ''}
        ${job.description ? `<div>${escapeHtml(truncate(stripHtml(job.description), 1000))}</div>` : ''}
      </article>`
  };
}

const CMS_TEXT_FIELDS = [
  'heading', 'text', 'content_text', 'header_content', 'header', 'subheading',
  'subtitle', 'description', 'quote_text', 'attribution', 'author_name',
  'left_heading', 'left_text', 'right_heading', 'right_text',
  'header_title', 'header_subtitle', 'text_content', 'body_content',
  'title', 'body', 'name', 'label', 'quote', 'content'
];

const CMS_IMAGE_FIELDS = [
  'image_url', 'background_image', 'hero_image', 'image',
  'background_image_url', 'left_image_url', 'right_image_url',
  'profile_image_url', 'mobile_image_url'
];

const CMS_TEXT_FIELDS_SET = new Set(CMS_TEXT_FIELDS);
const CMS_IMAGE_FIELDS_SET = new Set(CMS_IMAGE_FIELDS);

function extractTextFromContent(obj, seen) {
  if (!obj || typeof obj !== 'object') return [];
  if (!seen) seen = new WeakSet();
  if (seen.has(obj)) return [];
  seen.add(obj);

  const texts = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      texts.push(...extractTextFromContent(item, seen));
    }
    return texts;
  }

  for (const field of CMS_TEXT_FIELDS) {
    if (typeof obj[field] === 'string') {
      const cleaned = stripHtml(obj[field]);
      if (cleaned) texts.push(cleaned);
    }
  }

  for (const key of Object.keys(obj)) {
    if (CMS_TEXT_FIELDS_SET.has(key)) continue;
    if (CMS_IMAGE_FIELDS_SET.has(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object') {
      texts.push(...extractTextFromContent(val, seen));
    }
  }

  return texts;
}

function extractFirstImage(obj, seen) {
  if (!obj || typeof obj !== 'object') return null;
  if (!seen) seen = new WeakSet();
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const img = extractFirstImage(item, seen);
      if (img) return img;
    }
    return null;
  }

  for (const field of CMS_IMAGE_FIELDS) {
    if (typeof obj[field] === 'string' && obj[field].startsWith('http')) {
      return obj[field];
    }
  }

  if (obj.media && typeof obj.media.src === 'string' && obj.media.src.startsWith('http')) {
    return obj.media.src;
  }

  if (Array.isArray(obj.media_items)) {
    for (const m of obj.media_items) {
      if (m && typeof m.src === 'string' && m.src.startsWith('http')) {
        return m.src;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (CMS_IMAGE_FIELDS_SET.has(key)) continue;
    if (CMS_TEXT_FIELDS_SET.has(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object') {
      const img = extractFirstImage(val, seen);
      if (img) return img;
    }
  }

  return null;
}

const PLACEHOLDER_PATTERNS = [
  /^your\s+(heading|title|text|content|subtitle|name|description|quote)\s*\.?$/i,
  /^click\s+here\s*\.?$/i,
  /^(add|enter|type|write|put)\s+(your|a|the)\s+/i,
  /^this\s+is\s+(a|an)\s+(inspiring|example|sample|placeholder|default)\s+/i,
  /^(lorem\s+ipsum|placeholder\s+text)/i,
  /^(example|sample)\s+(heading|title|text|content|quote)\s*\.?$/i,
  /^author\s+name\s*\.?$/i,
  /^(customize|customise)\s+(this|your|with)\s+/i,
  /that\s+can\s+be\s+customized\s+with\s+your\s+own\s+content/i,
  /^untitled\s*(page|section|block)?\s*$/i,
];

function isPlaceholderText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  return PLACEHOLDER_PATTERNS.some(p => p.test(trimmed));
}

function buildElementSection(el) {
  if (!el.content || typeof el.content !== 'object') return '';

  const content = el.content;
  const parts = [];

  const headingFields = ['heading', 'header', 'header_title', 'title'];
  for (const f of headingFields) {
    if (typeof content[f] === 'string') {
      const cleaned = stripHtml(content[f]);
      if (cleaned && !isPlaceholderText(cleaned)) {
        parts.push(`<h2>${escapeHtml(cleaned)}</h2>`);
        break;
      }
    }
  }

  const subheadingFields = ['subheading', 'subtitle', 'header_subtitle'];
  for (const f of subheadingFields) {
    if (typeof content[f] === 'string') {
      const cleaned = stripHtml(content[f]);
      if (cleaned && !isPlaceholderText(cleaned)) {
        parts.push(`<h3>${escapeHtml(cleaned)}</h3>`);
        break;
      }
    }
  }

  const bodyFields = [
    'text', 'content_text', 'text_content', 'header_content', 'body_content',
    'description', 'body'
  ];
  for (const f of bodyFields) {
    if (typeof content[f] === 'string') {
      const cleaned = stripHtml(content[f]);
      if (cleaned && !isPlaceholderText(cleaned)) {
        parts.push(`<p>${escapeHtml(cleaned)}</p>`);
      }
    }
  }

  const pairFields = [
    ['left_heading', 'left_text'],
    ['right_heading', 'right_text']
  ];
  for (const [hf, tf] of pairFields) {
    if (typeof content[hf] === 'string') {
      const h = stripHtml(content[hf]);
      if (h && !isPlaceholderText(h)) parts.push(`<h3>${escapeHtml(h)}</h3>`);
    }
    if (typeof content[tf] === 'string') {
      const t = stripHtml(content[tf]);
      if (t && !isPlaceholderText(t)) parts.push(`<p>${escapeHtml(t)}</p>`);
    }
  }

  if (typeof content.quote_text === 'string') {
    const qt = stripHtml(content.quote_text);
    if (qt && !isPlaceholderText(qt)) parts.push(`<blockquote>${escapeHtml(qt)}</blockquote>`);
  }
  if (typeof content.author_name === 'string') {
    const an = stripHtml(content.author_name);
    if (an && !isPlaceholderText(an)) parts.push(`<p>${escapeHtml(an)}</p>`);
  }

  const seenInSection = new Set();
  const arrayKeys = ['items', 'quotes', 'column_content', 'sub_items'];
  for (const key of arrayKeys) {
    if (Array.isArray(content[key])) {
      for (const item of content[key]) {
        if (item && typeof item === 'object') {
          const texts = extractTextFromContent(item);
          for (const t of texts) {
            if (!isPlaceholderText(t)) {
              const norm = t.toLowerCase().replace(/\s+/g, ' ').trim();
              if (!seenInSection.has(norm)) {
                seenInSection.add(norm);
                parts.push(`<p>${escapeHtml(t)}</p>`);
              }
            }
          }
        }
      }
    }
  }

  if (parts.length === 0) return '';
  const hasBodyContent = parts.some(p => !p.startsWith('<h2>') && !p.startsWith('<h3>'));
  if (!hasBodyContent) return '';
  return `<section>${parts.join('\n')}</section>`;
}

// ---------------------------------------------------------------------------
// Canvas Builder body rendering
//
// Walks a canvas_design document and emits a semantic HTML body — heading
// levels are preserved, images keep their alt text, buttons become links,
// cards become article snippets, and accordions/FAQs become <dl> pairs.
// This is what social unfurl crawlers and search engines see for canvas
// pages (the SPA renders the styled layout on top once JS boots).
// ---------------------------------------------------------------------------

// Map ARIA landmark roles to HTML5 tags for section-type blocks. `main` is
// intentionally excluded — `buildHtmlPage` already wraps the body in a
// top-level <main>, and HTML must contain only one. Non-section blocks
// never receive a landmark tag.
function landmarkTagForSection(blockType, role) {
  if (blockType !== 'section') return null;
  const r = String(role || '').toLowerCase();
  if (r === 'banner' || r === 'header') return 'header';
  if (r === 'navigation' || r === 'nav') return 'nav';
  if (r === 'complementary' || r === 'aside') return 'aside';
  if (r === 'contentinfo' || r === 'footer') return 'footer';
  if (r === 'region' || r === 'section') return 'section';
  return null;
}

// Allow-list mirrors api/og-image.js so srcset only targets hosts we
// trust to serve image bytes (and, for Supabase, support render/image
// transforms). Other hosts get a passthrough.
const PRERENDER_IMG_HOST_SUFFIXES = ['.supabase.co'];
const PRERENDER_IMG_HOSTS = new Set(['vault.iconn.app']);
const PRERENDER_IMG_WIDTHS = [400, 800, 1200, 1600];

function buildPrerenderImg(src, alt, { sizes, loading = 'lazy', priority = false } = {}) {
  if (!src) return '';
  let imgSrc = src;
  let srcSet = '';
  try {
    const u = new URL(src, 'http://localhost');
    const isSb = PRERENDER_IMG_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
    const isVault = PRERENDER_IMG_HOSTS.has(u.hostname);
    if (isSb && u.pathname.includes('/storage/v1/object/public/')) {
      const tp = u.pathname.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
      const base = `${u.origin}${tp}`;
      srcSet = PRERENDER_IMG_WIDTHS.map((w) => `${escapeHtml(base)}?width=${w}&amp;quality=80 ${w}w`).join(', ');
      imgSrc = `${base}?width=1200&quality=80`;
    } else if (!isSb && !isVault) {
      // Unknown host — pass through unchanged.
    }
  } catch {}
  const attrs = [
    `src="${escapeHtml(imgSrc)}"`,
    srcSet ? `srcset="${srcSet}"` : '',
    sizes ? `sizes="${escapeHtml(sizes)}"` : '',
    `alt="${escapeHtml(alt || '')}"`,
    `loading="${priority ? 'eager' : loading}"`,
    'decoding="async"',
    priority ? 'fetchpriority="high"' : '',
  ].filter(Boolean).join(' ');
  return `<img ${attrs}>`;
}

function clampHeadingLevel(n, fallback = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(6, Math.round(v)));
}

function renderCanvasBlockHtml(block, opts) {
  if (!block || typeof block !== 'object') return '';
  if (block?.a11y?.ariaHidden) return '';
  const c = block.content || {};
  const parts = [];
  switch (block.type) {
    case 'hero': {
      const lvl = clampHeadingLevel(c.headingLevel, 1);
      // Emit the hero background image as a real <img> with LCP priority
      // hints when this block is the page's first image. Bots and unfurl
      // bots see the asset directly; otherwise we'd lose fetchpriority/
      // srcset on a CSS background-image.
      if (c.bgType === 'image' && c.bgImageUrl) {
        const altText = block?.a11y?.altText || '';
        parts.push(buildPrerenderImg(c.bgImageUrl, altText, {
          sizes: '100vw',
          priority: !!opts?.priority,
        }));
      }
      if (c.headline) parts.push(`<h${lvl}>${escapeHtml(stripHtml(c.headline))}</h${lvl}>`);
      if (c.subheadline) parts.push(`<p>${escapeHtml(stripHtml(c.subheadline))}</p>`);
      if (Array.isArray(c.ctas)) {
        for (const cta of c.ctas) {
          if (cta?.label && cta?.href) {
            parts.push(`<a href="${escapeHtml(cta.href)}">${escapeHtml(stripHtml(cta.label))}</a>`);
          }
        }
      }
      return parts.length ? `<header>${parts.join('\n')}</header>` : '';
    }
    case 'text': {
      const lvl = Number(c.headingAs);
      const text = stripHtml(c.html || '');
      if (!text || isPlaceholderText(text)) return '';
      if (lvl >= 1 && lvl <= 6) return `<h${lvl}>${escapeHtml(text)}</h${lvl}>`;
      return `<p>${escapeHtml(text)}</p>`;
    }
    case 'image': {
      if (!c.src) return '';
      const img = buildPrerenderImg(c.src, c.alt, {
        sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw',
        priority: !!opts?.priority,
      });
      const inner = c.href ? `<a href="${escapeHtml(c.href)}">${img}</a>` : img;
      return `<figure>${inner}</figure>`;
    }
    case 'button': {
      if (!c.label || !c.href) return '';
      return `<p><a href="${escapeHtml(c.href)}">${escapeHtml(stripHtml(c.label))}</a></p>`;
    }
    case 'video': {
      if (!c.url) return '';
      return `<p><a href="${escapeHtml(c.url)}">Watch video</a></p>`;
    }
    case 'card': {
      const lvl = clampHeadingLevel(c.headingLevel, 3);
      if (c.imageUrl) {
        parts.push(buildPrerenderImg(c.imageUrl, c.imageAlt, {
          sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw',
          priority: !!opts?.priority,
        }));
      }
      if (c.heading) parts.push(`<h${lvl}>${escapeHtml(stripHtml(c.heading))}</h${lvl}>`);
      if (c.body) {
        const t = stripHtml(c.body);
        if (t && !isPlaceholderText(t)) parts.push(`<p>${escapeHtml(t)}</p>`);
      }
      if (c.ctaLabel && c.ctaHref) {
        parts.push(`<a href="${escapeHtml(c.ctaHref)}">${escapeHtml(stripHtml(c.ctaLabel))}</a>`);
      }
      return parts.length ? `<article>${parts.join('\n')}</article>` : '';
    }
    case 'accordion': {
      const items = Array.isArray(c.items) ? c.items : [];
      const rows = [];
      for (const it of items) {
        const q = stripHtml(it?.q || '');
        const a = stripHtml(it?.a || '');
        if (q && !isPlaceholderText(q)) rows.push(`<dt>${escapeHtml(q)}</dt>`);
        if (a && !isPlaceholderText(a)) rows.push(`<dd>${escapeHtml(a)}</dd>`);
      }
      return rows.length ? `<dl>${rows.join('\n')}</dl>` : '';
    }
    case 'testimonials': {
      const items = Array.isArray(c.items) ? c.items : [];
      const rows = [];
      for (const it of items) {
        const q = stripHtml(it?.quote || '');
        if (q && !isPlaceholderText(q)) {
          const cite = stripHtml([it?.author, it?.role].filter(Boolean).join(', '));
          rows.push(`<figure><blockquote>${escapeHtml(q)}</blockquote>${cite ? `<figcaption>${escapeHtml(cite)}</figcaption>` : ''}</figure>`);
        }
      }
      return rows.join('\n');
    }
    case 'stat': {
      const v = stripHtml(c.value || '');
      const l = stripHtml(c.label || '');
      if (!v && !l) return '';
      return `<p>${v ? `<strong>${escapeHtml(v)}</strong>` : ''}${v && l ? ' — ' : ''}${l ? escapeHtml(l) : ''}</p>`;
    }
    case 'pricing-table': {
      const tiers = Array.isArray(c.tiers) ? c.tiers.slice(0, 4) : [];
      if (!tiers.length) return '';
      const headingLvl = clampHeadingLevel(c.headingLevel, 2);
      const sectionParts = [];
      if (c.heading) sectionParts.push(`<h${headingLvl}>${escapeHtml(stripHtml(c.heading))}</h${headingLvl}>`);
      if (c.subheading) sectionParts.push(`<p>${escapeHtml(stripHtml(c.subheading))}</p>`);
      const defaultBilling = c.defaultBilling === 'annual' ? 'annual' : 'monthly';
      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i] || {};
        const name = stripHtml(t.name || '') || `Tier ${i + 1}`;
        const price = stripHtml((defaultBilling === 'annual' ? t.annualPrice : t.monthlyPrice) || t.monthlyPrice || t.annualPrice || '');
        const period = stripHtml(t.period || '');
        const desc = stripHtml(t.description || '');
        const features = Array.isArray(t.features) ? t.features.filter(Boolean) : [];
        const cta = (t.ctaLabel && t.ctaHref)
          ? `<a href="${escapeHtml(t.ctaHref)}">${escapeHtml(stripHtml(t.ctaLabel))}</a>`
          : '';
        const inner = [];
        inner.push(`<h3>${escapeHtml(name)}</h3>`);
        if (desc) inner.push(`<p>${escapeHtml(desc)}</p>`);
        if (price) inner.push(`<p><strong>${escapeHtml(price)}</strong>${period ? ` ${escapeHtml(period)}` : ''}</p>`);
        if (features.length) {
          inner.push(`<ul>${features.map((f) => {
            const feat = typeof f === 'string' ? { text: f, included: true } : (f || {});
            const text = stripHtml(String(feat.text || ''));
            if (!text) return '';
            const included = feat.included !== false;
            const prefix = included ? 'Included: ' : 'Not included: ';
            const tip = feat.tooltip ? ` — ${escapeHtml(stripHtml(String(feat.tooltip)))}` : '';
            return `<li data-included="${included ? 'true' : 'false'}">${escapeHtml(prefix)}${escapeHtml(text)}${tip}</li>`;
          }).filter(Boolean).join('')}</ul>`);
        }
        if (cta) inner.push(cta);
        const recAttr = t.recommended ? ' data-recommended="true"' : '';
        sectionParts.push(`<article${recAttr}>${inner.join('')}</article>`);
      }
      return `<section>${sectionParts.join('')}</section>`;
    }
    case 'testimonial-grid': {
      const items = Array.isArray(c.items) ? c.items : [];
      const headingLvl = clampHeadingLevel(c.headingLevel, 2);
      const parts = [];
      if (c.heading) parts.push(`<h${headingLvl}>${escapeHtml(stripHtml(c.heading))}</h${headingLvl}>`);
      for (const it of items) {
        const q = stripHtml(it?.quote || '');
        if (!q || isPlaceholderText(q)) continue;
        const author = stripHtml(it?.author || '');
        const roleCompany = stripHtml([it?.role, it?.company].filter(Boolean).join(', '));
        const avatar = it?.avatarUrl
          ? buildPrerenderImg(it.avatarUrl, it.avatarAlt || '', { sizes: '64px' })
          : '';
        const companyLogo = it?.companyLogoUrl
          ? buildPrerenderImg(it.companyLogoUrl, it.companyLogoAlt || '', { sizes: '96px' })
          : '';
        const captionParts = [];
        if (author) captionParts.push(`<cite>${escapeHtml(author)}</cite>`);
        if (roleCompany) captionParts.push(escapeHtml(roleCompany));
        if (companyLogo) captionParts.push(companyLogo);
        const caption = captionParts.length ? `<figcaption>${captionParts.join(' — ')}</figcaption>` : '';
        parts.push(`<figure>${avatar}<blockquote>${escapeHtml(q)}</blockquote>${caption}</figure>`);
      }
      return parts.length ? `<section>${parts.join('')}</section>` : '';
    }
    case 'logo-strip': {
      const logos = Array.isArray(c.logos) ? c.logos : [];
      const cells = logos
        .filter((l) => l?.src)
        .map((l) => {
          const img = buildPrerenderImg(l.src, l.alt, { sizes: '(max-width: 640px) 50vw, 160px' });
          return l.href
            ? `<li><a href="${escapeHtml(l.href)}">${img}</a></li>`
            : `<li>${img}</li>`;
        });
      return cells.length ? `<ul>${cells.join('')}</ul>` : '';
    }
    case 'columns': {
      // Each column carries its own rich text. Strip HTML to plain prose
      // and emit one <div> per column inside a wrapper so crawlers see
      // every column's copy in document order.
      const items = Array.isArray(c.items) ? c.items : [];
      const cols = [];
      for (const it of items) {
        const t = stripHtml(it?.html || '');
        if (t && !isPlaceholderText(t)) cols.push(`<div>${escapeHtml(t)}</div>`);
      }
      return cols.length ? `<div class="cb-columns">${cols.join('')}</div>` : '';
    }
    case 'custom-html': {
      const raw = typeof c.html === 'string' ? stripHtml(c.html) : '';
      if (!raw || isPlaceholderText(raw)) return '';
      return `<div>${escapeHtml(raw)}</div>`;
    }
    case 'section':
    case 'box':
      // Container blocks. Their semantic wrapping is applied by the
      // section traversal layer below (so landmark roles still take
      // effect); they have no inline content of their own.
      return '';
    case 'icon':
    case 'spacer':
    case 'divider':
    case 'map':
      return '';
    default:
      return '';
  }
}

// Resolve the landmark wrapper for a group of blocks. We accept a role
// from either the parent root-section (preferred — landmarks should be
// outermost) or a `section`-type block that has been given a role.
// Excludes `main` so we never produce a nested top-level main.
function resolveLandmarkRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'banner' || r === 'header') return 'header';
  if (r === 'navigation' || r === 'nav') return 'nav';
  if (r === 'complementary' || r === 'aside') return 'aside';
  if (r === 'contentinfo' || r === 'footer') return 'footer';
  if (r === 'region' || r === 'section') return 'section';
  return null;
}

function renderCanvasDesignBody(design) {
  if (!design || typeof design !== 'object') return { sections: [], firstImage: null, allTexts: [] };
  const sections = [];
  const allTexts = [];
  let firstImage = null;
  let priorityAssigned = false;
  const rootSections = Array.isArray(design?.root?.sections) ? design.root.sections : [];

  for (const rootSection of rootSections) {
    const children = Array.isArray(rootSection?.children) ? rootSection.children : [];
    const inner = [];
    for (const block of children) {
      if (!block || typeof block !== 'object') continue;
      if (block?.a11y?.ariaHidden) continue;

      // First image-bearing block → ogImage source + LCP priority. We
      // only flag priority for blocks that actually emit an <img> in
      // prerender output (image, hero with image bg, card with image).
      let isPriority = false;
      if (!firstImage) {
        const c = block.content || {};
        let imgSrc = null;
        if (block.type === 'image' && c.src) imgSrc = c.src;
        else if (block.type === 'hero' && c.bgType === 'image' && c.bgImageUrl) imgSrc = c.bgImageUrl;
        else if (block.type === 'card' && c.imageUrl) imgSrc = c.imageUrl;
        if (imgSrc) {
          firstImage = imgSrc;
          if (!priorityAssigned) {
            isPriority = true;
            priorityAssigned = true;
          }
        }
      }

      const html = renderCanvasBlockHtml(block, { priority: isPriority });
      if (!html) continue;

      // Block-level landmark wrapper: only `section`-type blocks may
      // upgrade to a landmark tag, and never to <main>.
      const blockLandmark = landmarkTagForSection(block.type, block?.a11y?.role);
      const blockHtml = blockLandmark ? `<${blockLandmark}>${html}</${blockLandmark}>` : html;
      inner.push(blockHtml);

      const stripped = stripHtml(html);
      if (stripped) allTexts.push(stripped);
    }

    if (inner.length === 0) continue;
    const innerHtml = inner.join('\n');

    // Outer landmark wrapper from the root section's role (e.g. a
    // section flagged as `banner` wraps its children in <header>).
    const rootRole =
      rootSection?.a11y?.role
      || rootSection?.role
      || rootSection?.content?.role
      || null;
    const rootLandmark = resolveLandmarkRole(rootRole);
    sections.push(rootLandmark ? `<${rootLandmark}>${innerHtml}</${rootLandmark}>` : innerHtml);
  }

  return { sections, firstImage, allTexts };
}

// Walk a canvas_design document and return all dynamic data blocks (in
// source order) that the prerender knows how to inline.
const INLINE_CANVAS_BLOCK_TYPES = new Set([
  'event-list', 'article-list', 'resource-list', 'campaign-embed',
]);

function collectCanvasBlocks(design) {
  const out = [];
  if (!design || typeof design !== 'object') return out;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type && INLINE_CANVAS_BLOCK_TYPES.has(node.type)) out.push(node);
    // Recurse into common container fields. Canvas blocks may nest children
    // under `children`, `sections`, `blocks`, `columns`, or `items`.
    const containers = ['children', 'sections', 'blocks', 'columns', 'items', 'rows'];
    for (const key of containers) {
      const arr = node[key];
      if (Array.isArray(arr)) arr.forEach(visit);
    }
    if (node.content && typeof node.content === 'object') {
      for (const key of containers) {
        const arr = node.content[key];
        if (Array.isArray(arr)) arr.forEach(visit);
      }
    }
  };
  const sections = Array.isArray(design.root?.sections) ? design.root.sections : [];
  sections.forEach(visit);
  return out;
}

function clampLimit(n, def, max) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(max, Math.floor(v));
}

async function renderCanvasDynamicBlock(supabaseClient, tenant, block) {
  const c = block.content || {};
  try {
    if (block.type === 'event-list') {
      const limit = clampLimit(c.limit, 6, 20);
      let q = supabaseClient
        .from('event')
        .select('id, title, slug, summary, description, start_date, location, image_url, is_featured')
        .eq('tenant_id', tenant.id)
        .is('member_group_id', null)
        .eq('status', 'published');
      const filter = c.filter || 'upcoming';
      const nowIso = new Date().toISOString();
      if (filter === 'upcoming') q = q.gte('start_date', nowIso).order('start_date', { ascending: true });
      else if (filter === 'past') q = q.lt('start_date', nowIso).order('start_date', { ascending: false });
      else q = q.order('start_date', { ascending: c.sortBy !== 'start-desc' });
      if (c.featuredOnly) q = q.eq('is_featured', true);
      const { data } = await q.limit(limit);
      const items = data || [];
      if (items.length === 0) return null;
      const texts = []; let firstImage = null;
      const cards = items.map((e) => {
        if (!firstImage && e.image_url) firstImage = e.image_url;
        const summary = e.summary || stripHtml(e.description || '');
        if (e.title) texts.push(e.title);
        if (summary) texts.push(summary);
        return `<article>
  <h3>${escapeHtml(e.title || '')}</h3>
  ${e.start_date ? `<p><strong>Date:</strong> ${escapeHtml(new Date(e.start_date).toLocaleDateString('en-GB', { dateStyle: 'long' }))}</p>` : ''}
  ${e.location ? `<p><strong>Location:</strong> ${escapeHtml(e.location)}</p>` : ''}
  ${summary ? `<p>${escapeHtml(truncate(summary, 240))}</p>` : ''}
  ${e.slug || e.id ? `<p><a href="/Events/${escapeHtml(e.slug || e.id)}">View event</a></p>` : ''}
</article>`;
      }).join('\n');
      const html = `<section>${c.title ? `<h2>${escapeHtml(c.title)}</h2>` : ''}${cards}</section>`;
      return { html, texts, firstImage };
    }

    if (block.type === 'article-list') {
      const limit = clampLimit(c.limit, 6, 20);
      const source = c.source === 'news' ? 'news_post' : 'blog_post';
      const { data } = await supabaseClient
        .from(source)
        .select('id, title, slug, summary, content, feature_image_url, published_date')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .order('published_date', { ascending: false })
        .limit(limit);
      const items = data || [];
      if (items.length === 0) return null;
      const texts = []; let firstImage = null;
      const linkBase = source === 'news_post' ? '/NewsView?slug=' : '/Articles?slug=';
      const cards = items.map((a) => {
        if (!firstImage && a.feature_image_url) firstImage = a.feature_image_url;
        const summary = a.summary || stripHtml(a.content || '');
        if (a.title) texts.push(a.title);
        if (summary) texts.push(summary);
        return `<article>
  <h3>${escapeHtml(a.title || '')}</h3>
  ${a.published_date ? `<p><strong>Published:</strong> ${escapeHtml(new Date(a.published_date).toLocaleDateString('en-GB', { dateStyle: 'long' }))}</p>` : ''}
  ${summary ? `<p>${escapeHtml(truncate(summary, 240))}</p>` : ''}
  ${a.slug ? `<p><a href="${linkBase}${escapeHtml(a.slug)}">Read more</a></p>` : ''}
</article>`;
      }).join('\n');
      const html = `<section>${c.title ? `<h2>${escapeHtml(c.title)}</h2>` : ''}${cards}</section>`;
      return { html, texts, firstImage };
    }

    if (block.type === 'resource-list') {
      const limit = clampLimit(c.limit, 6, 20);
      let q = supabaseClient
        .from('resource')
        .select('id, title, slug, description, resource_type, image_url, status, is_public, target_url')
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (c.resourceType) q = q.eq('resource_type', c.resourceType);
      const { data } = await q.limit(limit);
      const items = (data || []).filter((r) => r.is_public !== false);
      if (items.length === 0) return null;
      const texts = []; let firstImage = null;
      const cards = items.map((r) => {
        if (!firstImage && r.image_url) firstImage = r.image_url;
        if (r.title) texts.push(r.title);
        if (r.description) texts.push(stripHtml(r.description));
        return `<article>
  <h3>${escapeHtml(r.title || '')}</h3>
  ${r.resource_type ? `<p><strong>Type:</strong> ${escapeHtml(r.resource_type)}</p>` : ''}
  ${r.description ? `<p>${escapeHtml(truncate(stripHtml(r.description), 240))}</p>` : ''}
</article>`;
      }).join('\n');
      const html = `<section>${c.title ? `<h2>${escapeHtml(c.title)}</h2>` : ''}${cards}</section>`;
      return { html, texts, firstImage };
    }

    if (block.type === 'campaign-embed') {
      if (!c.campaignSlug) return null;
      const { data: campaign } = await supabaseClient
        .from('fundraising_campaign')
        .select('id, name, slug, public_description, description, cover_image_url, goal_amount, currency, status, hide_campaign_target')
        .eq('tenant_id', tenant.id)
        .eq('slug', c.campaignSlug)
        .single();
      if (!campaign || campaign.status !== 'active') return null;
      const texts = [];
      if (campaign.name) texts.push(campaign.name);
      const desc = campaign.public_description || campaign.description;
      if (desc) texts.push(stripHtml(desc));
      const html = `<section>
  <h2>${escapeHtml(campaign.name || '')}</h2>
  ${desc ? `<p>${escapeHtml(truncate(stripHtml(desc), 300))}</p>` : ''}
  ${!campaign.hide_campaign_target && campaign.goal_amount ? `<p><strong>Goal:</strong> ${escapeHtml(String(campaign.goal_amount))} ${escapeHtml(campaign.currency || '')}</p>` : ''}
  <p><a href="/Campaign/${escapeHtml(campaign.slug)}">Donate now</a></p>
</section>`;
      return { html, texts, firstImage: campaign.cover_image_url || null };
    }
  } catch (err) {
    console.error('[Prerender] Failed to inline canvas block', block.type, err);
  }
  return null;
}

async function renderCustomPage(supabaseClient, tenant, pageSlug, baseUrl, options = {}) {
  if (!pageSlug) return null;

  const microsite = options.microsite || null;
  const escapedSlug = pageSlug.replace(/([\\%_])/g, '\\$1');

  // Microsite pages live at /{prefix}/{slug}; default-site pages at /{slug}.
  // Scope the lookup by microsite_id so (a) a microsite request only resolves
  // pages owned by that microsite, and (b) a bare /{slug} default-site request
  // excludes microsite-owned pages — both preventing cross-leaks and avoiding a
  // multi-row `.single()` error when the same slug exists on the default site
  // and a microsite. Legacy-tolerant: databases without the microsite_id column
  // (42703) retry the unscoped query so the default site keeps working.
  const buildQuery = (scoped) => {
    let q = supabaseClient
      .from('i_edit_page')
      .select('id, title, slug, description, meta_title, meta_description, seo_title, seo_description, og_image_url, builder_type, canvas_design')
      .eq('tenant_id', tenant.id)
      .ilike('slug', escapedSlug)
      .eq('status', 'published')
      .in('layout_type', ['public', 'hybrid']);
    if (scoped) {
      q = microsite ? q.eq('microsite_id', microsite.id) : q.is('microsite_id', null);
    }
    return q.single();
  };

  let { data: page, error } = await buildQuery(true);
  if (error && error.code === '42703') {
    ({ data: page } = await buildQuery(false));
  }

  if (!page) return null;

  const allTexts = [];
  const bodySections = [];
  let ogImage = null;

  if (page.builder_type === 'canvas') {
    // Canvas Builder pages: walk the canvas_design tree block-by-block,
    // preserving heading levels, images with alt text, buttons-as-links,
    // and FAQ/testimonial structure. Crawlers/social unfurl bots see the
    // full semantic body up-front without waiting for JS to hydrate.
    // Then inline content from dynamic data blocks so social unfurls /
    // SEO crawlers get the same first-N items a visitor sees.
    if (page.canvas_design && typeof page.canvas_design === 'object') {
      const { sections, firstImage, allTexts: canvasTexts } = renderCanvasDesignBody(page.canvas_design);
      for (const s of sections) bodySections.push(s);
      for (const t of canvasTexts) {
        if (t && !isPlaceholderText(t)) allTexts.push(t);
      }
      if (firstImage) ogImage = firstImage;

      const dynamicBlocks = collectCanvasBlocks(page.canvas_design);
      for (const block of dynamicBlocks) {
        const section = await renderCanvasDynamicBlock(supabaseClient, tenant, block);
        if (section) {
          if (section.html) bodySections.push(section.html);
          if (section.texts) allTexts.push(...section.texts);
          if (!ogImage && section.firstImage) ogImage = section.firstImage;
        }
      }
    }
  } else {
    const { data: elements } = await supabaseClient
      .from('i_edit_page_element')
      .select('element_type, content')
      .eq('page_id', page.id)
      .order('display_order', { ascending: true });

    if (elements) {
      for (const el of elements) {
        if (!el.content) continue;

        if (typeof el.content === 'string') {
          const text = stripHtml(el.content);
          if (text) {
            allTexts.push(text);
            bodySections.push(`<section><p>${escapeHtml(text)}</p></section>`);
          }
        } else if (typeof el.content === 'object') {
          const texts = extractTextFromContent(el.content);
          allTexts.push(...texts);

          const section = buildElementSection(el);
          if (section) bodySections.push(section);

          if (!ogImage) {
            ogImage = extractFirstImage(el.content);
          }
        }
      }
    }
  }

  const textContent = allTexts.join(' ');
  const pageTitle = page.meta_title || page.title;
  const pageDesc = page.meta_description || page.description || truncate(textContent);
  // Per-page social override fields mirror the iEdit/IEditPage pattern:
  // seo_title / seo_description / og_image_url win over auto-derived values
  // for link unfurls; if blank, fall back to the page-level metadata above
  // (which itself falls back to tenant defaults via the caller).
  const socialTitle = page.seo_title || pageTitle;
  const socialDesc = page.seo_description || pageDesc;
  if (page.og_image_url) {
    ogImage = page.og_image_url;
  }

  const seenTexts = new Set();
  const deduplicatedSections = bodySections.filter(section => {
    const sectionText = stripHtml(section);
    if (!sectionText || sectionText.length < 10) return false;
    const normalised = sectionText.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenTexts.has(normalised)) return false;
    seenTexts.add(normalised);
    return true;
  });

  const result = {
    title: `${socialTitle} | ${tenant.name}`,
    description: truncate(socialDesc),
    ogUrl: microsite
      ? `${baseUrl}/${microsite.path_prefix}/${page.slug}`
      : `${baseUrl}/${page.slug}`,
    bodyContent: `
      <article>
        <h1>${escapeHtml(pageTitle)}</h1>
        ${pageDesc ? `<p>${escapeHtml(truncate(pageDesc, 300))}</p>` : ''}
        ${deduplicatedSections.join('\n')}
      </article>`
  };

  if (ogImage) {
    result.ogImage = ogImage;
  }

  return result;
}

async function renderListPage(supabaseClient, tenant, pageType, baseUrl) {
  const pages = {
    'PublicEvents': {
      title: `Events | ${tenant.name}`,
      description: `Browse upcoming events from ${tenant.name}`,
      query: async () => {
        let result = await supabaseClient
          .from('event')
          .select('id, title, slug, start_date, location, summary')
          .eq('tenant_id', tenant.id)
          .in('status', ['published', 'tbc'])
          .is('member_group_id', null)
          .order('start_date', { ascending: true })
          .limit(50);
        if (result.error?.code === '42703') {
          result = await supabaseClient
            .from('event')
            .select('id, title, slug, start_date, location, summary')
            .in('status', ['published', 'tbc'])
            .is('member_group_id', null)
            .order('start_date', { ascending: true })
            .limit(50);
        }
        return (result.data || []).map(e => `<li><strong>${escapeHtml(e.title)}</strong>${e.start_date ? ` - ${escapeHtml(new Date(e.start_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}` : ''}${e.location ? ` | ${escapeHtml(e.location)}` : ''}</li>`).join('\n');
      }
    },
    'PublicArticles': {
      title: `Articles | ${tenant.name}`,
      description: `Read the latest articles from ${tenant.name}`,
      query: async () => {
        const { data } = await supabaseClient
          .from('blog_post')
          .select('id, title, summary, published_date')
          .eq('tenant_id', tenant.id)
          .eq('status', 'published')
          .order('published_date', { ascending: false })
          .limit(50);
        return (data || []).map(a => `<li><strong>${escapeHtml(a.title)}</strong>${a.published_date ? ` - ${escapeHtml(new Date(a.published_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}` : ''}</li>`).join('\n');
      }
    },
    'PublicNews': {
      title: `News | ${tenant.name}`,
      description: `Latest news from ${tenant.name}`,
      query: async () => {
        const { data } = await supabaseClient
          .from('news_post')
          .select('id, title, summary, published_date')
          .eq('tenant_id', tenant.id)
          .eq('status', 'published')
          .order('published_date', { ascending: false })
          .limit(50);
        return (data || []).map(n => `<li><strong>${escapeHtml(n.title)}</strong>${n.published_date ? ` - ${escapeHtml(new Date(n.published_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}` : ''}</li>`).join('\n');
      }
    },
    'JobBoard': {
      title: `Jobs | ${tenant.name}`,
      description: `Browse job opportunities from ${tenant.name}`,
      query: async () => {
        const { data } = await supabaseClient
          .from('job_posting')
          .select('id, title, company_name, location, job_type')
          .eq('tenant_id', tenant.id)
          .eq('status', 'active')
          .order('created_date', { ascending: false })
          .limit(50);
        return (data || []).map(j => `<li><strong>${escapeHtml(j.title)}</strong>${j.company_name ? ` at ${escapeHtml(j.company_name)}` : ''}${j.location ? ` | ${escapeHtml(j.location)}` : ''}</li>`).join('\n');
      }
    },
    'OrganisationDirectory': {
      title: `Organisation Directory | ${tenant.name}`,
      description: `Browse organisations in the ${tenant.name} directory`,
      query: async () => ''
    },
    'Resources': {
      title: `Resources | ${tenant.name}`,
      description: `Browse resources from ${tenant.name}`,
      query: async () => {
        const { data } = await supabaseClient
          .from('resource')
          .select('id, title, description, resource_type, release_date')
          .eq('tenant_id', tenant.id)
          .eq('status', 'active')
          .order('release_date', { ascending: false })
          .limit(50);
        return (data || []).map(r => `<li><strong>${escapeHtml(r.title)}</strong>${r.resource_type ? ` (${escapeHtml(r.resource_type)})` : ''}${r.release_date ? ` - ${escapeHtml(new Date(r.release_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}` : ''}</li>`).join('\n');
      }
    }
  };

  const page = pages[pageType];
  if (!page) return null;

  const listItems = await page.query();

  return {
    title: page.title,
    description: page.description,
    ogUrl: `${baseUrl}/${pageType}`,
    bodyContent: `
      <h2>${escapeHtml(page.title)}</h2>
      <p>${escapeHtml(page.description)}</p>
      ${listItems ? `<ul>${listItems}</ul>` : ''}`
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) {
      return res.status(404).send('<html><body>Not found</body></html>');
    }

    const allowSearchIndexing = tenant.settings?.allow_search_indexing === true;
    if (!allowSearchIndexing) {
      return res.status(404).send('<html><body>Not found</body></html>');
    }

    const requestPath = req.query.path || '/';
    const baseUrl = getBaseUrl(req, tenant);

    const articleConfig = await getArticleUrlConfig(supabase, tenant.id);
    const articleBasePath = articleConfig.canonicalBasePath;
    const supportedArticleBasePaths = articleConfig.supportedBasePaths;
    const publicArticlesPageName = articleConfig.isCustomDisplay ? articleConfig.canonicalBaseSlug : 'PublicArticles';

    let pageData = null;

    const eventSlugMatch = requestPath.match(/^\/events\/([^/?]+)/);
    if (eventSlugMatch) {
      pageData = await renderEventPage(supabase, tenant, decodeURIComponent(eventSlugMatch[1]), null, baseUrl);
    }

    if (!pageData && requestPath.startsWith('/EventDetails')) {
      const url = new URL(requestPath, 'http://localhost');
      const eventId = url.searchParams.get('id');
      if (eventId) {
        pageData = await renderEventPage(supabase, tenant, null, eventId, baseUrl);
      }
    }

    if (!pageData) {
      for (const basePath of supportedArticleBasePaths) {
        const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = requestPath.match(new RegExp(`^${escaped}\\/([^/]+)\\/([^/?]+)`, 'i'));
        if (m) {
          pageData = await renderArticlePage(
            supabase,
            tenant,
            decodeURIComponent(m[1]),
            decodeURIComponent(m[2]),
            baseUrl,
            articleBasePath
          );
          if (pageData) break;
        }
      }
    }

    if (!pageData && requestPath.startsWith('/NewsView')) {
      const url = new URL(requestPath, 'http://localhost');
      const newsSlug = url.searchParams.get('slug');
      if (newsSlug) {
        pageData = await renderNewsPage(supabase, tenant, newsSlug, baseUrl);
      }
    }

    if (!pageData && requestPath.startsWith('/JobDetails')) {
      const url = new URL(requestPath, 'http://localhost');
      const jobId = url.searchParams.get('id');
      if (jobId) {
        pageData = await renderJobPage(supabase, tenant, jobId, baseUrl);
      }
    }

    if (!pageData && requestPath.startsWith('/ViewPage')) {
      const url = new URL(requestPath, 'http://localhost');
      const pageSlug = url.searchParams.get('slug');
      if (pageSlug) {
        pageData = await renderCustomPage(supabase, tenant, pageSlug, baseUrl);
      }
    }

    const listPages = [
      { type: 'PublicEvents', aliases: ['/Events', '/PublicEvents'], canonicalPath: '/Events' },
      { type: 'PublicNews', aliases: ['/News', '/PublicNews'], canonicalPath: '/News' },
      { type: 'JobBoard', aliases: ['/JobBoard'] },
      { type: 'OrganisationDirectory', aliases: ['/OrganisationDirectory'] },
      { type: 'Resources', aliases: ['/Resources'] },
    ];
    if (!pageData) {
      const normalizedReq = (requestPath.replace(/\/+$/, '') || '/').toLowerCase();
      const articleListPaths = new Set([
        `/${publicArticlesPageName}`,
        '/PublicArticles',
        ...supportedArticleBasePaths,
      ].map(p => p.toLowerCase()));
      if (articleListPaths.has(normalizedReq)) {
        pageData = await renderListPage(supabase, tenant, 'PublicArticles', baseUrl);
        if (pageData) {
          pageData.ogUrl = `${baseUrl}${articleConfig.canonicalListPath}`;
        }
      } else {
        for (const lp of listPages) {
          const aliasesLower = lp.aliases.map(a => a.toLowerCase());
          if (aliasesLower.includes(normalizedReq)) {
            pageData = await renderListPage(supabase, tenant, lp.type, baseUrl);
            if (pageData && lp.canonicalPath) {
              pageData.ogUrl = `${baseUrl}${lp.canonicalPath}`;
            }
            break;
          }
        }
      }
    }

    if (!pageData) {
      const bareSlugMatch = requestPath.match(/^\/([a-zA-Z][a-zA-Z0-9-]+)$/);
      if (bareSlugMatch) {
        pageData = await renderCustomPage(supabase, tenant, decodeURIComponent(bareSlugMatch[1]), baseUrl);
      }
    }

    // Microsite custom pages served at /{prefix}/{slug}. Runs after every
    // single-segment route (events, articles, list pages, bare slug) so it can
    // never shadow them; the two-segment shape can't match those anyway. Only a
    // prefix that resolves to an ACTIVE microsite proceeds — otherwise pageData
    // stays null and we fall through to redirects / 404 as before.
    if (!pageData) {
      const micrositePathMatch = requestPath.match(/^\/([^/?#]+)\/([^/?#]+)\/?(?:[?#]|$)/);
      if (micrositePathMatch) {
        const prefix = decodeURIComponent(micrositePathMatch[1]);
        const slug = decodeURIComponent(micrositePathMatch[2]);
        const microsite = await resolveMicrositeByPrefix(supabase, tenant.id, prefix);
        if (microsite) {
          pageData = await renderCustomPage(supabase, tenant, slug, baseUrl, { microsite });
        }
      }
    }

    if (!pageData && (requestPath === '/' || requestPath === '/Home')) {
      pageData = {
        title: tenant.name,
        description: tenant.tagline || `Welcome to ${tenant.name}`,
        ogUrl: baseUrl,
        bodyContent: `
          <h2>${escapeHtml(tenant.name)}</h2>
          ${tenant.tagline ? `<p>${escapeHtml(tenant.tagline)}</p>` : ''}`
      };
    }

    if (!pageData) {
      try {
        const { data: mappings } = await supabase
          .from('redirect_mapping')
          .select('source_pattern, target_url, match_type, status_code')
          .eq('is_active', true)
          .order('priority', { ascending: true });

        if (mappings && mappings.length > 0) {
          const normalizedPath = requestPath.replace(/\/+$/, '') || '/';
          const normalizedPathLower = normalizedPath.toLowerCase();

          for (const mapping of mappings) {
            let sourcePattern = (mapping.source_pattern || '').replace(/\/+$/, '') || '/';
            if (sourcePattern !== '/' && !sourcePattern.startsWith('/')) {
              sourcePattern = '/' + sourcePattern;
            }
            const sourcePatternLower = sourcePattern.toLowerCase();

            let matched = false;
            let targetUrl = mapping.target_url;

            if (mapping.match_type === 'exact') {
              matched = normalizedPathLower === sourcePatternLower;
            } else if (mapping.match_type === 'prefix') {
              if (normalizedPathLower.startsWith(sourcePatternLower)) {
                matched = true;
                if (targetUrl.endsWith('*')) {
                  const remainingPath = normalizedPath.slice(sourcePattern.length);
                  targetUrl = targetUrl.slice(0, -1) + remainingPath;
                }
              }
            } else if (mapping.match_type === 'regex') {
              try {
                const regex = new RegExp(mapping.source_pattern, 'i');
                if (regex.test(normalizedPath)) {
                  matched = true;
                  targetUrl = normalizedPath.replace(regex, mapping.target_url);
                }
              } catch (e) {}
            }

            if (matched) {
              const statusCode = mapping.status_code || 301;
              const absoluteTarget = targetUrl.startsWith('http') ? targetUrl : `${baseUrl}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
              res.setHeader('Location', absoluteTarget);
              return res.status(statusCode).end();
            }
          }
        }
      } catch (redirectErr) {
        console.error('[Prerender] Redirect lookup error:', redirectErr);
      }

      // Tenant-configurable 404: if settings.not_found_page_slug points at
      // a published Canvas page, render its body/meta with a 404 status
      // (so search engines de-index correctly while users see a branded
      // page). Falls back to the generic gone message below.
      const notFoundSlug = tenant.settings?.not_found_page_slug;
      if (notFoundSlug && typeof notFoundSlug === 'string') {
        try {
          const notFoundPage = await renderCustomPage(supabase, tenant, notFoundSlug, baseUrl);
          if (notFoundPage) {
            const html = buildHtmlPage({
              title: notFoundPage.title,
              description: notFoundPage.description,
              ogTitle: notFoundPage.title,
              ogDescription: notFoundPage.description,
              ogImage: notFoundPage.ogImage,
              ogUrl: `${baseUrl}${requestPath}`,
              canonicalUrl: null,
              bodyContent: notFoundPage.bodyContent,
              tenantName: tenant.name,
              favicon: tenant.favicon_url,
              navLinks: [],
            }).replace(
              '<meta name="robots" content="index, follow">',
              '<meta name="robots" content="noindex, follow">',
            );
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
            return res.status(404).send(html);
          }
        } catch (notFoundErr) {
          console.error('[Prerender] Tenant 404 page render failed:', notFoundErr);
        }
      }

      const goneHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <title>Page Not Found</title>
</head>
<body>
  <h1>Page not found</h1>
  <p>The page you requested does not exist.</p>
  <p><a href="${baseUrl}">Return to homepage</a></p>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(404).send(goneHtml);
    }

    let navLinks = [];
    try {
      const { data: navItems } = await supabase
        .from('navigation_item')
        .select('title, url, display_order, location, parent_id')
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .is('parent_id', null)
        .order('display_order', { ascending: true })
        .limit(20);
      if (navItems && navItems.length > 0) {
        navLinks = navItems
          .filter(n => n.title && n.url)
          .map(n => ({
            label: n.title,
            url: n.url.startsWith('http') ? n.url : `${baseUrl}${n.url.startsWith('/') ? '' : '/'}${n.url}`,
          }));
      }
    } catch (navErr) {
    }

    const html = buildHtmlPage({
      title: pageData.title,
      description: pageData.description,
      ogTitle: pageData.title,
      ogDescription: pageData.description,
      ogImage: pageData.ogImage,
      ogUrl: pageData.ogUrl,
      canonicalUrl: pageData.ogUrl,
      bodyContent: pageData.bodyContent,
      tenantName: tenant.name,
      favicon: tenant.favicon_url,
      navLinks,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.status(200).send(html);
  } catch (error) {
    console.error('[Prerender] Error:', error);
    return res.status(500).send('<html><body>Internal server error</body></html>');
  }
}
