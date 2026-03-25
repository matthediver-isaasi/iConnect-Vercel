import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

function getArticleUrlParts(article, authorHandles = {}) {
  let authorHandle = 'guest';
  if (article.author_id) {
    if (authorHandles[article.author_id]) {
      authorHandle = authorHandles[article.author_id];
    } else {
      const byHandleMatch = (article.slug || '').match(/-by-([a-z0-9-]+)$/i);
      if (byHandleMatch) {
        authorHandle = byHandleMatch[1];
      }
    }
  }

  let cleanSlug = article.slug || '';
  const byHandleMatch = cleanSlug.match(/-by-([a-z0-9-]+)$/i);
  if (byHandleMatch) {
    cleanSlug = cleanSlug.slice(0, -byHandleMatch[0].length);
  }

  return { authorHandle, cleanSlug };
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getBaseUrl(req, tenant) {
  const protocol = 'https';
  if (tenant.domain) {
    return `${protocol}://${tenant.domain}`;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${protocol}://${host.split(':')[0]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');

  if (req.method !== 'GET') {
    return res.status(405).send('<?xml version="1.0" encoding="UTF-8"?><error>Method not allowed</error>');
  }

  if (!supabase) {
    return res.status(503).send('<?xml version="1.0" encoding="UTF-8"?><error>Database not configured</error>');
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><error>Tenant not found</error>');
    }

    const allowSearchIndexing = tenant.settings?.allow_search_indexing === true;
    if (!allowSearchIndexing) {
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><error>Sitemap not available</error>');
    }

    const baseUrl = getBaseUrl(req, tenant);
    const urls = [];

    urls.push({ loc: baseUrl + '/', changefreq: 'daily', priority: '1.0' });
    urls.push({ loc: baseUrl + '/PublicEvents', changefreq: 'daily', priority: '0.8' });
    urls.push({ loc: baseUrl + '/PublicNews', changefreq: 'daily', priority: '0.7' });
    urls.push({ loc: baseUrl + '/JobBoard', changefreq: 'daily', priority: '0.7' });
    urls.push({ loc: baseUrl + '/OrganisationDirectory', changefreq: 'weekly', priority: '0.6' });

    const { data: articleUrlSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('tenant_id', tenant.id)
      .eq('setting_key', 'article_url_slug')
      .maybeSingle();

    const articleBaseSlug = articleUrlSetting?.setting_value;
    const isCustomArticleSlug = articleBaseSlug && articleBaseSlug !== 'articles';
    const articlesListPath = isCustomArticleSlug ? `/${articleBaseSlug}` : '/PublicArticles';
    const articleBasePath = isCustomArticleSlug ? `/${articleBaseSlug}` : '/articles';

    urls.push({ loc: baseUrl + articlesListPath, changefreq: 'daily', priority: '0.8' });

    const [eventsResult, articlesResult, newsResult, jobsResult, customPagesResult] = await Promise.all([
      supabase
        .from('event')
        .select('id, slug, start_date, updated_at')
        .eq('tenant_id', tenant.id)
        .in('status', ['published', 'tbc'])
        .order('start_date', { ascending: false }),

      supabase
        .from('blog_post')
        .select('id, slug, author_id, guest_writer_id, published_date, updated_at')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .order('published_date', { ascending: false }),

      supabase
        .from('news_post')
        .select('id, slug, published_date, updated_at')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .order('published_date', { ascending: false }),

      supabase
        .from('job_posting')
        .select('id, created_date, updated_at')
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')
        .order('created_date', { ascending: false }),

      supabase
        .from('i_edit_page')
        .select('id, slug, title, updated_at')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .in('layout_type', ['public', 'hybrid'])
    ]);

    if (eventsResult.data) {
      for (const event of eventsResult.data) {
        const path = event.slug
          ? `/events/${encodeURIComponent(event.slug)}`
          : `/EventDetails?id=${event.id}`;
        urls.push({
          loc: baseUrl + path,
          lastmod: formatDate(event.updated_at || event.start_date),
          changefreq: 'weekly',
          priority: '0.7'
        });
      }
    }

    if (articlesResult.data && articlesResult.data.length > 0) {
      const authorIds = [...new Set(articlesResult.data.filter(a => a.author_id).map(a => a.author_id))];
      let authorHandles = {};

      if (authorIds.length > 0) {
        const { data: members } = await supabase
          .from('member')
          .select('id, handle')
          .eq('tenant_id', tenant.id)
          .in('id', authorIds);

        if (members) {
          members.forEach(m => {
            authorHandles[m.id] = m.handle;
          });
        }
      }

      for (const article of articlesResult.data) {
        const { authorHandle, cleanSlug } = getArticleUrlParts(article, authorHandles);
        const path = `${articleBasePath}/${encodeURIComponent(authorHandle)}/${encodeURIComponent(cleanSlug)}`;
        urls.push({
          loc: baseUrl + path,
          lastmod: formatDate(article.updated_at || article.published_date),
          changefreq: 'monthly',
          priority: '0.6'
        });
      }
    }

    if (newsResult.data) {
      for (const news of newsResult.data) {
        const path = `/NewsView?slug=${encodeURIComponent(news.slug || news.id)}`;
        urls.push({
          loc: baseUrl + path,
          lastmod: formatDate(news.updated_at || news.published_date),
          changefreq: 'monthly',
          priority: '0.6'
        });
      }
    }

    if (jobsResult.data) {
      for (const job of jobsResult.data) {
        const path = `/JobDetails?id=${job.id}`;
        urls.push({
          loc: baseUrl + path,
          lastmod: formatDate(job.updated_at || job.created_date),
          changefreq: 'weekly',
          priority: '0.6'
        });
      }
    }

    if (customPagesResult.data) {
      for (const page of customPagesResult.data) {
        const path = `/ViewPage?slug=${encodeURIComponent(page.slug)}`;
        urls.push({
          loc: baseUrl + path,
          lastmod: formatDate(page.updated_at),
          changefreq: 'weekly',
          priority: '0.5'
        });
      }
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const url of urls) {
      xml += '  <url>\n';
      xml += `    <loc>${escapeXml(url.loc)}</loc>\n`;
      if (url.lastmod) {
        xml += `    <lastmod>${url.lastmod}</lastmod>\n`;
      }
      if (url.changefreq) {
        xml += `    <changefreq>${url.changefreq}</changefreq>\n`;
      }
      if (url.priority) {
        xml += `    <priority>${url.priority}</priority>\n`;
      }
      xml += '  </url>\n';
    }

    xml += '</urlset>';

    return res.status(200).send(xml);
  } catch (error) {
    console.error('[Sitemap] Error:', error);
    return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Internal server error</error>');
  }
}
