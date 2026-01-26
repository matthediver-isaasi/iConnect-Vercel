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

    // Get stats using RPC function
    const { data: statsData, error: statsError } = await supabase
      .rpc('get_article_view_stats', { p_tenant_id: tenantId });

    if (statsError) {
      console.error('Error fetching article view stats:', statsError);
      return res.status(500).json({ error: 'Failed to fetch article view statistics' });
    }

    // Get count of blog posts for this tenant
    const { count: totalArticles } = await supabase
      .from('blog_post')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    // Get top articles using RPC function
    const { data: topArticles, error: topError } = await supabase
      .rpc('get_top_articles_by_views', { 
        p_tenant_id: tenantId,
        p_limit: 5 
      });

    if (topError) {
      console.error('Error fetching top articles:', topError);
    }

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
      if (!startDate) return statsData?.totalviews || 0;
      
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
      const totalViews = statsData?.totalviews || 0;
      
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

    // Get views by period for chart using RPC function
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
          startDate.setFullYear(startDate.getFullYear() - 2);
          groupBy = 'month';
          break;
      }

      const { data: chartData, error: chartError } = await supabase
        .rpc('get_article_views_by_period', {
          p_tenant_id: tenantId,
          p_start_date: startDate.toISOString(),
          p_group_by: groupBy
        });

      if (chartError) {
        console.error('Error fetching chart data:', chartError);
        return [];
      }

      return (chartData || []).map(row => ({
        label: row.period_label,
        count: parseInt(row.view_count) || 0
      }));
    };

    // Get chart data for all periods in parallel
    const viewsByPeriodPromises = periods.map(p => getViewsDataForPeriod(p));
    const viewsByPeriodResults = await Promise.all(viewsByPeriodPromises);
    const viewsByPeriod = {};
    periods.forEach((p, i) => { viewsByPeriod[p] = viewsByPeriodResults[i]; });

    const stats = {
      totalViews: statsData?.totalviews || 0,
      uniqueArticles: statsData?.uniquearticles || 0,
      uniqueViewers: statsData?.uniqueviewers || 0,
      totalArticles: totalArticles || 0,
      viewsToday: statsData?.viewstoday || 0,
      viewsThisWeek: statsData?.viewsthisweek || 0,
      viewsThisMonth: statsData?.viewsthismonth || 0,
      periodStats,
      viewsByPeriod,
      topArticles: topArticles || [],
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in article-views-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
