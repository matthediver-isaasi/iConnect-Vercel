import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(str, maxLen = 160) {
  if (!str) return '';
  const clean = str.substring(0, maxLen);
  return clean.length < str.length ? clean + '...' : clean;
}

function buildHtmlPage({ title, description, ogTitle, ogDescription, ogImage, ogUrl, canonicalUrl, bodyContent, tenantName, favicon }) {
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
</head>
<body>
  <header><h1>${escapeHtml(tenantName || '')}</h1></header>
  <main>
    ${bodyContent}
  </main>
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
    .eq('tenant_id', tenant.id);

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
      .select('id, title, slug, description, summary, start_date, end_date, location, image_url, status');
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

function buildElementSection(el) {
  if (!el.content || typeof el.content !== 'object') return '';

  const content = el.content;
  const parts = [];

  const headingFields = ['heading', 'header', 'header_title', 'title'];
  for (const f of headingFields) {
    if (typeof content[f] === 'string') {
      const cleaned = stripHtml(content[f]);
      if (cleaned) {
        parts.push(`<h2>${escapeHtml(cleaned)}</h2>`);
        break;
      }
    }
  }

  const subheadingFields = ['subheading', 'subtitle', 'header_subtitle'];
  for (const f of subheadingFields) {
    if (typeof content[f] === 'string') {
      const cleaned = stripHtml(content[f]);
      if (cleaned) {
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
      if (cleaned) {
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
      if (h) parts.push(`<h3>${escapeHtml(h)}</h3>`);
    }
    if (typeof content[tf] === 'string') {
      const t = stripHtml(content[tf]);
      if (t) parts.push(`<p>${escapeHtml(t)}</p>`);
    }
  }

  if (typeof content.quote_text === 'string') {
    const qt = stripHtml(content.quote_text);
    if (qt) parts.push(`<blockquote>${escapeHtml(qt)}</blockquote>`);
  }
  if (typeof content.author_name === 'string') {
    const an = stripHtml(content.author_name);
    if (an) parts.push(`<p>${escapeHtml(an)}</p>`);
  }

  const arrayKeys = ['items', 'quotes', 'column_content', 'sub_items'];
  for (const key of arrayKeys) {
    if (Array.isArray(content[key])) {
      for (const item of content[key]) {
        if (item && typeof item === 'object') {
          const texts = extractTextFromContent(item);
          for (const t of texts) {
            parts.push(`<p>${escapeHtml(t)}</p>`);
          }
        }
      }
    }
  }

  if (parts.length === 0) return '';
  return `<section>${parts.join('\n')}</section>`;
}

async function renderCustomPage(supabaseClient, tenant, pageSlug, baseUrl) {
  if (!pageSlug) return null;

  const { data: page } = await supabaseClient
    .from('i_edit_page')
    .select('id, title, slug, description, meta_title, meta_description')
    .eq('tenant_id', tenant.id)
    .eq('slug', pageSlug)
    .eq('status', 'published')
    .in('layout_type', ['public', 'hybrid'])
    .single();

  if (!page) return null;

  const { data: elements } = await supabaseClient
    .from('i_edit_page_element')
    .select('element_type, content')
    .eq('page_id', page.id)
    .order('display_order', { ascending: true });

  const allTexts = [];
  const bodySections = [];
  let ogImage = null;

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

  const textContent = allTexts.join(' ');
  const pageTitle = page.meta_title || page.title;
  const pageDesc = page.meta_description || page.description || truncate(textContent);

  const result = {
    title: `${pageTitle} | ${tenant.name}`,
    description: truncate(pageDesc),
    ogUrl: `${baseUrl}/${page.slug}`,
    bodyContent: `
      <article>
        <h1>${escapeHtml(pageTitle)}</h1>
        ${pageDesc ? `<p>${escapeHtml(truncate(pageDesc, 300))}</p>` : ''}
        ${bodySections.join('\n')}
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
          .order('start_date', { ascending: true })
          .limit(50);
        if (result.error?.code === '42703') {
          result = await supabaseClient
            .from('event')
            .select('id, title, slug, start_date, location, summary')
            .in('status', ['published', 'tbc'])
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

    const { data: articleUrlSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('tenant_id', tenant.id)
      .eq('setting_key', 'article_url_slug')
      .maybeSingle();

    const articleBaseSlug = articleUrlSetting?.setting_value;
    const isCustomArticleSlug = articleBaseSlug && articleBaseSlug !== 'articles';
    const articleBasePath = isCustomArticleSlug ? `/${articleBaseSlug}` : '/articles';
    const publicArticlesPageName = isCustomArticleSlug ? articleBaseSlug : 'PublicArticles';

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

    const articleMatch = requestPath.match(new RegExp(`^${articleBasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/([^/]+)\\/([^/?]+)`));
    if (!pageData && articleMatch) {
      pageData = await renderArticlePage(supabase, tenant, decodeURIComponent(articleMatch[1]), decodeURIComponent(articleMatch[2]), baseUrl, articleBasePath);
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

    const listPages = ['PublicEvents', 'PublicNews', 'JobBoard', 'OrganisationDirectory', 'Resources'];
    if (!pageData) {
      if (requestPath === `/${publicArticlesPageName}` || requestPath === '/PublicArticles') {
        pageData = await renderListPage(supabase, tenant, 'PublicArticles', baseUrl);
      } else {
        for (const lp of listPages) {
          if (requestPath === `/${lp}`) {
            pageData = await renderListPage(supabase, tenant, lp, baseUrl);
            break;
          }
        }
      }
    }

    if (!pageData) {
      const bareSlugMatch = requestPath.match(/^\/([a-z][a-z0-9-]+)$/);
      if (bareSlugMatch) {
        pageData = await renderCustomPage(supabase, tenant, decodeURIComponent(bareSlugMatch[1]), baseUrl);
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
      return res.status(404).send('<html><body>Page not found</body></html>');
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
      favicon: tenant.favicon_url
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.status(200).send(html);
  } catch (error) {
    console.error('[Prerender] Error:', error);
    return res.status(500).send('<html><body>Internal server error</body></html>');
  }
}
