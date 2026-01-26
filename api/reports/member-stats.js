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

    const { data: members, error } = await supabase
      .from('member')
      .select('id, created_at, status')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching members:', error);
      return res.status(500).json({ error: 'Failed to fetch member data' });
    }

    const now = new Date();
    const totalMembers = members?.length || 0;
    const activeMembers = members?.filter(m => m.status === 'active').length || 0;

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

    const countMembersInRange = (startDate, endDate) => {
      if (!startDate) return totalMembers;
      return members?.filter(m => {
        const createdAt = new Date(m.created_at);
        return createdAt >= startDate && createdAt <= endDate;
      }).length || 0;
    };

    const calculatePeriodStats = (period) => {
      if (period === 'all') {
        return {
          period,
          current: totalMembers,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }
      
      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = countMembersInRange(start, end);
      const previous = countMembersInRange(prevStart, prevEnd);
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
    periods.forEach(period => {
      periodStats[period] = calculatePeriodStats(period);
    });

    const getAcquisitionData = () => {
      if (!members || members.length === 0) return [];

      const monthlyData = {};
      members.forEach(member => {
        if (!member.created_at) return;
        const date = new Date(member.created_at);
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
      totalMembers,
      activeMembers,
      periodStats,
      acquisitionData: getAcquisitionData(),
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in member-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
