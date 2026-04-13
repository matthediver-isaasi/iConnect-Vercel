import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

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

const STYLE_KEY_SUFFIXES = [
  '_color', '_size', '_weight', '_family', '_spacing', '_height', '_type',
  '_opacity', '_angle', '_radius', '_fit', '_id', '_url', '_point',
  '_order', '_top', '_bottom', '_left', '_right', '_width', '_align',
  '_transform', '_decoration', '_style', '_mode', '_position', '_repeat',
  '_attachment', '_origin', '_clip', '_blend', '_filter'
];
const STYLE_KEY_EXACT = new Set([
  'anchor', 'background_type', 'background_color', 'gradient_start_color',
  'gradient_end_color', 'gradient_angle', 'overlay_opacity', 'height_type',
  'image_fit', 'border_radius', 'padding_top', 'padding_bottom',
  'padding_left', 'padding_right', 'display_order', 'element_type',
  'icon_type', 'layout', 'variant', 'columnWidths', 'rows', 'cols',
  'tableAlign', 'fullWidth', 'id', 'page_id', 'tenant_id', 'created_date',
  'updated_date', 'autoLatest', 'contentType', 'itemId', 'status',
  'is_public', 'image_url', 'feature_image_url', 'slug'
]);

function isStyleKey(key) {
  if (STYLE_KEY_EXACT.has(key)) return true;
  for (const suffix of STYLE_KEY_SUFFIXES) {
    if (key.endsWith(suffix)) return true;
  }
  if (key.startsWith('mobile_')) return true;
  return false;
}

function isStyleValue(val) {
  if (typeof val !== 'string') return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(val)) return true;
  if (/^rgba?\(/.test(val)) return true;
  if (/^hsla?\(/.test(val)) return true;
  if (/^(https?:\/\/|data:)/.test(val)) return true;
  if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt)?$/.test(val)) return true;
  return false;
}

function extractTextFromObject(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return stripHtml(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return '';
  if (Array.isArray(obj)) return obj.map(extractTextFromObject).filter(Boolean).join(' ');

  const texts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isStyleKey(key)) continue;
    if (typeof value === 'string') {
      if (value.length < 2 || isStyleValue(value)) continue;
      texts.push(stripHtml(value));
    } else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      const nested = extractTextFromObject(value);
      if (nested) texts.push(nested);
    }
  }
  return texts.join(' ');
}

function getContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return extractTextFromObject(content);
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

    const { q, limit = '20' } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({ results: [], query: q || '', total: 0 });
    }

    const searchTerm = q.trim();
    const searchPattern = `%${searchTerm}%`;
    const limitNum = Math.min(parseInt(limit) || 20, 50);

    const results = [];

    const [eventsResult, articlesResult, newsResult, resourcesResult, pagesResult, tenantPageIdsResult] = await Promise.all([
      supabase
        .from('event')
        .select('id, title, description, start_date, end_date, image_url, status')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
        .gte('start_date', new Date().toISOString())
        .limit(limitNum),
      
      supabase
        .from('blog_post')
        .select('id, title, summary, content, feature_image_url, feature_image_focal_point, published_date, slug')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern},content::text.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum),
      
      supabase
        .from('news_post')
        .select('id, title, summary, content, feature_image_url, feature_image_focal_point, published_date, slug')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern},content::text.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum),
      
      supabase
        .from('resource')
        .select('id, title, description, image_url, resource_type, is_public')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
        .eq('status', 'active')
        .limit(limitNum),
      
      supabase
        .from('i_edit_page')
        .select('id, title, slug, description, published_at')
        .eq('tenant_id', tenant.id)
        .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},slug.ilike.${searchPattern}`)
        .eq('status', 'published')
        .limit(limitNum),

      supabase
        .from('i_edit_page')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('status', 'published')
        .limit(1000)
    ]);

    const tenantPageIds = (tenantPageIdsResult.data || []).map(p => p.id);

    let pageElementsResult = { data: null };
    if (tenantPageIds.length > 0) {
      const batchSize = 200;
      const allElements = [];
      for (let i = 0; i < tenantPageIds.length; i += batchSize) {
        const batch = tenantPageIds.slice(i, i + batchSize);
        const { data } = await supabase
          .from('i_edit_page_element')
          .select('page_id, content')
          .in('page_id', batch)
          .or(`content::text.ilike.${searchPattern}`)
          .limit(1000);
        if (data) allElements.push(...data);
      }
      pageElementsResult = { data: allElements.length > 0 ? allElements : null };
    }

    if (eventsResult.data) {
      eventsResult.data.forEach(event => {
        results.push({
          type: 'event',
          id: event.id,
          title: event.title,
          description: stripHtml(event.description)?.substring(0, 150) || '',
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
          const contentText = getContentText(article.content);
          description = extractSnippet(contentText, searchTerm);
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
          const contentText = getContentText(news.content);
          description = extractSnippet(contentText, searchTerm);
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
        results.push({
          type: 'resource',
          id: resource.id,
          title: resource.title,
          description: resource.description?.substring(0, 150) || '',
          image: resource.image_url,
          url: `/resources?resourceId=${resource.id}`,
          date: null,
          isPublic: resource.is_public ?? false
        });
      });
    }

    const titleMatchedPageIds = new Set();
    if (pagesResult.data) {
      pagesResult.data.forEach(page => {
        titleMatchedPageIds.add(page.id);
        results.push({
          type: 'page',
          id: page.id,
          title: page.title,
          description: page.description,
          image: null,
          url: `/${page.slug}`,
          date: page.published_at
        });
      });
    }

    if (pageElementsResult.data && pageElementsResult.data.length > 0) {
      const contentByPageId = {};
      pageElementsResult.data.forEach(el => {
        if (!titleMatchedPageIds.has(el.page_id)) {
          if (!contentByPageId[el.page_id]) {
            contentByPageId[el.page_id] = [];
          }
          contentByPageId[el.page_id].push(el.content);
        }
      });

      const unmatchedPageIds = Object.keys(contentByPageId);
      if (unmatchedPageIds.length > 0) {
        const { data: contentPages } = await supabase
          .from('i_edit_page')
          .select('id, title, slug, description, published_at')
          .eq('tenant_id', tenant.id)
          .eq('status', 'published')
          .in('id', unmatchedPageIds)
          .limit(limitNum);

        if (contentPages) {
          contentPages.forEach(page => {
            const elements = contentByPageId[page.id] || [];
            let snippet = '';
            for (const content of elements) {
              const text = getContentText(content);
              const candidate = extractSnippet(text, searchTerm);
              if (candidate && candidate.toLowerCase().includes(searchTerm.toLowerCase())) {
                snippet = candidate;
                break;
              }
            }
            results.push({
              type: 'page',
              id: page.id,
              title: page.title,
              description: snippet || page.description,
              image: null,
              url: `/${page.slug}`,
              date: page.published_at
            });
          });
        }
      }
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
