import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  parseFilters,
  buildRangePredicate,
  getPeriodBounds,
  buildStageMaps,
  mkMatchers,
  getDecisionAt,
  findActorForFirstTransition,
  isStatusHistoryEvent,
  getStatusFromHistory,
  CANONICAL,
} from './_ddReportHelpers.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    const { tenantId } = tenantContext;
    const now = new Date();
    const filters = parseFilters(req.query);
    const inFilterRange = buildRangePredicate(filters, now);
    const slaThresholdDays = Math.max(0, parseInt(req.query.slaDays, 10) || 0);

    let formsQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    if (filters.formId) formsQuery = formsQuery.eq('form_id', filters.formId);
    const { data: ddConfigs, error: configError } = await formsQuery;
    if (configError) return res.status(500).json({ error: 'Failed to fetch configuration' });

    const formIds = ddConfigs?.map((c) => c.form_id) || [];
    if (formIds.length === 0) {
      return res.status(200).json({
        totalDecisions: 0,
        approved: { count: 0, percentage: 0 },
        declined: { count: 0, percentage: 0 },
        onHold: { count: 0, percentage: 0 },
        decisionsByPeriod: {},
        monthlyTrend: [],
        averageTimeToDecision: { approved: 0, declined: 0, onHold: 0 },
        scoreVsOutcome: [],
        decisionsByReviewer: [],
        lastUpdated: now.toISOString(),
      });
    }

    const { stageMaps, isHeldDecisionForForm } = buildStageMaps(ddConfigs);
    const matchers = mkMatchers(stageMaps);

    const { data: ddRows, error: ddErr } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, due_diligence_score, created_at, archived_at')
      .eq('tenant_id', tenantId)
      .is('archived_at', null);
    if (ddErr) return res.status(500).json({ error: 'Failed to fetch DD submissions' });

    const fsIds = (ddRows || []).map((r) => r.form_submission_id).filter(Boolean);
    const fsMap = {};
    if (fsIds.length > 0) {
      const { data: fsList } = await supabase
        .from('form_submission')
        .select('id, form_id, created_at')
        .in('id', fsIds);
      (fsList || []).forEach((fs) => { fsMap[fs.id] = fs; });
    }

    const allSubmissions = (ddRows || [])
      .map((r) => {
        const fs = fsMap[r.form_submission_id];
        if (!fs || !formIds.includes(fs.form_id)) return null;
        return { ...r, _formId: fs.form_id, _submissionCreatedAt: fs.created_at || r.created_at };
      })
      .filter(Boolean);

    // Held may be a decision (post-decision hold) OR a meeting outcome.
    // Use per-form stage-order disambiguation.
    const isOnHoldDecision = (sub) =>
      matchers.isHeld(sub.workflow_status) && isHeldDecisionForForm(sub._formId);

    const approvedSubsAll = allSubmissions.filter((s) => matchers.isApproved(s.workflow_status));
    const declinedSubsAll = allSubmissions.filter((s) => matchers.isRejected(s.workflow_status));
    const onHoldSubsAll = allSubmissions.filter(isOnHoldDecision);

    // Apply date filter using the *decision timestamp* from history_log
    const inRange = (sub) => {
      const at = getDecisionAt(sub, matchers, isHeldDecisionForForm, sub._formId);
      return at ? inFilterRange(at) : inFilterRange(sub._submissionCreatedAt);
    };
    const approvedSubs = approvedSubsAll.filter(inRange);
    const declinedSubs = declinedSubsAll.filter(inRange);
    const onHoldSubs = onHoldSubsAll.filter(inRange);

    const totalDecisions = approvedSubs.length + declinedSubs.length + onHoldSubs.length;
    const approved = {
      count: approvedSubs.length,
      percentage: totalDecisions > 0 ? Math.round((approvedSubs.length / totalDecisions) * 100) : 0,
    };
    const declined = {
      count: declinedSubs.length,
      percentage: totalDecisions > 0 ? Math.round((declinedSubs.length / totalDecisions) * 100) : 0,
    };
    const onHold = {
      count: onHoldSubs.length,
      percentage: totalDecisions > 0 ? Math.round((onHoldSubs.length / totalDecisions) * 100) : 0,
    };

    // ---- Average time to decision (from submission creation to decision event) ----
    const calculateAvgDays = (subs) => {
      if (subs.length === 0) return 0;
      let totalMs = 0;
      let n = 0;
      subs.forEach((sub) => {
        const at = getDecisionAt(sub, matchers, isHeldDecisionForForm, sub._formId);
        if (!at) return;
        const created = new Date(sub._submissionCreatedAt);
        const ms = at - created;
        if (ms >= 0) {
          totalMs += ms;
          n += 1;
        }
      });
      return n > 0 ? Math.round((totalMs / n / 86_400_000) * 10) / 10 : 0;
    };
    const averageTimeToDecision = {
      approved: calculateAvgDays(approvedSubs),
      declined: calculateAvgDays(declinedSubs),
      onHold: calculateAvgDays(onHoldSubs),
    };

    // ---- Period stats using decision timestamp ----
    const calculatePeriodStats = (subs, periodKey) => {
      if (periodKey === 'all') {
        return { current: subs.length, previous: null, change: null, changeDirection: null };
      }
      const { start, prevStart, prevEnd } = getPeriodBounds(periodKey, now);
      const inWindow = (sub, lo, hi, exclusive) => {
        const at = getDecisionAt(sub, matchers, isHeldDecisionForForm, sub._formId);
        if (!at) return false;
        if (exclusive) return at >= lo && at < hi;
        return at >= lo && at <= hi;
      };
      const current = subs.filter((s) => inWindow(s, start, now, false)).length;
      const previous = subs.filter((s) => inWindow(s, prevStart, prevEnd, true)).length;
      const change = previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);
      return { current, previous, change: Math.abs(change), changeDirection: current >= previous ? 'up' : 'down' };
    };
    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const decisionsByPeriod = {};
    periods.forEach((periodKey) => {
      const a = calculatePeriodStats(approvedSubsAll, periodKey);
      const d = calculatePeriodStats(declinedSubsAll, periodKey);
      const h = calculatePeriodStats(onHoldSubsAll, periodKey);
      const totalCurrent = a.current + d.current + h.current;
      const totalPrevious = periodKey === 'all' ? null : (a.previous + d.previous + h.previous);
      const totalChange = totalPrevious > 0
        ? Math.round(((totalCurrent - totalPrevious) / totalPrevious) * 100)
        : (totalCurrent > 0 ? 100 : 0);
      decisionsByPeriod[periodKey] = {
        approved: a,
        declined: d,
        onHold: h,
        total: {
          current: totalCurrent,
          previous: totalPrevious,
          change: periodKey === 'all' ? null : Math.abs(totalChange),
          changeDirection: periodKey === 'all' ? null : (totalCurrent >= (totalPrevious || 0) ? 'up' : 'down'),
        },
      };
    });

    // Custom range entry uses the active filter window via decision-timestamp; no comparison.
    if (filters.period === 'custom') {
      const customCount = (subs) => subs.filter((s) => {
        const at = getDecisionAt(s, matchers, isHeldDecisionForForm, s._formId);
        return at ? inFilterRange(at) : false;
      }).length;
      const aC = customCount(approvedSubsAll);
      const dC = customCount(declinedSubsAll);
      const hC = customCount(onHoldSubsAll);
      decisionsByPeriod.custom = {
        approved: { current: aC, previous: null, change: null, changeDirection: null },
        declined: { current: dC, previous: null, change: null, changeDirection: null },
        onHold: { current: hC, previous: null, change: null, changeDirection: null },
        total: { current: aC + dC + hC, previous: null, change: null, changeDirection: null },
      };
    }

    // ---- Monthly trend (by decision timestamp) ----
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthName = monthStart.toLocaleString('default', { month: 'short' });
      const inMonth = (sub) => {
        const at = getDecisionAt(sub, matchers, isHeldDecisionForForm, sub._formId);
        return at && at >= monthStart && at <= monthEnd;
      };
      monthlyTrend.push({
        month: monthName,
        approved: approvedSubsAll.filter(inMonth).length,
        declined: declinedSubsAll.filter(inMonth).length,
        onHold: onHoldSubsAll.filter(inMonth).length,
      });
    }

    // ---- Average DD score per outcome ----
    const avgScoreOf = (subs) => {
      const scored = subs.filter((s) => s.due_diligence_score !== null && s.due_diligence_score !== undefined);
      if (scored.length === 0) return { average: 0, count: 0 };
      const sum = scored.reduce((acc, s) => acc + Number(s.due_diligence_score || 0), 0);
      return { average: Math.round((sum / scored.length) * 10) / 10, count: scored.length };
    };
    const avgScoreByOutcome = {
      approved: avgScoreOf(approvedSubs),
      declined: avgScoreOf(declinedSubs),
      onHold: avgScoreOf(onHoldSubs),
    };
    const scoreVsOutcome = [
      { outcome: 'approved', label: 'Approved', averageScore: avgScoreByOutcome.approved.average, count: avgScoreByOutcome.approved.count },
      { outcome: 'declined', label: 'Declined', averageScore: avgScoreByOutcome.declined.average, count: avgScoreByOutcome.declined.count },
      { outcome: 'onHold', label: 'On Hold', averageScore: avgScoreByOutcome.onHold.average, count: avgScoreByOutcome.onHold.count },
    ];

    // ---- Decisions by reviewer ----
    const reviewerMap = new Map();
    const trackReviewer = (sub, kind) => {
      const actor = findActorForFirstTransition(sub.history_log, (canonical, entry) => {
        if (kind === 'approved') return matchers.isApproved(canonical);
        if (kind === 'declined') return matchers.isRejected(canonical);
        if (kind === 'onHold') return matchers.isHeld(canonical);
        return false;
      }) || 'Unknown';
      const cur = reviewerMap.get(actor) || { reviewer: actor, approved: 0, declined: 0, onHold: 0, total: 0 };
      cur[kind] += 1;
      cur.total += 1;
      reviewerMap.set(actor, cur);
    };
    approvedSubs.forEach((s) => trackReviewer(s, 'approved'));
    declinedSubs.forEach((s) => trackReviewer(s, 'declined'));
    onHoldSubs.forEach((s) => trackReviewer(s, 'onHold'));
    const decisionsByReviewer = Array.from(reviewerMap.values()).sort((a, b) => b.total - a.total);

    // ---- SLA breaches: items past meeting (awaiting a decision) longer than threshold ----
    let slaBreachedCount = 0;
    if (slaThresholdDays > 0) {
      const isAwaitingDecision = (s) => {
        if (matchers.isApproved(s.workflow_status) || matchers.isRejected(s.workflow_status)) return false;
        if (matchers.isHeld(s.workflow_status) && isHeldDecisionForForm(s._formId)) return false;
        return matchers.isDDMeetAttended(s.workflow_status) ||
          (matchers.isHeld(s.workflow_status) && !isHeldDecisionForForm(s._formId));
      };
      const awaiting = allSubmissions.filter(isAwaitingDecision);
      slaBreachedCount = awaiting.filter((s) => {
        const enteredAt = (() => {
          try {
            const log = Array.isArray(s.history_log) ? s.history_log : (s.history_log ? JSON.parse(s.history_log) : []);
            const last = log
              .filter(isStatusHistoryEvent)
              .map((e) => ({ ts: new Date(e?.timestamp || e?.at || s._submissionCreatedAt), status: getStatusFromHistory(e, 'new') }))
              .filter((e) => e.status && (matchers.isDDMeetAttended(e.status) || matchers.isHeld(e.status)))
              .pop();
            return last ? last.ts : new Date(s._submissionCreatedAt);
          } catch { return new Date(s._submissionCreatedAt); }
        })();
        const ageDays = (now - enteredAt) / 86_400_000;
        return ageDays > slaThresholdDays;
      }).length;
    }

    return res.status(200).json({
      totalDecisions,
      approved,
      declined,
      onHold,
      decisionsByPeriod,
      monthlyTrend,
      averageTimeToDecision,
      scoreVsOutcome,
      avgScoreByOutcome,
      decisionsByReviewer,
      slaBreaches: { thresholdDays: slaThresholdDays, breachedCount: slaBreachedCount },
      heldDisambiguation: Object.fromEntries(formIds.map((fid) => [fid, isHeldDecisionForForm(fid) ? 'decision' : 'meeting'])),
      filtersApplied: filters,
      lastUpdated: now.toISOString(),
    });
  } catch (error) {
    console.error('[decisions-stats] fatal', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
