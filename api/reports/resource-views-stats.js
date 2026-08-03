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

    const { data: tenantResources, error: resourcesError } = await supabase
      .from('resource')
      .select('id, title, resource_type')
      .eq('tenant_id', tenantId);

    if (resourcesError) {
      console.error('Error fetching tenant resources:', resourcesError);
      return res.status(500).json({ error: 'Failed to fetch tenant resources' });
    }

    const resourceIds = (tenantResources || []).map(r => r.id);
    const totalResources = resourceIds.length;
    const resourceMap = {};
    (tenantResources || []).forEach(r => { resourceMap[r.id] = r; });

    const emptyPeriodStats = {};
    const emptyViewsByPeriod = {};
    ['week', 'month', 'quarter', 'year', 'all'].forEach(p => {
      emptyPeriodStats[p] = { period: p, current: 0, previous: null, change: null, changeDirection: null, isAllTime: p === 'all' };
      emptyViewsByPeriod[p] = [];
    });

    if (resourceIds.length === 0) {
      return res.status(200).json({
        totalViews: 0,
        uniqueResources: 0,
        uniqueViewers: 0,
        totalResources: 0,
        viewsToday: 0,
        viewsThisWeek: 0,
        viewsThisMonth: 0,
        periodStats: emptyPeriodStats,
        viewsByPeriod: emptyViewsByPeriod,
        viewsByType: [],
        topResources: [],
        lastUpdated: now.toISOString()
      });
    }

    const countViewsInRange = async (startDate, endDate) => {
      let query = supabase
        .from('resource_view')
        .select('*', { count: 'exact', head: true })
        .in('resource_id', resourceIds);

      if (startDate) query = query.gte('viewed_at', startDate.toISOString());
      if (endDate) query = query.lte('viewed_at', endDate.toISOString());

      const { count, error } = await query;
      if (error) {
        console.error('Error counting resource views in range:', error);
        return 0;
      }
      return count || 0;
    };

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);

    const monthStart = new Date(now);
    monthStart.setMonth(monthStart.getMonth() - 1);

    const [totalViews, viewsToday, viewsThisWeek, viewsThisMonth] = await Promise.all([
      countViewsInRange(null, null),
      countViewsInRange(todayStart, now),
      countViewsInRange(weekStart, now),
      countViewsInRange(monthStart, now)
    ]);

    let allViewRecords = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from('resource_view')
        .select('resource_id, user_identifier')
        .in('resource_id', resourceIds)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);

      if (pageErr) {
        console.error('Error fetching resource view records page:', pageErr);
        break;
      }
      if (!page || page.length === 0) break;
      allViewRecords = allViewRecords.concat(page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    const uniqueResourceSet = new Set(allViewRecords.map(v => v.resource_id));
    const uniqueResources = uniqueResourceSet.size;
    const uniqueViewerSet = new Set(allViewRecords.map(v => v.user_identifier));
    const uniqueViewers = uniqueViewerSet.size;

    const viewsByResourceId = {};
    allViewRecords.forEach(v => {
      viewsByResourceId[v.resource_id] = (viewsByResourceId[v.resource_id] || 0) + 1;
    });

    const typeCountMap = {};
    Object.entries(viewsByResourceId).forEach(([resourceId, viewCount]) => {
      const resource = resourceMap[resourceId];
      const type = resource?.resource_type || 'unknown';
      typeCountMap[type] = (typeCountMap[type] || 0) + viewCount;
    });

    const viewsByType = Object.entries(typeCountMap)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

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

    const calculatePeriodStats = async (period) => {
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
      const [current, previous] = await Promise.all([
        countViewsInRange(start, end),
        countViewsInRange(prevStart, prevEnd)
      ]);
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
    const periodStatsResults = await Promise.all(periods.map(p => calculatePeriodStats(p)));
    const periodStats = {};
    periods.forEach((p, i) => { periodStats[p] = periodStatsResults[i]; });

    const getViewsDataForPeriod = async (period) => {
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

      // Paginate: a single select is capped at 1000 rows, which silently
      // truncated chart data for tenants with many views (Task #3300).
      let periodViews = [];
      let pvFrom = 0;
      const pvPageSize = 1000;
      while (true) {
        const { data: pvPage, error: pvError } = await supabase
          .from('resource_view')
          .select('viewed_at, id')
          .in('resource_id', resourceIds)
          .gte('viewed_at', startDate.toISOString())
          .order('viewed_at', { ascending: true })
          .order('id', { ascending: true })
          .range(pvFrom, pvFrom + pvPageSize - 1);

        if (pvError) {
          console.error('Error fetching resource chart data:', pvError);
          return [];
        }
        periodViews = periodViews.concat(pvPage || []);
        if (!pvPage || pvPage.length < pvPageSize) break;
        pvFrom += pvPageSize;
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
      (periodViews || []).forEach(v => {
        const d = new Date(v.viewed_at);
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

    const viewsByPeriodResults = await Promise.all(periods.map(p => getViewsDataForPeriod(p)));
    const viewsByPeriod = {};
    periods.forEach((p, i) => { viewsByPeriod[p] = viewsByPeriodResults[i]; });

    const topResources = Object.entries(viewsByResourceId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([resourceId, viewCount]) => {
        const resource = resourceMap[resourceId];
        return {
          id: resourceId,
          title: resource?.title || 'Unknown Resource',
          resource_type: resource?.resource_type || 'unknown',
          views: viewCount
        };
      });

    const stats = {
      totalViews,
      uniqueResources: uniqueResources || 0,
      uniqueViewers,
      totalResources,
      viewsToday,
      viewsThisWeek,
      viewsThisMonth,
      periodStats,
      viewsByPeriod,
      viewsByType,
      topResources,
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in resource-views-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
