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
  if (tenant.domain) {
    return `${protocol}://${tenant.domain}`;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${protocol}://${host.split(':')[0]}`;
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

  const { data: event } = await query.single();
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

async function renderCustomPage(supabaseClient, tenant, pageSlug, baseUrl) {
  if (!pageSlug) return null;

  const { data: page } = await supabaseClient
    .from('i_edit_page')
    .select('id, title, slug, description')
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

  let textContent = '';
  if (elements) {
    for (const el of elements) {
      if (el.content) {
        const text = typeof el.content === 'string' ? stripHtml(el.content) : '';
        if (text) textContent += text + ' ';
      }
    }
  }

  const desc = truncate(page.description || textContent);

  return {
    title: `${page.title} | ${tenant.name}`,
    description: desc,
    ogUrl: `${baseUrl}/ViewPage?slug=${page.slug}`,
    bodyContent: `
      <article>
        <h2>${escapeHtml(page.title)}</h2>
        ${page.description ? `<p>${escapeHtml(page.description)}</p>` : ''}
        ${textContent ? `<div>${escapeHtml(truncate(textContent, 1000))}</div>` : ''}
      </article>`
  };
}

async function renderListPage(supabaseClient, tenant, pageType, baseUrl) {
  const pages = {
    'PublicEvents': {
      title: `Events | ${tenant.name}`,
      description: `Browse upcoming events from ${tenant.name}`,
      query: async () => {
        const { data } = await supabaseClient
          .from('event')
          .select('id, title, slug, start_date, location, summary')
          .eq('tenant_id', tenant.id)
          .in('status', ['published', 'tbc'])
          .order('start_date', { ascending: true })
          .limit(50);
        return (data || []).map(e => `<li><strong>${escapeHtml(e.title)}</strong>${e.start_date ? ` - ${escapeHtml(new Date(e.start_date).toLocaleDateString('en-US', { dateStyle: 'long' }))}` : ''}${e.location ? ` | ${escapeHtml(e.location)}` : ''}</li>`).join('\n');
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

    const listPages = ['PublicEvents', 'PublicNews', 'JobBoard', 'OrganisationDirectory'];
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
