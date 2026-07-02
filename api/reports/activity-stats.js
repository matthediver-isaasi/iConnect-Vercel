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

    const { count: totalMembers, error: totalError } = await supabase
      .from('member')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    if (totalError) {
      console.error('Error fetching total members:', totalError);
      return res.status(500).json({ error: 'Failed to fetch member data' });
    }

    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const oneWeekAgo = new Date(now);
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const countActiveInRange = async (sinceDate) => {
      const { count, error } = await supabase
        .from('member')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('last_activity', sinceDate.toISOString());
      
      if (error) {
        console.error('Error counting active members:', error);
        return 0;
      }
      return count || 0;
    };

    const [activeToday, activeThisWeek, activeThisMonth, activeThisQuarter] = await Promise.all([
      countActiveInRange(oneDayAgo),
      countActiveInRange(oneWeekAgo),
      countActiveInRange(oneMonthAgo),
      countActiveInRange(threeMonthsAgo)
    ]);

    const inactiveCount = (totalMembers || 0) - activeThisQuarter;

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

    const countActivityInRange = async (startDate, endDate) => {
      if (!startDate) return activeThisQuarter;
      
      const { count, error } = await supabase
        .from('member')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('last_activity', startDate.toISOString())
        .lte('last_activity', endDate.toISOString());
      
      if (error) {
        console.error('Error counting activity in range:', error);
        return 0;
      }
      return count || 0;
    };

    const calculatePeriodStats = async (period) => {
      if (period === 'all') {
        return {
          period,
          current: activeThisQuarter,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }
      
      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = await countActivityInRange(start, end);
      const previous = await countActivityInRange(prevStart, prevEnd);
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

    const getActivityDataForPeriod = async (period) => {
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
        .from('member')
        .select('last_activity')
        .eq('tenant_id', tenantId)
        .not('last_activity', 'is', null)
        .order('last_activity', { ascending: true });
      
      if (startDate) {
        query = query.gte('last_activity', startDate.toISOString());
      }

      const { data: members, error } = await query;

      if (error || !members || members.length === 0) {
        return [];
      }

      const groupedData = {};
      members.forEach(member => {
        if (!member.last_activity) return;
        const date = new Date(member.last_activity);
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

    const activityByPeriod = {};
    for (const period of periods) {
      activityByPeriod[period] = await getActivityDataForPeriod(period);
    }

    const stats = {
      totalMembers: totalMembers || 0,
      activeToday,
      activeThisWeek,
      activeThisMonth,
      activeThisQuarter,
      inactiveCount,
      engagementRate: totalMembers > 0 ? Math.round((activeThisMonth / totalMembers) * 100) : 0,
      periodStats,
      activityByPeriod,
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in activity-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
