import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  parseFilters,
  buildRangePredicate,
  getPeriodBounds,
  buildStageMaps,
  mkMatchers,
  getVerifiedAt,
  findCurrentStageEnteredAt,
  findActorForFirstTransition,
  CANONICAL,
  canonicalizeKey,
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
        totalVerified: 0,
        averageTurnaroundDays: 0,
        averageTurnaroundHours: 0,
        outstandingVerifications: 0,
        verifiedThisPeriod: {},
        turnaroundBreakdown: [],
        outstandingByAge: [],
        monthlyTrend: [],
        perDocumentStats: { byStatus: [], byField: [], averageTurnaroundDays: 0, totalDocuments: 0 },
        reviewerBreakdown: [],
        lastUpdated: now.toISOString(),
      });
    }

    const { stageMaps } = buildStageMaps(ddConfigs);
    const matchers = mkMatchers(stageMaps);

    // Use form_submission_due_diligence as the source of truth for workflow_status
    const { data: ddRows, error: ddErr } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, created_at, archived_at, reviewed_by')
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

    const enriched = (ddRows || [])
      .map((r) => {
        const fs = fsMap[r.form_submission_id];
        if (!fs || !formIds.includes(fs.form_id)) return null;
        return { ...r, _formId: fs.form_id, _submissionCreatedAt: fs.created_at || r.created_at };
      })
      .filter(Boolean);

    // Verified vs outstanding (current state)
    const verifiedSubs = enriched.filter((r) => matchers.isVerified(r.workflow_status));
    const outstandingSubs = enriched.filter((r) =>
      matchers.isInReview(r.workflow_status) || matchers.isNew(r.workflow_status) || !r.workflow_status,
    );

    // Verified-at timestamp from history_log; reject those falling outside filter window.
    const verifiedWithTime = verifiedSubs
      .map((r) => ({ row: r, at: getVerifiedAt(r, matchers) }))
      .filter((x) => x.at && inFilterRange(x.at));

    // Outstanding cohort filters by history-derived stage-entry timestamp so
    // the period filter reflects when each item *entered* its current
    // outstanding stage rather than when its underlying form was submitted.
    // Falls back to submission creation date when no transition is logged so
    // legacy data still surfaces.
    const outstandingFiltered = outstandingSubs.filter((r) => {
      const at = findCurrentStageEnteredAt(r.history_log, r.workflow_status, r._submissionCreatedAt);
      return at ? inFilterRange(at) : false;
    });

    const totalVerified = verifiedWithTime.length;
    const outstandingVerifications = outstandingFiltered.length;

    let totalTurnaroundMs = 0;
    const turnaroundDaysArray = [];
    verifiedWithTime.forEach(({ row, at }) => {
      const created = new Date(row._submissionCreatedAt);
      const ms = at - created;
      if (ms >= 0) {
        totalTurnaroundMs += ms;
        turnaroundDaysArray.push(ms / 86_400_000);
      }
    });
    const averageTurnaroundMs = totalVerified > 0 ? totalTurnaroundMs / totalVerified : 0;
    const averageTurnaroundDays = averageTurnaroundMs / 86_400_000;
    const averageTurnaroundHours = averageTurnaroundMs / 3_600_000;

    const turnaroundRanges = [
      { range: '0-2 days', min: 0, max: 2 },
      { range: '3-5 days', min: 3, max: 5 },
      { range: '6-10 days', min: 6, max: 10 },
      { range: '11+ days', min: 11, max: Infinity },
    ];

    const turnaroundBreakdown = turnaroundRanges.map((r) => {
      const count = turnaroundDaysArray.filter((d) => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: totalVerified > 0 ? Math.round((count / totalVerified) * 100) : 0,
      };
    });

    // Outstanding age = age since entering the *current* stage (history-driven).
    const outstandingAgeArray = outstandingFiltered.map((r) => {
      const enteredAt = findCurrentStageEnteredAt(r.history_log, r.workflow_status, r._submissionCreatedAt);
      const age = (now - enteredAt) / 86_400_000;
      return age;
    });
    const outstandingByAge = turnaroundRanges.map((r) => {
      const count = outstandingAgeArray.filter((d) => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: outstandingVerifications > 0 ? Math.round((count / outstandingVerifications) * 100) : 0,
      };
    });

    // Period stats (verified counts vs prior period)
    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const verifiedThisPeriod = {};
    const allVerifiedWithTime = verifiedSubs
      .map((r) => ({ row: r, at: getVerifiedAt(r, matchers) }))
      .filter((x) => !!x.at);

    periods.forEach((p) => {
      if (p === 'all') {
        verifiedThisPeriod[p] = {
          current: allVerifiedWithTime.length,
          previous: null,
          change: null,
          changeDirection: null,
        };
        return;
      }
      const { start, prevStart, prevEnd } = getPeriodBounds(p, now);
      const current = allVerifiedWithTime.filter(({ at }) => at >= start && at <= now).length;
      const previous = allVerifiedWithTime.filter(({ at }) => at >= prevStart && at < prevEnd).length;
      const change = previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);
      verifiedThisPeriod[p] = {
        current,
        previous,
        change: Math.abs(change),
        changeDirection: current >= previous ? 'up' : 'down',
      };
    });

    // Custom range entry uses the active filter window; no comparison.
    if (filters.period === 'custom') {
      const currentCustom = allVerifiedWithTime.filter(({ at }) => inFilterRange(at)).length;
      verifiedThisPeriod.custom = {
        current: currentCustom,
        previous: null,
        change: null,
        changeDirection: null,
      };
    }

    // ---- Monthly throughput (last 6 months) ----
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthLabel = monthStart.toLocaleString('default', { month: 'short' });
      const verifiedCount = allVerifiedWithTime.filter(({ at }) => at >= monthStart && at <= monthEnd).length;
      const submittedCount = enriched.filter((r) => {
        const c = new Date(r._submissionCreatedAt);
        return c >= monthStart && c <= monthEnd;
      }).length;
      monthlyTrend.push({ month: monthLabel, verified: verifiedCount, submitted: submittedCount });
    }

    // ---- Reviewer breakdown ----
    const reviewerCounts = new Map();
    verifiedWithTime.forEach(({ row, at }) => {
      const actor = findActorForFirstTransition(row.history_log, (canonical) => canonical === CANONICAL.verified || matchers.isVerified(canonical))
        || row.reviewed_by
        || 'Unknown';
      const created = new Date(row._submissionCreatedAt);
      const ms = at - created;
      const cur = reviewerCounts.get(actor) || { reviewer: actor, verifiedCount: 0, totalMs: 0 };
      cur.verifiedCount += 1;
      cur.totalMs += Math.max(0, ms);
      reviewerCounts.set(actor, cur);
    });
    const reviewerBreakdown = Array.from(reviewerCounts.values())
      .map((r) => ({
        reviewer: r.reviewer,
        verifiedCount: r.verifiedCount,
        averageTurnaroundDays: r.verifiedCount > 0 ? Math.round((r.totalMs / r.verifiedCount / 86_400_000) * 10) / 10 : 0,
      }))
      .sort((a, b) => b.verifiedCount - a.verifiedCount);

    // ---- Per-document stats (only for the form-filtered submissions) ----
    let perDocumentStats = { byStatus: [], byField: [], averageTurnaroundDays: 0, totalDocuments: 0 };
    const filteredFsIds = enriched.map((r) => r.form_submission_id).filter(Boolean);
    if (filteredFsIds.length > 0) {
      const { data: docs } = await supabase
        .from('submission_document')
        .select('id, form_submission_id, field_name, status, status_changed_at, status_changed_by, created_at')
        .eq('tenant_id', tenantId)
        .in('form_submission_id', filteredFsIds)
        .eq('is_current_version', true);
      const filteredDocs = (docs || []).filter((d) => inFilterRange(d.created_at || d.status_changed_at));
      const totalDocuments = filteredDocs.length;
      const statusCounts = { pending: 0, approved: 0, rejected: 0, aged: 0 };
      const turnarounds = [];
      const byFieldMap = new Map();
      filteredDocs.forEach((d) => {
        statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
        if (d.status_changed_at && d.created_at && (d.status === 'approved' || d.status === 'rejected')) {
          const ms = new Date(d.status_changed_at) - new Date(d.created_at);
          if (ms >= 0) turnarounds.push(ms / 86_400_000);
        }
        const fieldKey = d.field_name || 'Unknown';
        const fc = byFieldMap.get(fieldKey) || { field: fieldKey, total: 0, approved: 0, rejected: 0, pending: 0, aged: 0 };
        fc.total += 1;
        fc[d.status] = (fc[d.status] || 0) + 1;
        byFieldMap.set(fieldKey, fc);
      });
      const avgTurnaround = turnarounds.length > 0
        ? Math.round((turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length) * 10) / 10
        : 0;
      const byStatus = Object.entries(statusCounts).map(([status, count]) => ({
        status,
        count,
        percentage: totalDocuments > 0 ? Math.round((count / totalDocuments) * 100) : 0,
      }));
      const byField = Array.from(byFieldMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      perDocumentStats = { byStatus, byField, averageTurnaroundDays: avgTurnaround, totalDocuments };
    }

    // ---- SLA breaches: outstanding items still in their stage longer than threshold ----
    const slaBreachedCount = slaThresholdDays > 0
      ? outstandingAgeArray.filter((d) => d > slaThresholdDays).length
      : 0;

    return res.status(200).json({
      totalVerified,
      averageTurnaroundDays: Math.round(averageTurnaroundDays * 10) / 10,
      averageTurnaroundHours: Math.round(averageTurnaroundHours),
      outstandingVerifications,
      verifiedThisPeriod,
      turnaroundBreakdown,
      outstandingByAge,
      monthlyTrend,
      perDocumentStats,
      reviewerBreakdown,
      slaBreaches: { thresholdDays: slaThresholdDays, breachedCount: slaBreachedCount },
      filtersApplied: filters,
      lastUpdated: now.toISOString(),
    });
  } catch (error) {
    console.error('[verification-stats] fatal', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
