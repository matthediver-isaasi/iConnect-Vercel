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
        scheduledMeetings: 0,
        completedMeetings: 0,
        completionRate: 0,
        averageSchedulingDays: 0,
        averageSchedulingHours: 0,
        pendingOutcomes: 0,
        outcomes: { held: { count: 0, percentage: 0 }, approved: { count: 0, percentage: 0 }, rejected: { count: 0, percentage: 0 } },
        outcomesByPeriod: {},
        scoreDistribution: [],
        schedulingTimeBreakdown: [],
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

    const ddMeetAttendedCanonical = canonicalizeKey('DD Meet Attended');
    const verifiedCanonical = canonicalizeKey('Verified');
    const heldCanonical = canonicalizeKey('Held');
    const approvedCanonical = canonicalizeKey('Approved');
    const rejectedCanonical = canonicalizeKey('Rejected');

    const ddMeetAttendedStageIds = new Set();
    const verifiedStageIds = new Set();
    const heldStageIds = new Set();
    const approvedStageIds = new Set();
    const rejectedStageIds = new Set();

    ddConfigs.forEach(config => {
      const stages = config.workflow_stages || [];
      stages.forEach(stage => {
        const canonical = canonicalizeKey(stage.label);
        if (canonical === ddMeetAttendedCanonical) {
          ddMeetAttendedStageIds.add(stage.id);
        }
        if (canonical === verifiedCanonical) {
          verifiedStageIds.add(stage.id);
        }
        if (canonical === heldCanonical) {
          heldStageIds.add(stage.id);
        }
        if (canonical === approvedCanonical) {
          approvedStageIds.add(stage.id);
        }
        if (canonical === rejectedCanonical) {
          rejectedStageIds.add(stage.id);
        }
      });
    });

    const { data: allSubmissions, error: submissionsError } = await supabase
      .from('form_submission')
      .select('id, form_id, workflow_status, created_at, updated_at, due_diligence_score')
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

    const isDDMeetAttended = (status) => isStatus(status, ddMeetAttendedCanonical, ddMeetAttendedStageIds);
    const isVerified = (status) => isStatus(status, verifiedCanonical, verifiedStageIds);
    const isHeld = (status) => isStatus(status, heldCanonical, heldStageIds);
    const isApproved = (status) => isStatus(status, approvedCanonical, approvedStageIds);
    const isRejected = (status) => isStatus(status, rejectedCanonical, rejectedStageIds);

    const scheduledSubmissions = allSubmissions?.filter(s => 
      isVerified(s.workflow_status) || isDDMeetAttended(s.workflow_status) || 
      isHeld(s.workflow_status) || isApproved(s.workflow_status) || isRejected(s.workflow_status)
    ) || [];

    const completedSubmissions = allSubmissions?.filter(s => 
      isDDMeetAttended(s.workflow_status) || isHeld(s.workflow_status) || 
      isApproved(s.workflow_status) || isRejected(s.workflow_status)
    ) || [];

    const heldSubmissions = allSubmissions?.filter(s => isHeld(s.workflow_status)) || [];
    const approvedSubmissions = allSubmissions?.filter(s => isApproved(s.workflow_status)) || [];
    const rejectedSubmissions = allSubmissions?.filter(s => isRejected(s.workflow_status)) || [];

    const ddMeetAttendedOnly = allSubmissions?.filter(s => isDDMeetAttended(s.workflow_status)) || [];

    const scheduledMeetings = scheduledSubmissions.length;
    const completedMeetings = completedSubmissions.length;
    const completionRate = scheduledMeetings > 0 ? Math.round((completedMeetings / scheduledMeetings) * 100) : 0;

    const totalWithOutcome = heldSubmissions.length + approvedSubmissions.length + rejectedSubmissions.length;
    const pendingOutcomes = ddMeetAttendedOnly.length;

    const outcomes = {
      held: { 
        count: heldSubmissions.length, 
        percentage: totalWithOutcome > 0 ? Math.round((heldSubmissions.length / totalWithOutcome) * 100) : 0 
      },
      approved: { 
        count: approvedSubmissions.length, 
        percentage: totalWithOutcome > 0 ? Math.round((approvedSubmissions.length / totalWithOutcome) * 100) : 0 
      },
      rejected: { 
        count: rejectedSubmissions.length, 
        percentage: totalWithOutcome > 0 ? Math.round((rejectedSubmissions.length / totalWithOutcome) * 100) : 0 
      }
    };

    let totalSchedulingMs = 0;
    const schedulingDaysArray = [];

    completedSubmissions.forEach(sub => {
      const created = new Date(sub.created_at);
      const updated = new Date(sub.updated_at);
      const schedulingMs = updated.getTime() - created.getTime();
      const schedulingDays = schedulingMs / (1000 * 60 * 60 * 24);
      totalSchedulingMs += schedulingMs;
      schedulingDaysArray.push(schedulingDays);
    });

    const averageSchedulingMs = completedMeetings > 0 ? totalSchedulingMs / completedMeetings : 0;
    const averageSchedulingDays = averageSchedulingMs / (1000 * 60 * 60 * 24);
    const averageSchedulingHours = averageSchedulingMs / (1000 * 60 * 60);

    const schedulingRanges = [
      { range: '0-5 days', min: 0, max: 5 },
      { range: '6-10 days', min: 6, max: 10 },
      { range: '11-15 days', min: 11, max: 15 },
      { range: '16+ days', min: 16, max: Infinity }
    ];

    const schedulingTimeBreakdown = schedulingRanges.map(r => {
      const count = schedulingDaysArray.filter(d => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: completedMeetings > 0 ? Math.round((count / completedMeetings) * 100) : 0
      };
    });

    const submissionsWithScores = allSubmissions?.filter(s => 
      s.due_diligence_score !== null && s.due_diligence_score !== undefined &&
      (isDDMeetAttended(s.workflow_status) || isHeld(s.workflow_status) || 
       isApproved(s.workflow_status) || isRejected(s.workflow_status))
    ) || [];

    const scoreRanges = [
      { range: '0-25', label: 'Low', color: '#EF4444', min: 0, max: 25 },
      { range: '26-50', label: 'Medium-Low', color: '#F59E0B', min: 26, max: 50 },
      { range: '51-75', label: 'Medium-High', color: '#84CC16', min: 51, max: 75 },
      { range: '76-100', label: 'High', color: '#22C55E', min: 76, max: 100 }
    ];

    const totalWithScores = submissionsWithScores.length;
    const scoreDistribution = scoreRanges.map(r => {
      const count = submissionsWithScores.filter(s => s.due_diligence_score >= r.min && s.due_diligence_score <= r.max).length;
      return {
        range: r.range,
        label: r.label,
        color: r.color,
        count,
        percentage: totalWithScores > 0 ? Math.round((count / totalWithScores) * 100) : 0
      };
    });

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

    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const outcomesByPeriod = {};

    periods.forEach(periodKey => {
      if (periodKey === 'all') {
        outcomesByPeriod[periodKey] = {
          scheduled: scheduledMeetings,
          completed: completedMeetings,
          completionRate,
          change: null,
          changeDirection: null
        };
        return;
      }

      const { start, prevStart, prevEnd } = getPeriodBounds(periodKey);

      const currentScheduled = scheduledSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= start && updated <= now;
      }).length;

      const currentCompleted = completedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= start && updated <= now;
      }).length;

      const previousCompleted = completedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= prevStart && updated < prevEnd;
      }).length;

      const currentRate = currentScheduled > 0 ? Math.round((currentCompleted / currentScheduled) * 100) : 0;
      const change = previousCompleted > 0 ? Math.round(((currentCompleted - previousCompleted) / previousCompleted) * 100) : (currentCompleted > 0 ? 100 : 0);
      const changeDirection = currentCompleted >= previousCompleted ? 'up' : 'down';

      outcomesByPeriod[periodKey] = {
        scheduled: currentScheduled,
        completed: currentCompleted,
        completionRate: currentRate,
        change: Math.abs(change),
        changeDirection
      };
    });

    return res.status(200).json({
      scheduledMeetings,
      completedMeetings,
      completionRate,
      averageSchedulingDays: Math.round(averageSchedulingDays * 10) / 10,
      averageSchedulingHours: Math.round(averageSchedulingHours),
      pendingOutcomes,
      outcomes,
      outcomesByPeriod,
      scoreDistribution,
      schedulingTimeBreakdown,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in due-diligence-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
