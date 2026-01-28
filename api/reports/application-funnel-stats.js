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
        totalApplications: 0,
        stageBreakdown: [],
        conversionRates: [],
        dropOffAnalysis: [],
        averageTimePerStage: [],
        periodStats: {},
        funnelByPeriod: {},
        lastUpdated: now.toISOString()
      });
    }

    const stageConfigMap = {};
    ddConfigs.forEach(config => {
      const stages = config.workflow_stages || [];
      stageConfigMap[config.form_id] = stages;
    });

    const allStagesMap = new Map();
    let defaultInitialStageId = null;
    
    ddConfigs.forEach(config => {
      const stages = config.workflow_stages || [];
      stages.forEach((stage, idx) => {
        if (!allStagesMap.has(stage.id)) {
          allStagesMap.set(stage.id, {
            id: stage.id,
            label: stage.label,
            color: stage.color,
            order: stage.order ?? idx,
            is_initial: stage.is_initial
          });
        }
        if (stage.is_initial && !defaultInitialStageId) {
          defaultInitialStageId = stage.id;
        }
      });
    });

    const allStages = Array.from(allStagesMap.values())
      .sort((a, b) => a.order - b.order);
    
    if (!defaultInitialStageId && allStages.length > 0) {
      defaultInitialStageId = allStages[0].id;
    }
    if (!defaultInitialStageId) {
      defaultInitialStageId = 'new';
    }

    const { data: ddSubmissions, error: submissionError } = await supabase
      .from('form_submission_due_diligence')
      .select(`
        id,
        form_submission_id,
        workflow_status,
        history_log,
        created_at,
        updated_at,
        archived_at
      `)
      .eq('tenant_id', tenantId)
      .is('archived_at', null);

    if (submissionError) {
      console.error('Error fetching DD submissions:', submissionError);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const formSubmissionIds = ddSubmissions?.map(s => s.form_submission_id).filter(Boolean) || [];
    
    let formSubmissionMap = {};
    if (formSubmissionIds.length > 0) {
      const { data: formSubmissions, error: fsError } = await supabase
        .from('form_submission')
        .select('id, form_id')
        .in('id', formSubmissionIds);
      
      if (!fsError && formSubmissions) {
        formSubmissions.forEach(fs => {
          formSubmissionMap[fs.id] = fs.form_id;
        });
      }
    }

    const relevantSubmissions = ddSubmissions?.filter(s => {
      const formId = formSubmissionMap[s.form_submission_id];
      return formIds.includes(formId);
    }) || [];

    const totalApplications = relevantSubmissions.length;

    relevantSubmissions.forEach(submission => {
      const status = submission.workflow_status || defaultInitialStageId;
      if (!allStagesMap.has(status)) {
        allStagesMap.set(status, {
          id: status,
          label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
          color: '#6b7280',
          order: allStagesMap.size,
          is_initial: false
        });
      }
    });

    const finalAllStages = Array.from(allStagesMap.values())
      .sort((a, b) => a.order - b.order);

    const stageCounts = {};
    finalAllStages.forEach(stage => {
      stageCounts[stage.id] = 0;
    });

    relevantSubmissions.forEach(submission => {
      const status = submission.workflow_status || defaultInitialStageId;
      stageCounts[status] = (stageCounts[status] || 0) + 1;
    });

    const stageBreakdown = finalAllStages.map(stage => ({
      id: stage.id,
      label: stage.label,
      color: stage.color,
      count: stageCounts[stage.id] || 0,
      percentage: totalApplications > 0 
        ? Math.round((stageCounts[stage.id] || 0) / totalApplications * 100 * 10) / 10 
        : 0
    }));

    const everReachedStage = {};
    finalAllStages.forEach(stage => {
      everReachedStage[stage.id] = 0;
    });

    relevantSubmissions.forEach(submission => {
      const historyLog = submission.history_log || [];
      const currentStatus = submission.workflow_status || defaultInitialStageId;
      const reachedStages = new Set([currentStatus]);
      
      reachedStages.add(defaultInitialStageId);
      
      historyLog.forEach(entry => {
        if (entry.event_type === 'status_change' || entry.event_type === 'workflow_status_change') {
          if (entry.details?.new_status) {
            reachedStages.add(entry.details.new_status);
          }
          if (entry.details?.old_status) {
            reachedStages.add(entry.details.old_status);
          }
        }
      });
      
      reachedStages.forEach(stageId => {
        if (everReachedStage[stageId] !== undefined) {
          everReachedStage[stageId]++;
        } else {
          everReachedStage[stageId] = 1;
        }
      });
    });

    const conversionRates = [];
    for (let i = 1; i < finalAllStages.length; i++) {
      const fromStage = finalAllStages[i - 1];
      const toStage = finalAllStages[i];
      const fromCount = everReachedStage[fromStage.id] || 0;
      const toCount = everReachedStage[toStage.id] || 0;
      
      conversionRates.push({
        fromStage: fromStage.label,
        fromStageId: fromStage.id,
        toStage: toStage.label,
        toStageId: toStage.id,
        fromCount,
        toCount,
        rate: fromCount > 0 ? Math.round(toCount / fromCount * 100 * 10) / 10 : 0
      });
    }

    const dropOffAnalysis = finalAllStages.map((stage, idx) => {
      const currentCount = stageCounts[stage.id] || 0;
      const enteredCount = everReachedStage[stage.id] || 0;
      const exitedCount = idx < finalAllStages.length - 1 
        ? everReachedStage[finalAllStages[idx + 1]?.id] || 0 
        : 0;
      const stuckCount = enteredCount - exitedCount;
      
      return {
        stageId: stage.id,
        stageLabel: stage.label,
        color: stage.color,
        entered: enteredCount,
        exited: exitedCount,
        stuck: Math.max(0, stuckCount),
        currentlyAt: currentCount,
        dropOffRate: enteredCount > 0 
          ? Math.round((1 - exitedCount / enteredCount) * 100 * 10) / 10 
          : 0
      };
    });

    const stageTimeData = {};
    finalAllStages.forEach(stage => {
      stageTimeData[stage.id] = [];
    });

    relevantSubmissions.forEach(submission => {
      const historyLog = submission.history_log || [];
      const statusChanges = historyLog
        .filter(entry => 
          entry.event_type === 'status_change' || 
          entry.event_type === 'workflow_status_change'
        )
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      const createdAt = new Date(submission.created_at);
      const currentStatus = submission.workflow_status || defaultInitialStageId;
      let stageEnterTimes = {};
      stageEnterTimes[defaultInitialStageId] = createdAt;
      
      statusChanges.forEach(entry => {
        const timestamp = new Date(entry.timestamp);
        const oldStatus = entry.details?.old_status;
        const newStatus = entry.details?.new_status;
        
        if (oldStatus && stageEnterTimes[oldStatus]) {
          const duration = timestamp - stageEnterTimes[oldStatus];
          if (stageTimeData[oldStatus]) {
            stageTimeData[oldStatus].push(duration);
          } else {
            stageTimeData[oldStatus] = [duration];
          }
          delete stageEnterTimes[oldStatus];
        }
        
        if (newStatus) {
          stageEnterTimes[newStatus] = timestamp;
        }
      });
      
      if (stageEnterTimes[currentStatus]) {
        const durationToNow = now - stageEnterTimes[currentStatus];
        if (stageTimeData[currentStatus]) {
          stageTimeData[currentStatus].push(durationToNow);
        } else {
          stageTimeData[currentStatus] = [durationToNow];
        }
      }
    });

    const averageTimePerStage = finalAllStages.map(stage => {
      const times = stageTimeData[stage.id] || [];
      const avgMs = times.length > 0 
        ? times.reduce((a, b) => a + b, 0) / times.length 
        : 0;
      const avgDays = avgMs / (1000 * 60 * 60 * 24);
      
      return {
        stageId: stage.id,
        stageLabel: stage.label,
        color: stage.color,
        averageDays: Math.round(avgDays * 10) / 10,
        averageHours: Math.round(avgMs / (1000 * 60 * 60) * 10) / 10,
        sampleSize: times.length
      };
    });

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

    const countSubmissionsInRange = (submissions, startDate, endDate) => {
      if (!startDate) return submissions.length;
      return submissions.filter(s => {
        const created = new Date(s.created_at);
        return created >= startDate && created <= endDate;
      }).length;
    };

    const calculatePeriodStats = (period) => {
      if (period === 'all') {
        return {
          period,
          current: totalApplications,
          previous: null,
          change: null,
          changeDirection: null,
          isAllTime: true
        };
      }
      
      const { start, end, prevStart, prevEnd } = getDateRange(period);
      const current = countSubmissionsInRange(relevantSubmissions, start, end);
      const previous = countSubmissionsInRange(relevantSubmissions, prevStart, prevEnd);
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
      periodStats[period] = calculatePeriodStats(period);
    }

    const getFunnelDataForPeriod = (period) => {
      const { start } = period === 'all' 
        ? { start: null } 
        : getDateRange(period);
      
      const filteredSubmissions = start 
        ? relevantSubmissions.filter(s => new Date(s.created_at) >= start)
        : relevantSubmissions;
      
      const periodStageCounts = {};
      finalAllStages.forEach(stage => {
        periodStageCounts[stage.id] = 0;
      });
      
      filteredSubmissions.forEach(submission => {
        const status = submission.workflow_status || defaultInitialStageId;
        periodStageCounts[status] = (periodStageCounts[status] || 0) + 1;
      });
      
      return finalAllStages.map(stage => ({
        label: stage.label,
        count: periodStageCounts[stage.id] || 0,
        color: stage.color
      }));
    };

    const funnelByPeriod = {};
    for (const period of periods) {
      funnelByPeriod[period] = getFunnelDataForPeriod(period);
    }

    const stats = {
      totalApplications,
      stageBreakdown,
      conversionRates,
      dropOffAnalysis,
      averageTimePerStage,
      periodStats,
      funnelByPeriod,
      allStages: finalAllStages,
      lastUpdated: now.toISOString()
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in application-funnel-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
