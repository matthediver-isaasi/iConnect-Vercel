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

    // Get unique articles viewed
    const { data: uniqueArticles, error: uniqueError } = await supabase
      .from('article_view')
      .select('article_id')
      .eq('tenant_id', tenantId);

    const uniqueArticleCount = uniqueArticles 
      ? new Set(uniqueArticles.map(v => v.article_id)).size 
      : 0;

    // Get unique viewers
    const { data: uniqueViewers, error: viewersError } = await supabase
      .from('article_view')
      .select('user_identifier')
      .eq('tenant_id', tenantId);

    const uniqueViewerCount = uniqueViewers 
      ? new Set(uniqueViewers.map(v => v.user_identifier)).size 
      : 0;

    // Define time ranges
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const oneWeekAgo = new Date(now);
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

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
    const periodStats = {};
    for (const period of periods) {
      periodStats[period] = await calculatePeriodStats(period);
    }

    // Get views by period for chart
    const getViewsDataForPeriod = async (period) => {
      let startDate = new Date(now);
      let groupBy = 'day';
      
      switch (period) {
        case 'week':
          startDate.setDate(startDate.getDate() - 7);
          groupBy = 'day';
          break;
        case 'month':
          startDate.setMonth(startDate.getMonth() - 1);
          groupBy = 'day';
          break;
        case 'quarter':
          startDate.setMonth(startDate.getMonth() - 3);
          groupBy = 'week';
          break;
        case 'year':
          startDate.setFullYear(startDate.getFullYear() - 1);
          groupBy = 'month';
          break;
        case 'all':
        default:
          startDate = null;
          groupBy = 'month';
          break;
      }

      let query = supabase
        .from('article_view')
        .select('viewed_at')
        .eq('tenant_id', tenantId)
        .not('viewed_at', 'is', null)
        .order('viewed_at', { ascending: true });
      
      if (startDate) {
        query = query.gte('viewed_at', startDate.toISOString());
      }

      const { data: views, error } = await query;

      if (error || !views || views.length === 0) {
        return [];
      }

      const groupedData = {};
      views.forEach(view => {
        if (!view.viewed_at) return;
        const date = new Date(view.viewed_at);
        let key;
        
        if (groupBy === 'day') {
          key = date.toISOString().split('T')[0];
        } else if (groupBy === 'week') {
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          key = weekStart.toISOString().split('T')[0];
        } else {
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        }
        
        groupedData[key] = (groupedData[key] || 0) + 1;
      });

      const sortedKeys = Object.keys(groupedData).sort();
      
      return sortedKeys.map(key => {
        let label;
        if (groupBy === 'day') {
          const date = new Date(key);
          label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } else if (groupBy === 'week') {
          const date = new Date(key);
          label = `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        } else {
          const [year, monthNum] = key.split('-');
          label = new Date(year, parseInt(monthNum) - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        }
        
        return {
          label,
          count: groupedData[key]
        };
      });
    };

    const viewsByPeriod = {};
    for (const period of periods) {
      viewsByPeriod[period] = await getViewsDataForPeriod(period);
    }

    // Get top articles by views
    const { data: topArticlesData, error: topError } = await supabase
      .from('article_view')
      .select('article_id')
      .eq('tenant_id', tenantId);

    let topArticles = [];
    if (!topError && topArticlesData) {
      const articleCounts = {};
      topArticlesData.forEach(view => {
        articleCounts[view.article_id] = (articleCounts[view.article_id] || 0) + 1;
      });
      
      const sortedArticles = Object.entries(articleCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      // Get article titles
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
      uniqueArticles: uniqueArticleCount,
      uniqueViewers: uniqueViewerCount,
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
