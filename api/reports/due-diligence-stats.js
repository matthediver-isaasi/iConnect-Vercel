import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  parseFilters,
  buildRangePredicate,
  getPeriodBounds,
  buildStageMaps,
  mkMatchers,
  getOutcomeAt,
  getVerifiedAt,
  findCurrentStageEnteredAt,
  findFirstTransitionAt,
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
        scheduledMeetings: 0,
        completedMeetings: 0,
        completionRate: 0,
        averageSchedulingDays: 0,
        averageSchedulingHours: 0,
        pendingOutcomes: 0,
        outcomes: { held: { count: 0, percentage: 0 }, approved: { count: 0, percentage: 0 }, rejected: { count: 0, percentage: 0 } },
        outcomesByPeriod: {},
        scoreDistribution: [],
        riskLevelDistribution: [],
        schedulingTimeBreakdown: [],
        meetingMetrics: { totalRequests: 0, booked: 0, pending: 0, expired: 0, cancelled: 0, noShow: 0, rescheduled: 0, completed: 0, averageLeadTimeHours: 0, averageBookingTimeHours: 0 },
        monthlyThroughput: [],
        lastUpdated: now.toISOString(),
      });
    }

    const { stageMaps, isHeldDecisionForForm } = buildStageMaps(ddConfigs);
    const matchers = mkMatchers(stageMaps);

    // ---- Pull DD submissions joined to form_submission ----
    const { data: ddRows, error: ddErr } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, due_diligence_score, risk_level, created_at, archived_at, dd_call_date')
      .eq('tenant_id', tenantId)
      .is('archived_at', null);
    if (ddErr) return res.status(500).json({ error: 'Failed to fetch submissions' });

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

    // ---- Categorise by stage-transition events (Held disambiguation per form) ----
    // Spec requires the period/date filter to apply to *event* timestamps from
    // history_log (not the submission's creation time). For each cohort below
    // we compute the relevant event timestamp (verified-transition for
    // "scheduled"; outcome-transition for "completed" / per-outcome buckets)
    // and only keep submissions whose event occurred inside the active range.
    const isHeldAsMeetingOutcome = (s) =>
      matchers.isHeld(s.workflow_status) && !isHeldDecisionForForm(s._formId);

    // Returns the timestamp the submission first transitioned to the given
    // outcome stage, or null if no such transition is in the history log.
    const getStageTransitionAt = (sub, predicate) =>
      findFirstTransitionAt(sub.history_log, predicate);

    // Currently-in-stage helpers (used for things that are inherently a
    // snapshot, e.g. "items currently awaiting a meeting"):
    const currentlyVerified = allSubmissions.filter((s) => matchers.isVerified(s.workflow_status));
    const currentlyDDMeetAttended = allSubmissions.filter((s) => matchers.isDDMeetAttended(s.workflow_status));

    // Event-time cohorts:
    // "scheduled" = submission has *ever* reached Verified or beyond AND that
    // initial verification transition fell inside the active range.
    const scheduled = allSubmissions.filter((sub) => {
      const everReached = matchers.isVerified(sub.workflow_status) ||
        matchers.isDDMeetAttended(sub.workflow_status) ||
        isHeldAsMeetingOutcome(sub) ||
        matchers.isApproved(sub.workflow_status) ||
        matchers.isRejected(sub.workflow_status);
      if (!everReached) return false;
      const at = getVerifiedAt(sub, matchers) || (sub._submissionCreatedAt ? new Date(sub._submissionCreatedAt) : null);
      return at ? inFilterRange(at) : false;
    });

    // "completed" = submission has reached an outcome stage AND that outcome
    // transition fell inside the active range.
    const completed = allSubmissions.filter((sub) => {
      const everCompleted = matchers.isDDMeetAttended(sub.workflow_status) ||
        isHeldAsMeetingOutcome(sub) ||
        matchers.isApproved(sub.workflow_status) ||
        matchers.isRejected(sub.workflow_status);
      if (!everCompleted) return false;
      const at = getOutcomeAt(sub, matchers);
      return at ? inFilterRange(at) : false;
    });

    // Per-outcome cohorts use the *specific* outcome transition timestamp.
    const heldSubs = allSubmissions.filter((s) => {
      if (!isHeldAsMeetingOutcome(s)) return false;
      const at = getStageTransitionAt(s, (canonical) => matchers.isHeld(canonical));
      return at ? inFilterRange(at) : false;
    });
    const approvedSubs = allSubmissions.filter((s) => {
      if (!matchers.isApproved(s.workflow_status)) return false;
      const at = getStageTransitionAt(s, (canonical) => matchers.isApproved(canonical));
      return at ? inFilterRange(at) : false;
    });
    const rejectedSubs = allSubmissions.filter((s) => {
      if (!matchers.isRejected(s.workflow_status)) return false;
      const at = getStageTransitionAt(s, (canonical) => matchers.isRejected(canonical));
      return at ? inFilterRange(at) : false;
    });
    const ddMeetAttendedOnly = allSubmissions.filter((s) => {
      if (!matchers.isDDMeetAttended(s.workflow_status)) return false;
      const at = getStageTransitionAt(s, (canonical) => matchers.isDDMeetAttended(canonical));
      return at ? inFilterRange(at) : false;
    });

    // Score/risk distributions: cohort = anything that has had an outcome
    // transition inside the active range. Falls back to currently-in-outcome
    // when no transition timestamp is available so existing data still surfaces.
    const submissionsInRange = allSubmissions.filter((s) => {
      const at = getOutcomeAt(s, matchers);
      if (at) return inFilterRange(at);
      return inFilterRange(s._submissionCreatedAt);
    });

    const scheduledMeetings = scheduled.length;
    const completedMeetings = completed.length;
    const completionRate = scheduledMeetings > 0 ? Math.round((completedMeetings / scheduledMeetings) * 100) : 0;
    const totalWithOutcome = heldSubs.length + approvedSubs.length + rejectedSubs.length;
    // Pending outcomes = items currently sitting in DD Meet Attended whose
    // entry into that stage falls inside the active filter range, so the
    // metric respects the same period/form/date controls as the rest of the
    // headline numbers. (Use currentlyDDMeetAttended.length for an unfiltered
    // snapshot if you ever need to surface one separately.)
    const pendingOutcomes = currentlyDDMeetAttended.filter((s) => {
      const at = getStageTransitionAt(s, (canonical) => matchers.isDDMeetAttended(canonical));
      return at ? inFilterRange(at) : false;
    }).length;

    const outcomes = {
      held: {
        count: heldSubs.length,
        percentage: totalWithOutcome > 0 ? Math.round((heldSubs.length / totalWithOutcome) * 100) : 0,
      },
      approved: {
        count: approvedSubs.length,
        percentage: totalWithOutcome > 0 ? Math.round((approvedSubs.length / totalWithOutcome) * 100) : 0,
      },
      rejected: {
        count: rejectedSubs.length,
        percentage: totalWithOutcome > 0 ? Math.round((rejectedSubs.length / totalWithOutcome) * 100) : 0,
      },
    };

    // ---- Average scheduling time: verified-transition -> outcome transition (history_log) ----
    let totalSchedulingMs = 0;
    const schedulingDaysArray = [];
    completed.forEach((sub) => {
      const startAt = getVerifiedAt(sub, matchers) || (sub._submissionCreatedAt ? new Date(sub._submissionCreatedAt) : null);
      const outcomeAt = getOutcomeAt(sub, matchers);
      if (!startAt || !outcomeAt) return;
      const ms = outcomeAt - startAt;
      if (ms >= 0) {
        totalSchedulingMs += ms;
        schedulingDaysArray.push(ms / 86_400_000);
      }
    });
    const averageSchedulingMs = schedulingDaysArray.length > 0 ? totalSchedulingMs / schedulingDaysArray.length : 0;
    const averageSchedulingDays = averageSchedulingMs / 86_400_000;
    const averageSchedulingHours = averageSchedulingMs / 3_600_000;

    const schedulingRanges = [
      { range: '0-5 days', min: 0, max: 5 },
      { range: '6-10 days', min: 6, max: 10 },
      { range: '11-15 days', min: 11, max: 15 },
      { range: '16+ days', min: 16, max: Infinity },
    ];
    const schedulingTimeBreakdown = schedulingRanges.map((r) => {
      const count = schedulingDaysArray.filter((d) => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: schedulingDaysArray.length > 0 ? Math.round((count / schedulingDaysArray.length) * 100) : 0,
      };
    });

    // ---- Score distribution (now reads dd-row score column) ----
    const submissionsWithScores = submissionsInRange.filter((s) =>
      s.due_diligence_score !== null && s.due_diligence_score !== undefined &&
      (matchers.isDDMeetAttended(s.workflow_status) ||
        matchers.isHeld(s.workflow_status) ||
        matchers.isApproved(s.workflow_status) ||
        matchers.isRejected(s.workflow_status)),
    );
    const scoreRanges = [
      { range: '0-25', label: 'Low', color: '#EF4444', min: 0, max: 25 },
      { range: '26-50', label: 'Medium-Low', color: '#F59E0B', min: 26, max: 50 },
      { range: '51-75', label: 'Medium-High', color: '#84CC16', min: 51, max: 75 },
      { range: '76-100', label: 'High', color: '#22C55E', min: 76, max: 100 },
    ];
    const scoreDistribution = scoreRanges.map((r) => {
      const count = submissionsWithScores.filter((s) => s.due_diligence_score >= r.min && s.due_diligence_score <= r.max).length;
      return {
        range: r.range,
        label: r.label,
        color: r.color,
        count,
        percentage: submissionsWithScores.length > 0 ? Math.round((count / submissionsWithScores.length) * 100) : 0,
      };
    });

    // ---- Risk-level distribution ----
    const riskBuckets = new Map();
    const riskColors = { low: '#22C55E', medium: '#F59E0B', high: '#EF4444', critical: '#7F1D1D' };
    submissionsInRange.forEach((s) => {
      if (!s.risk_level) return;
      const key = String(s.risk_level).toLowerCase();
      const cur = riskBuckets.get(key) || { level: key, count: 0 };
      cur.count += 1;
      riskBuckets.set(key, cur);
    });
    const totalRisk = Array.from(riskBuckets.values()).reduce((a, b) => a + b.count, 0);
    const riskLevelDistribution = Array.from(riskBuckets.values())
      .map((r) => ({
        level: r.level,
        label: r.level.charAt(0).toUpperCase() + r.level.slice(1),
        count: r.count,
        color: riskColors[r.level] || '#6B7280',
        percentage: totalRisk > 0 ? Math.round((r.count / totalRisk) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // ---- Period stats ----
    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const outcomesByPeriod = {};
    periods.forEach((periodKey) => {
      if (periodKey === 'all') {
        outcomesByPeriod[periodKey] = {
          scheduled: scheduled.length,
          completed: completed.length,
          completionRate,
          change: null,
          changeDirection: null,
        };
        return;
      }
      const { start, prevStart, prevEnd } = getPeriodBounds(periodKey, now);
      // "scheduled" cohort uses verified-stage transition timestamp; "completed"
      // cohort uses outcome-stage transition timestamp.
      const inSchedWindow = (sub) => {
        const at = getVerifiedAt(sub, matchers);
        return at && at >= start && at <= now;
      };
      const inSchedPrev = (sub) => {
        const at = getVerifiedAt(sub, matchers);
        return at && at >= prevStart && at < prevEnd;
      };
      const inOutcomeWindow = (sub) => {
        const at = getOutcomeAt(sub, matchers);
        return at && at >= start && at <= now;
      };
      const inOutcomePrev = (sub) => {
        const at = getOutcomeAt(sub, matchers);
        return at && at >= prevStart && at < prevEnd;
      };
      const currentScheduled = scheduled.filter(inSchedWindow).length;
      const currentCompleted = completed.filter(inOutcomeWindow).length;
      const previousCompleted = completed.filter(inOutcomePrev).length;
      const currentRate = currentScheduled > 0 ? Math.round((currentCompleted / currentScheduled) * 100) : 0;
      const change = previousCompleted > 0
        ? Math.round(((currentCompleted - previousCompleted) / previousCompleted) * 100)
        : (currentCompleted > 0 ? 100 : 0);
      outcomesByPeriod[periodKey] = {
        scheduled: currentScheduled,
        completed: currentCompleted,
        completionRate: currentRate,
        change: Math.abs(change),
        changeDirection: currentCompleted >= previousCompleted ? 'up' : 'down',
      };
    });

    // Custom range entry uses the active filter window via stage-transition
    // timestamps (verified for scheduled, outcome for completed); no comparison.
    if (filters.period === 'custom') {
      const inSchedCustom = (sub) => {
        const at = getVerifiedAt(sub, matchers);
        return at ? inFilterRange(at) : false;
      };
      const inOutcomeCustom = (sub) => {
        const at = getOutcomeAt(sub, matchers);
        return at ? inFilterRange(at) : false;
      };
      const cs = scheduled.filter(inSchedCustom).length;
      const cc = completed.filter(inOutcomeCustom).length;
      outcomesByPeriod.custom = {
        scheduled: cs,
        completed: cc,
        completionRate: cs > 0 ? Math.round((cc / cs) * 100) : 0,
        change: null,
        changeDirection: null,
      };
    }

    // ---- Monthly throughput (last 6 months: scheduled vs completed) ----
    const monthlyThroughput = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthLabel = monthStart.toLocaleString('default', { month: 'short' });
      // Use stage-transition timestamps so monthly throughput reflects when
      // submissions actually entered Verified / hit an outcome, not when their
      // underlying form was first submitted.
      const scheduledThis = scheduled.filter((s) => {
        const at = getVerifiedAt(s, matchers) || (s._submissionCreatedAt ? new Date(s._submissionCreatedAt) : null);
        return at && at >= monthStart && at <= monthEnd;
      }).length;
      const completedThis = completed.filter((s) => {
        const at = getOutcomeAt(s, matchers);
        return at && at >= monthStart && at <= monthEnd;
      }).length;
      monthlyThroughput.push({ month: monthLabel, scheduled: scheduledThis, completed: completedThis });
    }

    // ---- Real meeting metrics from dd_meeting_request + agent_booking ----
    let meetingMetrics = {
      totalRequests: 0,
      booked: 0,
      pending: 0,
      expired: 0,
      cancelled: 0,
      noShow: 0,
      rescheduled: 0,
      completed: 0,
      averageLeadTimeHours: 0,
      averageBookingTimeHours: 0,
    };

    const filteredFsIds = allSubmissions.map((s) => s.form_submission_id).filter(Boolean);
    // Build a quick lookup so we can pull stage-transition timestamps (Verified
    // and DD Meet Attended / Held) per submission for meeting timing metrics.
    const submissionByFsId = new Map();
    allSubmissions.forEach((s) => {
      if (s.form_submission_id) submissionByFsId.set(s.form_submission_id, s);
    });
    const parseLog = (s) => {
      if (!s) return [];
      if (Array.isArray(s.history_log)) return s.history_log;
      if (!s.history_log) return [];
      try { return JSON.parse(s.history_log); } catch { return []; }
    };
    if (filteredFsIds.length > 0) {
      const { data: meetingRequests } = await supabase
        .from('dd_meeting_request')
        .select('id, status, sent_at, last_resent_at, resend_count, agent_booking_id, created_at, form_submission_id')
        .eq('tenant_id', tenantId)
        .in('form_submission_id', filteredFsIds);
      const filteredRequests = (meetingRequests || []).filter((r) => inFilterRange(r.created_at));
      const bookingIds = filteredRequests.map((r) => r.agent_booking_id).filter(Boolean);
      const bookingMap = new Map();
      if (bookingIds.length > 0) {
        const { data: bookings } = await supabase
          .from('agent_booking')
          .select('id, status, starts_at, cancelled_at, created_at')
          .eq('tenant_id', tenantId)
          .in('id', bookingIds);
        (bookings || []).forEach((b) => bookingMap.set(b.id, b));
      }

      let booked = 0;
      let pending = 0;
      let expired = 0;
      let cancelled = 0;
      let noShow = 0;
      let rescheduled = 0;
      let completedMtg = 0;
      // Stage-transition derived timings (preferred per spec):
      //  - verifiedToBookedHours: from the submission's first transition to
      //    "Verified" (history_log) -> when the booking was created.
      //  - bookedToHeldHours: from booking creation (or its scheduled start)
      //    -> the submission's first transition to a meeting outcome
      //    (DD Meet Attended / Held).
      const verifiedToBookedHours = [];
      const bookedToHeldHours = [];
      // Legacy timings retained for backward compatibility with the existing
      // UI fields. They are not the primary SLA inputs anymore.
      const leadTimes = [];
      const bookingTimes = [];

      filteredRequests.forEach((r) => {
        const booking = r.agent_booking_id ? bookingMap.get(r.agent_booking_id) : null;
        // Canonical cancellation source: prefer booking.status when a booking exists,
        // otherwise fall back to the request's own status. This prevents double counting.
        const isCancelled = booking
          ? booking.status === 'cancelled'
          : r.status === 'cancelled';
        if (isCancelled) cancelled += 1;
        else if (r.status === 'pending') pending += 1;
        else if (r.status === 'booked') booked += 1;
        else if (r.status === 'expired') expired += 1;
        if ((r.resend_count || 0) > 0) rescheduled += 1;

        if (booking) {
          if (booking.status === 'completed') completedMtg += 1;
          if (booking.status === 'confirmed' && booking.starts_at && new Date(booking.starts_at) < now) noShow += 1;
          if (booking.starts_at && booking.created_at) {
            leadTimes.push((new Date(booking.starts_at) - new Date(booking.created_at)) / 3_600_000);
          }
        }
        if (r.sent_at && r.agent_booking_id && booking?.created_at) {
          bookingTimes.push((new Date(booking.created_at) - new Date(r.sent_at)) / 3_600_000);
        }

        // ---- Stage-transition derived metrics ----
        const sub = submissionByFsId.get(r.form_submission_id);
        if (sub && booking?.created_at) {
          const log = parseLog(sub);
          const verifiedAt = findFirstTransitionAt(log, (canonical) =>
            canonical === CANONICAL.verified || matchers.isVerified(canonical)
          );
          if (verifiedAt) {
            const delta = (new Date(booking.created_at) - verifiedAt) / 3_600_000;
            if (delta >= 0) verifiedToBookedHours.push(delta);
          }
          const heldAt = findFirstTransitionAt(log, (canonical) =>
            canonical === CANONICAL.ddMeetAttended ||
            matchers.isDDMeetAttended(canonical) ||
            matchers.isHeld(canonical)
          );
          if (heldAt) {
            const anchor = booking.starts_at ? new Date(booking.starts_at) : new Date(booking.created_at);
            const delta = (heldAt - anchor) / 3_600_000;
            if (delta >= 0) bookedToHeldHours.push(delta);
          }
        }
      });

      const avgHrs = (arr) => (arr.length > 0
        ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
        : 0);

      meetingMetrics = {
        totalRequests: filteredRequests.length,
        booked,
        pending,
        expired,
        cancelled,
        noShow,
        rescheduled,
        completed: completedMtg,
        averageLeadTimeHours: avgHrs(leadTimes),
        averageBookingTimeHours: avgHrs(bookingTimes),
        // Preferred stage-transition timings used for SLA + reporting.
        verifiedToBookedHours: avgHrs(verifiedToBookedHours),
        verifiedToBookedSampleSize: verifiedToBookedHours.length,
        bookedToHeldHours: avgHrs(bookedToHeldHours),
        bookedToHeldSampleSize: bookedToHeldHours.length,
      };
    }

    // ---- SLA breaches: items in 'verified' (waiting to attend a meeting) longer than threshold ----
    // Uses shared history-event helpers so all status-change event types are
    // honoured (status_changed, status_change, workflow_status_change).
    let slaBreachedCount = 0;
    if (slaThresholdDays > 0) {
      // SLA breach = snapshot of items currently sitting in Verified that
      // entered that stage longer ago than the threshold.
      const awaitingMeeting = currentlyVerified;
      slaBreachedCount = awaitingMeeting.filter((s) => {
        const log = Array.isArray(s.history_log)
          ? s.history_log
          : (s.history_log ? (() => { try { return JSON.parse(s.history_log); } catch { return []; } })() : []);
        const enteredAt = findCurrentStageEnteredAt(log, s.workflow_status, s._submissionCreatedAt);
        if (!enteredAt) return false;
        const ageDays = (now - enteredAt) / 86_400_000;
        return ageDays > slaThresholdDays;
      }).length;
    }

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
      riskLevelDistribution,
      schedulingTimeBreakdown,
      meetingMetrics,
      monthlyThroughput,
      slaBreaches: { thresholdDays: slaThresholdDays, breachedCount: slaBreachedCount },
      heldDisambiguation: Object.fromEntries(formIds.map((fid) => [fid, isHeldDecisionForForm(fid) ? 'decision' : 'meeting'])),
      filtersApplied: filters,
      lastUpdated: now.toISOString(),
    });
  } catch (error) {
    console.error('[due-diligence-stats] fatal', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
