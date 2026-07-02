import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

async function fetchPaginatedArticleViews(articleIds, selectFields, filters = {}) {
  const chunkSize = 200;
  const pageSize = 1000;
  let allRecords = [];

  for (let c = 0; c < articleIds.length; c += chunkSize) {
    const idChunk = articleIds.slice(c, c + chunkSize);
    let from = 0;
    while (true) {
      let query = supabase
        .from('article_view')
        .select(selectFields)
        .in('article_id', idChunk);

      if (filters.startDate) query = query.gte('viewed_at', filters.startDate);
      if (filters.endDate) query = query.lte('viewed_at', filters.endDate);
      if (filters.order) query = query.order(filters.order.column, { ascending: filters.order.ascending });

      query = query.range(from, from + pageSize - 1);

      const { data: page, error } = await query;
      if (error) {
        console.error('Error fetching article_view records:', error);
        break;
      }
      if (!page || page.length === 0) break;
      allRecords = allRecords.concat(page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }

  return allRecords;
}

function deduplicateViews(records) {
  const seen = new Set();
  const unique = [];
  for (const v of records) {
    const key = `${v.article_id}::${v.user_identifier}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(v);
    }
  }
  return unique;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const now = new Date();

    let tenantPosts = [];
    let postsFrom = 0;
    const postsPageSize = 1000;
    while (true) {
      const { data: batch, error: postsError } = await supabase
        .from('blog_post')
        .select('id, title, slug')
        .eq('tenant_id', tenantId)
        .range(postsFrom, postsFrom + postsPageSize - 1);

      if (postsError) {
        console.error('Error fetching tenant blog posts:', postsError);
        return res.status(500).json({ error: 'Failed to fetch tenant articles' });
      }
      if (!batch || batch.length === 0) break;
      tenantPosts = tenantPosts.concat(batch);
      if (batch.length < postsPageSize) break;
      postsFrom += postsPageSize;
    }

    const articleIds = tenantPosts.map(p => p.id);
    const totalArticles = articleIds.length;
    const articleMap = {};
    tenantPosts.forEach(p => { articleMap[p.id] = p; });

    const emptyPeriodStats = {};
    const emptyViewsByPeriod = {};
    ['week', 'month', 'quarter', 'year', 'all'].forEach(p => {
      emptyPeriodStats[p] = { period: p, current: 0, previous: null, change: null, changeDirection: null, isAllTime: p === 'all' };
      emptyViewsByPeriod[p] = [];
    });

    if (articleIds.length === 0) {
      return res.status(200).json({
        totalViews: 0,
        uniqueArticles: 0,
        uniqueViewers: 0,
        totalArticles: 0,
        viewsToday: 0,
        viewsThisWeek: 0,
        viewsThisMonth: 0,
        periodStats: emptyPeriodStats,
        viewsByPeriod: emptyViewsByPeriod,
        topArticles: [],
        lastUpdated: now.toISOString()
      });
    }

    const allViewRecords = await fetchPaginatedArticleViews(
      articleIds,
      'article_id, user_identifier, viewed_at'
    );

    const uniqueViews = deduplicateViews(allViewRecords);

    const totalViews = uniqueViews.length;
    const uniqueArticleSet = new Set(uniqueViews.map(v => v.article_id));
    const uniqueArticles = uniqueArticleSet.size;
    const uniqueViewerSet = new Set(uniqueViews.map(v => v.user_identifier));
    const uniqueViewers = uniqueViewerSet.size;

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(now);
    monthStart.setMonth(monthStart.getMonth() - 1);

    const countUniqueInRange = (views, startDate, endDate) => {
      return views.filter(v => {
        const d = new Date(v.viewed_at);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      }).length;
    };

    const viewsToday = countUniqueInRange(uniqueViews, todayStart, now);
    const viewsThisWeek = countUniqueInRange(uniqueViews, weekStart, now);
    const viewsThisMonth = countUniqueInRange(uniqueViews, monthStart, now);

    const getDateRange = (period) => {
      const end = new Date(now);
      const start = new Date(now);
      const prevEnd = new Date(now);
      const prevStart = new Date(now);

      switch (period) {
        case 'week':
          start.setDate(start.getDate() - 7);
          prevEnd.setDate(prevEnd.getDate() - 7);
          prevStart.setDate(prevStart.getDate() - 14);
          break;
        case 'month':
          start.setMonth(start.getMonth() - 1);
          prevEnd.setMonth(prevEnd.getMonth() - 1);
          prevStart.setMonth(prevStart.getMonth() - 2);
          break;
        case 'quarter':
          start.setMonth(start.getMonth() - 3);
          prevEnd.setMonth(prevEnd.getMonth() - 3);
          prevStart.setMonth(prevStart.getMonth() - 6);
          break;
        case 'year':
          start.setFullYear(start.getFullYear() - 1);
          prevEnd.setFullYear(prevEnd.getFullYear() - 1);
          prevStart.setFullYear(prevStart.getFullYear() - 2);
          break;
        default:
          return { start: null, end, prevStart: null, prevEnd: null };
      }

      return { start, end, prevStart, prevEnd };
    };

    const calculatePeriodStats = (period) => {
      if (period === 'all') {
        return {
          period,
          current: totalViews,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }

      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = countUniqueInRange(uniqueViews, start, end);
      const previous = countUniqueInRange(uniqueViews, prevStart, prevEnd);
      const change = previous > 0 ? ((current - previous) / previous * 100) : (current > 0 ? 100 : 0);

      return {
        period,
        current,
        previous,
        change: Math.round(change * 10) / 10,
        changeDirection: current >= previous ? 'up' : 'down',
        isAllTime: false
      };
    };

    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const periodStats = {};
    periods.forEach(p => { periodStats[p] = calculatePeriodStats(p); });

    const getViewsDataForPeriod = (period) => {
      let startDate = new Date(now);

      switch (period) {
        case 'week':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case 'month':
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case 'quarter':
          startDate.setMonth(startDate.getMonth() - 3);
          break;
        case 'year':
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        case 'all':
        default:
          startDate.setFullYear(startDate.getFullYear() - 2);
          break;
      }

      let groupBy;
      if (period === 'week' || period === 'month') {
        groupBy = 'day';
      } else if (period === 'quarter') {
        groupBy = 'week';
      } else {
        groupBy = 'month';
      }

      const buckets = {};
      uniqueViews.forEach(v => {
        const d = new Date(v.viewed_at);
        if (d < startDate) return;
        let key;
        if (groupBy === 'day') {
          key = d.toISOString().slice(0, 10);
        } else if (groupBy === 'week') {
          const ws = new Date(d);
          ws.setDate(ws.getDate() - ws.getDay());
          key = ws.toISOString().slice(0, 10);
        } else {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
        buckets[key] = (buckets[key] || 0) + 1;
      });

      return Object.keys(buckets).sort().map(key => ({
        label: key,
        count: buckets[key]
      }));
    };

    const viewsByPeriod = {};
    periods.forEach(p => { viewsByPeriod[p] = getViewsDataForPeriod(p); });

    const viewsByArticle = {};
    uniqueViews.forEach(v => {
      viewsByArticle[v.article_id] = (viewsByArticle[v.article_id] || 0) + 1;
    });

    const topArticles = Object.entries(viewsByArticle)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([articleId, viewCount]) => {
        const post = articleMap[articleId];
        return {
          id: articleId,
          title: post?.title || 'Unknown Article',
          slug: post?.slug || '',
          views: viewCount
        };
      });

    const stats = {
      totalViews,
      uniqueArticles: uniqueArticles || 0,
      uniqueViewers,
      totalArticles,
      viewsToday,
      viewsThisWeek,
      viewsThisMonth,
      periodStats,
      viewsByPeriod,
      topArticles,
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in article-views-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
