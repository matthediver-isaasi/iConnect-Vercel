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

    const { formId } = req.query;

    let formsQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);

    if (formId) {
      formsQuery = formsQuery.eq('form_id', formId);
    }

    const { data: ddConfigs, error: configError } = await formsQuery;

    if (configError) {
      console.error('Error fetching DD configs:', configError);
      return res.status(500).json({ error: 'Failed to fetch configuration' });
    }

    const formIds = ddConfigs?.map(c => c.form_id) || [];
    
    if (formIds.length === 0) {
      return res.status(200).json({
        totalDecisions: 0,
        approved: { count: 0, percentage: 0 },
        declined: { count: 0, percentage: 0 },
        onHold: { count: 0, percentage: 0 },
        decisionsByPeriod: {},
        monthlyTrend: [],
        averageTimeToDecision: {},
        lastUpdated: now.toISOString()
      });
    }

    const canonicalizeKey = (str) => {
      if (!str) return '';
      return str
        .toLowerCase()
        .trim()
        .replace(/[-_\s]+/g, ' ')
        .replace(/\s+/g, ' ');
    };

    const approvedCanonical = canonicalizeKey('Approved');
    const rejectedCanonical = canonicalizeKey('Rejected');
    const heldCanonical = canonicalizeKey('Held');

    const approvedStageIds = new Set();
    const rejectedStageIds = new Set();
    const heldStageIds = new Set();

    ddConfigs.forEach(config => {
      const stages = config.workflow_stages || [];
      stages.forEach(stage => {
        const canonical = canonicalizeKey(stage.label);
        if (canonical === approvedCanonical) {
          approvedStageIds.add(stage.id);
        }
        if (canonical === rejectedCanonical) {
          rejectedStageIds.add(stage.id);
        }
        if (canonical === heldCanonical) {
          heldStageIds.add(stage.id);
        }
      });
    });

    const { data: allSubmissions, error: submissionsError } = await supabase
      .from('form_submission')
      .select('id, form_id, workflow_status, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .in('form_id', formIds);

    if (submissionsError) {
      console.error('Error fetching submissions:', submissionsError);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const isStatus = (status, canonical, stageIds) => {
      if (!status) return false;
      const statusCanonical = canonicalizeKey(status);
      if (statusCanonical === canonical) return true;
      return stageIds.has(status);
    };

    const isApproved = (status) => isStatus(status, approvedCanonical, approvedStageIds);
    const isDeclined = (status) => isStatus(status, rejectedCanonical, rejectedStageIds);
    const isOnHold = (status) => isStatus(status, heldCanonical, heldStageIds);

    const approvedSubmissions = allSubmissions?.filter(s => isApproved(s.workflow_status)) || [];
    const declinedSubmissions = allSubmissions?.filter(s => isDeclined(s.workflow_status)) || [];
    const onHoldSubmissions = allSubmissions?.filter(s => isOnHold(s.workflow_status)) || [];

    const totalDecisions = approvedSubmissions.length + declinedSubmissions.length + onHoldSubmissions.length;

    const approved = {
      count: approvedSubmissions.length,
      percentage: totalDecisions > 0 ? Math.round((approvedSubmissions.length / totalDecisions) * 100) : 0
    };

    const declined = {
      count: declinedSubmissions.length,
      percentage: totalDecisions > 0 ? Math.round((declinedSubmissions.length / totalDecisions) * 100) : 0
    };

    const onHold = {
      count: onHoldSubmissions.length,
      percentage: totalDecisions > 0 ? Math.round((onHoldSubmissions.length / totalDecisions) * 100) : 0
    };

    const calculateAvgDays = (submissions) => {
      if (submissions.length === 0) return 0;
      const totalMs = submissions.reduce((acc, sub) => {
        const created = new Date(sub.created_at);
        const updated = new Date(sub.updated_at);
        return acc + (updated.getTime() - created.getTime());
      }, 0);
      return Math.round((totalMs / submissions.length / (1000 * 60 * 60 * 24)) * 10) / 10;
    };

    const averageTimeToDecision = {
      approved: calculateAvgDays(approvedSubmissions),
      declined: calculateAvgDays(declinedSubmissions),
      onHold: calculateAvgDays(onHoldSubmissions)
    };

    const getPeriodBounds = (periodKey) => {
      const start = new Date(now);
      const prevStart = new Date(now);
      const prevEnd = new Date(now);

      switch (periodKey) {
        case 'week':
          start.setDate(now.getDate() - 7);
          prevStart.setDate(now.getDate() - 14);
          prevEnd.setDate(now.getDate() - 7);
          break;
        case 'month':
          start.setMonth(now.getMonth() - 1);
          prevStart.setMonth(now.getMonth() - 2);
          prevEnd.setMonth(now.getMonth() - 1);
          break;
        case 'quarter':
          start.setMonth(now.getMonth() - 3);
          prevStart.setMonth(now.getMonth() - 6);
          prevEnd.setMonth(now.getMonth() - 3);
          break;
        case 'year':
          start.setFullYear(now.getFullYear() - 1);
          prevStart.setFullYear(now.getFullYear() - 2);
          prevEnd.setFullYear(now.getFullYear() - 1);
          break;
        default:
          return { start: null, prevStart: null, prevEnd: null };
      }

      return { start, prevStart, prevEnd };
    };

    const calculatePeriodStats = (submissions, periodKey) => {
      if (periodKey === 'all') {
        return { current: submissions.length, previous: null, change: null, changeDirection: null };
      }

      const { start, prevStart, prevEnd } = getPeriodBounds(periodKey);

      const current = submissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= start && updated <= now;
      }).length;

      const previous = submissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= prevStart && updated < prevEnd;
      }).length;

      const change = previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);
      const changeDirection = current >= previous ? 'up' : 'down';

      return { current, previous, change: Math.abs(change), changeDirection };
    };

    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const decisionsByPeriod = {};

    periods.forEach(periodKey => {
      const approvedStats = calculatePeriodStats(approvedSubmissions, periodKey);
      const declinedStats = calculatePeriodStats(declinedSubmissions, periodKey);
      const onHoldStats = calculatePeriodStats(onHoldSubmissions, periodKey);
      
      const totalCurrent = approvedStats.current + declinedStats.current + onHoldStats.current;
      const totalPrevious = periodKey === 'all' ? null : (approvedStats.previous + declinedStats.previous + onHoldStats.previous);
      const totalChange = totalPrevious > 0 ? Math.round(((totalCurrent - totalPrevious) / totalPrevious) * 100) : (totalCurrent > 0 ? 100 : 0);

      decisionsByPeriod[periodKey] = {
        approved: approvedStats,
        declined: declinedStats,
        onHold: onHoldStats,
        total: {
          current: totalCurrent,
          previous: totalPrevious,
          change: periodKey === 'all' ? null : Math.abs(totalChange),
          changeDirection: periodKey === 'all' ? null : (totalCurrent >= totalPrevious ? 'up' : 'down')
        }
      };
    });

    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthName = monthStart.toLocaleString('default', { month: 'short' });

      const monthApproved = approvedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= monthStart && updated <= monthEnd;
      }).length;

      const monthDeclined = declinedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= monthStart && updated <= monthEnd;
      }).length;

      const monthOnHold = onHoldSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= monthStart && updated <= monthEnd;
      }).length;

      monthlyTrend.push({
        month: monthName,
        approved: monthApproved,
        declined: monthDeclined,
        onHold: monthOnHold
      });
    }

    return res.status(200).json({
      totalDecisions,
      approved,
      declined,
      onHold,
      decisionsByPeriod,
      monthlyTrend,
      averageTimeToDecision,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in decisions-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
