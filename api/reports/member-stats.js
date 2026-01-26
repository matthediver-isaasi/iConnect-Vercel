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

    const { count: activeMembers, error: activeError } = await supabase
      .from('member')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'active');

    if (activeError) {
      console.error('Error fetching active members:', activeError);
      return res.status(500).json({ error: 'Failed to fetch member data' });
    }

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

    const countMembersInRange = async (startDate, endDate) => {
      if (!startDate) return totalMembers || 0;
      
      const { count, error } = await supabase
        .from('member')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_on', startDate.toISOString())
        .lte('created_on', endDate.toISOString());
      
      if (error) {
        console.error('Error counting members in range:', error);
        return 0;
      }
      return count || 0;
    };

    const calculatePeriodStats = async (period) => {
      if (period === 'all') {
        return {
          period,
          current: totalMembers || 0,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }
      
      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = await countMembersInRange(start, end);
      const previous = await countMembersInRange(prevStart, prevEnd);
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

    const getAcquisitionData = async () => {
      const twelveMonthsAgo = new Date(now);
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const { data: recentMembers, error } = await supabase
        .from('member')
        .select('created_on')
        .eq('tenant_id', tenantId)
        .gte('created_on', twelveMonthsAgo.toISOString())
        .order('created_on', { ascending: true });

      if (error || !recentMembers || recentMembers.length === 0) {
        return [];
      }

      const monthlyData = {};
      recentMembers.forEach(member => {
        if (!member.created_on) return;
        const date = new Date(member.created_on);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        monthlyData[monthKey] = (monthlyData[monthKey] || 0) + 1;
      });

      const sortedMonths = Object.keys(monthlyData).sort();
      const last12Months = sortedMonths.slice(-12);
      
      return last12Months.map(month => {
        const [year, monthNum] = month.split('-');
        const monthName = new Date(year, parseInt(monthNum) - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        return {
          month: monthName,
          count: monthlyData[month]
        };
      });
    };

    const stats = {
      totalMembers: totalMembers || 0,
      activeMembers: activeMembers || 0,
      periodStats,
      acquisitionData: await getAcquisitionData(),
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in member-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
