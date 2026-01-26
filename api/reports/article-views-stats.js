import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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

    // Get total article views count
    const { count: totalViews, error: totalError } = await supabase
      .from('article_view')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    if (totalError) {
      console.error('Error fetching total views:', totalError);
      return res.status(500).json({ error: 'Failed to fetch article view data' });
    }

    // Get count of blog posts that have at least one view (unique articles viewed)
    // This uses the blog_post table with a subquery approach
    const { count: uniqueArticleCount } = await supabase
      .from('blog_post')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    // Define time ranges
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const oneWeekAgo = new Date(now);
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    // Count views in time ranges
    const countViewsInRange = async (sinceDate) => {
      const { count, error } = await supabase
        .from('article_view')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('viewed_at', sinceDate.toISOString());
      
      if (error) {
        console.error('Error counting views in range:', error);
        return 0;
      }
      return count || 0;
    };

    const [viewsToday, viewsThisWeek, viewsThisMonth] = await Promise.all([
      countViewsInRange(oneDayAgo),
      countViewsInRange(oneWeekAgo),
      countViewsInRange(oneMonthAgo)
    ]);

    // Calculate period stats with comparisons
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

    const countViewsInDateRange = async (startDate, endDate) => {
      if (!startDate) return totalViews || 0;
      
      const { count, error } = await supabase
        .from('article_view')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('viewed_at', startDate.toISOString())
        .lte('viewed_at', endDate.toISOString());
      
      if (error) {
        console.error('Error counting views in range:', error);
        return 0;
      }
      return count || 0;
    };

    const calculatePeriodStats = async (period) => {
      if (period === 'all') {
        return {
          period,
          current: totalViews || 0,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }
      
      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = await countViewsInDateRange(start, end);
      const previous = await countViewsInDateRange(prevStart, prevEnd);
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
    const periodStatsPromises = periods.map(p => calculatePeriodStats(p));
    const periodStatsResults = await Promise.all(periodStatsPromises);
    const periodStats = {};
    periods.forEach((p, i) => { periodStats[p] = periodStatsResults[i]; });

    // Get views by period for chart - generate date buckets and count each
    const getViewsDataForPeriod = async (period) => {
      let startDate = new Date(now);
      let groupBy = 'day';
      let bucketCount = 7;
      
      switch (period) {
        case 'week':
          startDate.setDate(startDate.getDate() - 7);
          groupBy = 'day';
          bucketCount = 7;
          break;
        case 'month':
          startDate.setMonth(startDate.getMonth() - 1);
          groupBy = 'day';
          bucketCount = 30;
          break;
        case 'quarter':
          startDate.setMonth(startDate.getMonth() - 3);
          groupBy = 'week';
          bucketCount = 13;
          break;
        case 'year':
          startDate.setFullYear(startDate.getFullYear() - 1);
          groupBy = 'month';
          bucketCount = 12;
          break;
        case 'all':
        default:
          startDate.setFullYear(startDate.getFullYear() - 2);
          groupBy = 'month';
          bucketCount = 24;
          break;
      }

      const chartData = [];
      const buckets = [];
      
      // Generate time buckets
      if (groupBy === 'day') {
        for (let i = 0; i < bucketCount; i++) {
          const d = new Date(startDate);
          d.setDate(d.getDate() + i);
          buckets.push({ start: new Date(d), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
        }
      } else if (groupBy === 'week') {
        for (let i = 0; i < bucketCount; i++) {
          const d = new Date(startDate);
          d.setDate(d.getDate() + (i * 7));
          buckets.push({ start: new Date(d), label: `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` });
        }
      } else {
        for (let i = 0; i < bucketCount; i++) {
          const d = new Date(startDate);
          d.setMonth(d.getMonth() + i);
          buckets.push({ start: new Date(d), label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
        }
      }

      // Count views for each bucket in parallel
      const countPromises = buckets.map(async (bucket, i) => {
        const bucketEnd = i < buckets.length - 1 ? buckets[i + 1].start : now;
        
        const { count } = await supabase
          .from('article_view')
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('viewed_at', bucket.start.toISOString())
          .lt('viewed_at', bucketEnd.toISOString());

        return { label: bucket.label, count: count || 0 };
      });

      const results = await Promise.all(countPromises);
      return results.filter(r => r.count > 0 || results.every(r2 => r2.count === 0));
    };

    // Get chart data for all periods in parallel
    const viewsByPeriodPromises = periods.map(p => getViewsDataForPeriod(p));
    const viewsByPeriodResults = await Promise.all(viewsByPeriodPromises);
    const viewsByPeriod = {};
    periods.forEach((p, i) => { viewsByPeriod[p] = viewsByPeriodResults[i]; });

    // Get top 5 articles by views - fetch recent views and aggregate client-side
    // Limited to 500 recent views to avoid pagination issues
    const { data: recentViews } = await supabase
      .from('article_view')
      .select('article_id')
      .eq('tenant_id', tenantId)
      .order('viewed_at', { ascending: false })
      .limit(500);

    let topArticles = [];
    if (recentViews && recentViews.length > 0) {
      const articleCounts = {};
      recentViews.forEach(view => {
        articleCounts[view.article_id] = (articleCounts[view.article_id] || 0) + 1;
      });
      
      const sortedArticles = Object.entries(articleCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const articleIds = sortedArticles.map(([id]) => id);
      if (articleIds.length > 0) {
        const { data: articles } = await supabase
          .from('blog_post')
          .select('id, title')
          .in('id', articleIds);

        topArticles = sortedArticles.map(([id, count]) => {
          const article = articles?.find(a => a.id === id);
          return {
            id,
            title: article?.title || 'Unknown Article',
            views: count
          };
        });
      }
    }

    const stats = {
      totalViews: totalViews || 0,
      uniqueArticles: uniqueArticleCount || 0,
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
