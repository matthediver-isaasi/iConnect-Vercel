import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { stripHtml } from '../_lib/searchTextBuilder.js';
import { resolveMicrositeByPrefix, listActiveMicrosites, isMissingMicrositeSchema } from '../_lib/microsites.js';

function extractSnippet(text, searchTerm, maxLength = 150) {
  if (!text || !searchTerm) return '';
  const plain = stripHtml(text);
  const lowerPlain = plain.toLowerCase();
  const lowerTerm = searchTerm.toLowerCase();
  const idx = lowerPlain.indexOf(lowerTerm);
  if (idx === -1) return plain.substring(0, maxLength);
  const snippetStart = Math.max(0, idx - 60);
  const snippetEnd = Math.min(plain.length, idx + searchTerm.length + 90);
  let snippet = plain.substring(snippetStart, snippetEnd).trim();
  if (snippetStart > 0) snippet = '...' + snippet;
  if (snippetEnd < plain.length) snippet = snippet + '...';
  return snippet;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { q, limit = '20', microsite: micrositePrefixRaw, micrositeScope: micrositeScopeRaw } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({ results: [], query: q || '', total: 0 });
    }

    const searchTerm = q.trim();
    const searchPattern = `%${searchTerm}%`;
    const limitNum = Math.min(parseInt(limit) || 20, 50);

    // Task #2550: microsite scoping. Search stays tenant-wide by default (every
    // tenant page across all microsites, exactly like before) — the only new
    // restriction is opt-in "microsite-only". Pages that belong to a microsite
    // are served under /{prefix}/{slug}; content entities (events/articles/
    // news/resources/complex events) are never microsite-scoped.
    //   - no microsite param             → tenant-wide (unchanged behaviour).
    //   - microsite + micrositeScope=only → just this microsite's pages, nothing else.
    //   - microsite (default / 'all')     → tenant-wide (include results from
    //                                        outside this microsite).
    const micrositePrefix = typeof micrositePrefixRaw === 'string' ? micrositePrefixRaw.trim() : '';
    const microsite = micrositePrefix
      ? await resolveMicrositeByPrefix(supabase, tenant.id, micrositePrefix)
      : null;
    const scope = microsite ? (micrositeScopeRaw === 'only' ? 'only' : 'all') : null;
    const micrositeOnly = scope === 'only';

    const results = [];

    // Pages query is legacy-tolerant: if the microsite_id column does not exist
    // (stale dev DB), fall back to the base select. Only microsite-only mode
    // restricts the page set; every other mode stays tenant-wide.
    const runPagesQuery = async () => {
      const baseSelect = 'id, title, slug, description, published_at, search_text';
      const buildBase = (select) => supabase
        .from('i_edit_page')
        .select(select)
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},slug.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum);
      let query = buildBase(`${baseSelect}, microsite_id`);
      if (micrositeOnly) {
        query = query.eq('microsite_id', microsite.id);
      }
      let result = await query;
      if (result.error && isMissingMicrositeSchema(result.error)) {
        result = await buildBase(baseSelect);
      }
      return result;
    };

    // Content entities are skipped entirely in microsite-only mode.
    const emptyResult = { data: [] };
    const contentQuery = (builder) => (micrositeOnly ? Promise.resolve(emptyResult) : builder);

    const [eventsResult, articlesResult, newsResult, resourcesResult, pagesResult, complexEventsResult] = await Promise.all([
      contentQuery(supabase
        .from('event')
        .select('id, title, description, start_date, end_date, image_url, status, search_text')
        .eq('tenant_id', tenant.id)
        .is('member_group_id', null)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .gte('start_date', new Date().toISOString())
        .limit(limitNum)),
      
      contentQuery(supabase
        .from('blog_post')
        .select('id, title, summary, content, feature_image_url, feature_image_focal_point, published_date, slug, search_text')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum)),
      
      contentQuery(supabase
        .from('news_post')
        .select('id, title, summary, content, feature_image_url, feature_image_focal_point, published_date, slug, search_text')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum)),
      
      contentQuery(supabase
        .from('resource')
        .select('id, title, description, image_url, resource_type, is_public, search_text')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .eq('status', 'active')
        .limit(limitNum)),
      
      runPagesQuery(),

      contentQuery(supabase
        .from('complex_event')
        .select('id, title, description, summary, slug, image_url, start_date, end_date, location, search_text')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},search_text.ilike.${searchPattern}`)
        .in('status', ['published', 'tbc'])
        .limit(limitNum))
    ]);

    if (eventsResult.data) {
      eventsResult.data.forEach(event => {
        const titleMatch = event.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const descMatch = event.description && stripHtml(event.description).toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch || descMatch) {
          description = stripHtml(event.description)?.substring(0, 150) || '';
        } else {
          description = extractSnippet(event.search_text || event.description, searchTerm);
        }
        results.push({
          type: 'event',
          id: event.id,
          title: event.title,
          description,
          image: event.image_url,
          url: `/EventDetails?id=${event.id}`,
          date: event.start_date
        });
      });
    }

    if (articlesResult.data) {
      articlesResult.data.forEach(article => {
        const titleMatch = article.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const summaryMatch = article.summary?.toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch || summaryMatch) {
          description = article.summary?.substring(0, 150) || '';
        } else {
          description = extractSnippet(article.search_text || article.content, searchTerm);
        }
        results.push({
          type: 'article',
          id: article.id,
          title: article.title,
          description,
          image: article.feature_image_url,
          url: `/ArticleView?slug=${article.slug || article.id}`,
          date: article.published_date
        });
      });
    }

    if (newsResult.data) {
      newsResult.data.forEach(news => {
        const titleMatch = news.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const summaryMatch = news.summary?.toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch || summaryMatch) {
          description = news.summary?.substring(0, 150) || '';
        } else {
          description = extractSnippet(news.search_text || news.content, searchTerm);
        }
        results.push({
          type: 'news',
          id: news.id,
          title: news.title,
          description,
          image: news.feature_image_url,
          url: `/NewsView?slug=${news.slug || news.id}`,
          date: news.published_date
        });
      });
    }

    if (resourcesResult.data) {
      resourcesResult.data.forEach(resource => {
        const titleMatch = resource.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const descMatch = resource.description?.toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch || descMatch) {
          description = resource.description?.substring(0, 150) || '';
        } else {
          description = extractSnippet(resource.search_text || resource.description, searchTerm);
        }
        results.push({
          type: 'resource',
          id: resource.id,
          title: resource.title,
          description,
          image: resource.image_url,
          url: `/resources?resourceId=${resource.id}`,
          date: null,
          isPublic: resource.is_public ?? false
        });
      });
    }

    // Build a microsite_id → path_prefix map so microsite pages surfaced in a
    // tenant-wide search still link to their /{prefix}/{slug} URL. Only hit the
    // microsites table when a microsite page actually appears in the results.
    const micrositePrefixMap = {};
    if (microsite) micrositePrefixMap[microsite.id] = microsite.path_prefix;
    if (pagesResult.data?.some(p => p.microsite_id && !micrositePrefixMap[p.microsite_id])) {
      const activeMicrosites = await listActiveMicrosites(supabase, tenant.id).catch(() => []);
      for (const m of activeMicrosites || []) {
        if (m?.id && m?.path_prefix) micrositePrefixMap[m.id] = m.path_prefix;
      }
    }

    if (pagesResult.data) {
      pagesResult.data.forEach(page => {
        const titleMatch = page.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const descMatch = page.description?.toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch || descMatch) {
          description = page.description || '';
        } else {
          description = extractSnippet(page.search_text, searchTerm);
        }
        const prefix = page.microsite_id ? micrositePrefixMap[page.microsite_id] : null;
        const pageUrl = prefix ? `/${prefix}/${page.slug}` : `/${page.slug}`;
        results.push({
          type: 'page',
          id: page.id,
          title: page.title,
          description,
          image: null,
          url: pageUrl,
          date: page.published_at
        });
      });
    }

    if (complexEventsResult.data) {
      complexEventsResult.data.forEach(event => {
        const titleMatch = event.title?.toLowerCase().includes(searchTerm.toLowerCase());
        let description;
        if (titleMatch) {
          description = stripHtml(event.description)?.substring(0, 150) || event.summary?.substring(0, 150) || '';
        } else {
          description = extractSnippet(event.search_text || event.description, searchTerm);
        }
        results.push({
          type: 'complex_event',
          id: event.id,
          title: event.title,
          description,
          image: event.image_url,
          url: `/session-events/${event.slug || event.id}`,
          date: event.start_date
        });
      });
    }

    results.sort((a, b) => {
      if (a.date && b.date) {
        return new Date(b.date) - new Date(a.date);
      }
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    return res.json({
      results: results.slice(0, limitNum),
      query: searchTerm,
      total: results.length
    });

  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Search failed' });
  }
}
