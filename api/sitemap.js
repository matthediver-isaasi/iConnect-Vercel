import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).send('Database not configured');
  }

  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'] || req.headers['x-forwarded-host'];
    const appBaseUrl = process.env.APP_BASE_URL || `${protocol}://${host}`;

    const [articlesResult, newsResult, jobsResult, pagesResult] = await Promise.all([
      supabase.from('blog_post').select('*'),
      supabase.from('news_post').select('*'),
      supabase.from('job_posting').select('*'),
      supabase.from('iedit_page').select('*')
    ]);

    const publishedArticles = (articlesResult.data || []).filter(
      a => a.status === 'published' && a.published_date && new Date(a.published_date) <= new Date()
    );

    const publishedNews = (newsResult.data || []).filter(
      n => n.status === 'published' && n.published_date && new Date(n.published_date) <= new Date()
    );

    const activeJobs = (jobsResult.data || []).filter(j => j.status === 'active');

    const publicPages = (pagesResult.data || []).filter(p => p.is_public);

    const staticPages = [
      { loc: '/', priority: '1.0' },
      { loc: '/PublicEvents', priority: '0.8' },
      { loc: '/PublicArticles', priority: '0.8' },
      { loc: '/PublicNews', priority: '0.8' },
      { loc: '/PublicResources', priority: '0.8' },
      { loc: '/JobBoard', priority: '0.8' },
      { loc: '/PostJob', priority: '0.7' },
      { loc: '/OrganisationDirectory', priority: '0.7' },
    ];

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<!-- Sitemap generated at ${new Date().toISOString()} -->\n`;
    xml += `<!-- Articles: ${publishedArticles.length}, News: ${publishedNews.length}, Jobs: ${activeJobs.length}, Pages: ${publicPages.length} -->\n`;
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    staticPages.forEach(page => {
      xml += '  <url>\n';
      xml += `    <loc>${appBaseUrl}${page.loc}</loc>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += '    <changefreq>weekly</changefreq>\n';
      xml += '  </url>\n';
    });

    publishedArticles.forEach(article => {
      xml += '  <url>\n';
      xml += `    <loc>${appBaseUrl}/ArticleView?slug=${encodeURIComponent(article.slug)}</loc>\n`;
      xml += `    <lastmod>${new Date(article.updated_date || article.published_date).toISOString()}</lastmod>\n`;
      xml += '    <priority>0.7</priority>\n';
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '  </url>\n';
    });

    publishedNews.forEach(post => {
      xml += '  <url>\n';
      xml += `    <loc>${appBaseUrl}/NewsView?slug=${encodeURIComponent(post.slug)}</loc>\n`;
      xml += `    <lastmod>${new Date(post.updated_date || post.published_date).toISOString()}</lastmod>\n`;
      xml += '    <priority>0.6</priority>\n';
      xml += '    <changefreq>weekly</changefreq>\n';
      xml += '  </url>\n';
    });

    activeJobs.forEach(job => {
      xml += '  <url>\n';
      xml += `    <loc>${appBaseUrl}/JobDetails?id=${job.id}</loc>\n`;
      xml += `    <lastmod>${new Date(job.updated_date || job.created_date).toISOString()}</lastmod>\n`;
      xml += '    <priority>0.6</priority>\n';
      xml += '    <changefreq>daily</changefreq>\n';
      xml += '  </url>\n';
    });

    publicPages.forEach(page => {
      xml += '  <url>\n';
      xml += `    <loc>${appBaseUrl}/ViewPage?slug=${encodeURIComponent(page.slug)}</loc>\n`;
      xml += `    <lastmod>${new Date(page.updated_date).toISOString()}</lastmod>\n`;
      xml += '    <priority>0.7</priority>\n';
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '  </url>\n';
    });

    xml += '</urlset>';

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(xml);

  } catch (error) {
    console.error('[sitemap] Error:', error);
    return res.status(500).send('Error generating sitemap');
  }
}
