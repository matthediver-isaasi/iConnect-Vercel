import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  canonicalizeKey,
  parseFilters,
  getPeriodBounds,
  buildRangePredicate,
  isStatusHistoryEvent,
  getStatusFromHistory,
  sortedHistory,
} from './_ddReportHelpers.js';

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
    const filters = parseFilters(req.query);
    const inFilterRange = buildRangePredicate(filters, now);

    let formsQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    if (filters.formId) formsQuery = formsQuery.eq('form_id', filters.formId);

    const { data: ddConfigs, error: configError } = await formsQuery;
    if (configError) {
      console.error('[funnel-stats] config error', configError);
      return res.status(500).json({ error: 'Failed to fetch configuration' });
    }

    const formIds = ddConfigs?.map((c) => c.form_id) || [];
    if (formIds.length === 0) {
      return res.status(200).json({
        totalApplications: 0,
        stageBreakdown: [],
        conversionRates: [],
        dropOffAnalysis: [],
        averageTimePerStage: [],
        periodStats: {},
        funnelByPeriod: {},
        allStages: [],
        lastUpdated: now.toISOString(),
      });
    }

    // ---- Build canonical stage map (merged across forms) ----
    const allStagesMap = new Map();
    const stageIdToCanonicalKey = new Map();
    let defaultInitialStageId = null;

    ddConfigs.forEach((config) => {
      (config.workflow_stages || []).forEach((stage, idx) => {
        const canonicalKey = canonicalizeKey(stage.label);
        stageIdToCanonicalKey.set(stage.id, canonicalKey);
        stageIdToCanonicalKey.set(canonicalizeKey(stage.id), canonicalKey);
        stageIdToCanonicalKey.set(canonicalizeKey(stage.label), canonicalKey);
        const stageOrder = stage.order ?? idx;

        if (!allStagesMap.has(canonicalKey)) {
          allStagesMap.set(canonicalKey, {
            id: canonicalKey,
            label: stage.label,
            color: stage.color,
            order: stageOrder,
            is_initial: !!stage.is_initial,
          });
        } else {
          const existing = allStagesMap.get(canonicalKey);
          if (stageOrder < existing.order) existing.order = stageOrder;
          if (stage.is_initial) existing.is_initial = true;
        }
        if (stage.is_initial && !defaultInitialStageId) defaultInitialStageId = canonicalKey;
      });
    });

    const normalizeStatus = (status) => {
      if (!status) return null;
      if (stageIdToCanonicalKey.has(status)) return stageIdToCanonicalKey.get(status);
      const c = canonicalizeKey(status);
      if (stageIdToCanonicalKey.has(c)) return stageIdToCanonicalKey.get(c);
      if (allStagesMap.has(c)) return c;
      return c;
    };

    if (!defaultInitialStageId) {
      const sorted = Array.from(allStagesMap.values()).sort((a, b) => a.order - b.order);
      defaultInitialStageId = sorted[0]?.id || 'new';
    }

    // ---- Fetch DD submissions joined to form_submission for form-id filter ----
    const { data: ddSubmissions, error: subErr } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, created_at, archived_at')
      .eq('tenant_id', tenantId)
      .is('archived_at', null);

    if (subErr) {
      console.error('[funnel-stats] sub error', subErr);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const formSubmissionIds = (ddSubmissions || []).map((s) => s.form_submission_id).filter(Boolean);
    const formSubmissionMap = {};
    if (formSubmissionIds.length > 0) {
      const { data: formSubs } = await supabase
        .from('form_submission')
        .select('id, form_id')
        .in('id', formSubmissionIds);
      (formSubs || []).forEach((fs) => { formSubmissionMap[fs.id] = fs.form_id; });
    }

    const allRelevant = (ddSubmissions || []).filter((s) =>
      formIds.includes(formSubmissionMap[s.form_submission_id]),
    );

    // Filter by date range (created_at) for the *current* counts.
    const relevantSubmissions = allRelevant.filter((s) => inFilterRange(s.created_at));
    const totalApplications = relevantSubmissions.length;

    // Discover unknown stages
    const processedUnknown = new Set();
    relevantSubmissions.forEach((s) => {
      const raw = s.workflow_status;
      if (!raw) return;
      const norm = normalizeStatus(raw) || defaultInitialStageId;
      if (allStagesMap.has(norm) || processedUnknown.has(norm)) return;
      processedUnknown.add(norm);
      const readableLabel = norm.charAt(0).toUpperCase() + norm.slice(1);
      allStagesMap.set(norm, {
        id: norm,
        label: readableLabel,
        color: '#6b7280',
        order: 1000 + allStagesMap.size,
        is_initial: false,
      });
      stageIdToCanonicalKey.set(norm, norm);
      stageIdToCanonicalKey.set(raw, norm);
      stageIdToCanonicalKey.set(canonicalizeKey(raw), norm);
    });

    const finalAllStages = Array.from(allStagesMap.values()).sort((a, b) => a.order - b.order);

    // ---- Stage breakdown (current state) ----
    const stageCounts = Object.fromEntries(finalAllStages.map((s) => [s.id, 0]));
    relevantSubmissions.forEach((s) => {
      const status = normalizeStatus(s.workflow_status) || defaultInitialStageId;
      stageCounts[status] = (stageCounts[status] || 0) + 1;
    });
    const stageBreakdown = finalAllStages.map((s) => ({
      id: s.id,
      label: s.label,
      color: s.color,
      count: stageCounts[s.id] || 0,
      percentage: totalApplications > 0
        ? Math.round((stageCounts[s.id] || 0) / totalApplications * 1000) / 10
        : 0,
    }));

    // ---- Ever-reached counts using history_log (canonical event) ----
    const everReachedStage = Object.fromEntries(finalAllStages.map((s) => [s.id, 0]));
    relevantSubmissions.forEach((s) => {
      const reached = new Set([defaultInitialStageId]);
      const currentStatus = normalizeStatus(s.workflow_status) || defaultInitialStageId;
      reached.add(currentStatus);
      (s.history_log || []).forEach((entry) => {
        if (!isStatusHistoryEvent(entry)) return;
        const newStatus = getStatusFromHistory(entry, 'new');
        const prevStatus = getStatusFromHistory(entry, 'previous');
        if (newStatus) reached.add(normalizeStatus(newStatus) || newStatus);
        if (prevStatus) reached.add(normalizeStatus(prevStatus) || prevStatus);
      });
      reached.forEach((stageId) => {
        if (everReachedStage[stageId] !== undefined) everReachedStage[stageId]++;
        else everReachedStage[stageId] = 1;
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
        rate: fromCount > 0 ? Math.round(toCount / fromCount * 1000) / 10 : 0,
      });
    }

    const dropOffAnalysis = finalAllStages.map((stage, idx) => {
      const currentCount = stageCounts[stage.id] || 0;
      const enteredCount = everReachedStage[stage.id] || 0;
      const exitedCount = idx < finalAllStages.length - 1
        ? (everReachedStage[finalAllStages[idx + 1]?.id] || 0)
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
          ? Math.round((1 - exitedCount / enteredCount) * 1000) / 10
          : 0,
      };
    });

    // ---- Average time per stage (history-log driven) ----
    const stageTimeData = Object.fromEntries(finalAllStages.map((s) => [s.id, []]));
    relevantSubmissions.forEach((s) => {
      const events = sortedHistory(s.history_log);
      const createdAt = new Date(s.created_at);
      const currentStatus = normalizeStatus(s.workflow_status) || defaultInitialStageId;
      const stageEnterTimes = { [defaultInitialStageId]: createdAt };

      events.forEach((entry) => {
        const t = entry.timestamp ? new Date(entry.timestamp) : null;
        if (!t) return;
        const oldStatus = normalizeStatus(getStatusFromHistory(entry, 'previous')) || getStatusFromHistory(entry, 'previous');
        const newStatus = normalizeStatus(getStatusFromHistory(entry, 'new')) || getStatusFromHistory(entry, 'new');
        if (oldStatus && stageEnterTimes[oldStatus]) {
          const dur = t - stageEnterTimes[oldStatus];
          (stageTimeData[oldStatus] = stageTimeData[oldStatus] || []).push(dur);
          delete stageEnterTimes[oldStatus];
        }
        if (newStatus) stageEnterTimes[newStatus] = t;
      });

      if (stageEnterTimes[currentStatus]) {
        const dur = now - stageEnterTimes[currentStatus];
        (stageTimeData[currentStatus] = stageTimeData[currentStatus] || []).push(dur);
      }
    });

    const averageTimePerStage = finalAllStages.map((stage) => {
      const times = stageTimeData[stage.id] || [];
      const avgMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      return {
        stageId: stage.id,
        stageLabel: stage.label,
        color: stage.color,
        averageDays: Math.round((avgMs / 86_400_000) * 10) / 10,
        averageHours: Math.round((avgMs / 3_600_000) * 10) / 10,
        sampleSize: times.length,
      };
    });

    // ---- Period stats / funnelByPeriod (count uses *all* submissions, not pre-filtered) ----
    const countSubmissionsInRange = (subs, start, end) => {
      if (!start) return subs.length;
      return subs.filter((s) => {
        const c = new Date(s.created_at);
        return c >= start && c <= end;
      }).length;
    };

    const calculatePeriodStats = (period) => {
      if (period === 'all') {
        return { period, current: allRelevant.length, previous: null, change: null, changeDirection: null, isAllTime: true };
      }
      const { start, end, prevStart, prevEnd } = getPeriodBounds(period, now);
      const current = countSubmissionsInRange(allRelevant, start, end);
      const previous = countSubmissionsInRange(allRelevant, prevStart, prevEnd);
      const change = previous > 0 ? ((current - previous) / previous) * 100 : (current > 0 ? 100 : 0);
      return {
        period,
        current,
        previous,
        change: Math.round(change * 10) / 10,
        changeDirection: current >= previous ? 'up' : 'down',
        isAllTime: false,
      };
    };

    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const periodStats = {};
    periods.forEach((p) => { periodStats[p] = calculatePeriodStats(p); });
    if (filters.period === 'custom') {
      const current = allRelevant.filter((s) => inFilterRange(s.created_at)).length;
      periodStats.custom = {
        period: 'custom',
        current,
        previous: null,
        change: null,
        changeDirection: null,
        isAllTime: false,
      };
    }

    const getFunnelDataForPeriod = (period) => {
      let filtered;
      if (period === 'custom') {
        filtered = allRelevant.filter((s) => inFilterRange(s.created_at));
      } else if (period === 'all') {
        filtered = allRelevant;
      } else {
        const { start } = getPeriodBounds(period, now);
        filtered = start ? allRelevant.filter((s) => new Date(s.created_at) >= start) : allRelevant;
      }
      const counts = Object.fromEntries(finalAllStages.map((s) => [s.id, 0]));
      filtered.forEach((s) => {
        const status = normalizeStatus(s.workflow_status) || defaultInitialStageId;
        counts[status] = (counts[status] || 0) + 1;
      });
      return finalAllStages.map((s) => ({ label: s.label, count: counts[s.id] || 0, color: s.color }));
    };

    const funnelByPeriod = {};
    periods.forEach((p) => { funnelByPeriod[p] = getFunnelDataForPeriod(p); });
    if (filters.period === 'custom') {
      funnelByPeriod.custom = getFunnelDataForPeriod('custom');
    }

    return res.status(200).json({
      totalApplications,
      stageBreakdown,
      conversionRates,
      dropOffAnalysis,
      averageTimePerStage,
      periodStats,
      funnelByPeriod,
      allStages: finalAllStages,
      filtersApplied: filters,
      lastUpdated: now.toISOString(),
    });
  } catch (error) {
    console.error('[funnel-stats] fatal', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
