// Shared helpers for the Due Diligence Reports endpoints.
// All correctness-critical logic (canonicalization, period bounds, history-log
// timestamps, Held disambiguation) lives here so the four endpoints stay
// consistent.

export const canonicalizeKey = (str) => {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[-_\s]+/g, ' ')
    .replace(/\s+/g, ' ');
};

export const CANONICAL = {
  new: canonicalizeKey('New'),
  inReview: canonicalizeKey('In Review'),
  verified: canonicalizeKey('Verified'),
  ddMeetAttended: canonicalizeKey('DD Meet Attended'),
  held: canonicalizeKey('Held'),
  approved: canonicalizeKey('Approved'),
  rejected: canonicalizeKey('Rejected'),
  incomplete: canonicalizeKey('Incomplete'),
};

const HISTORY_STATUS_EVENTS = new Set(['status_changed', 'status_change', 'workflow_status_change']);

export const isStatusHistoryEvent = (entry) => {
  if (!entry) return false;
  return HISTORY_STATUS_EVENTS.has(entry.event_type);
};

export const getStatusFromHistory = (entry, side /* 'previous' | 'new' */) => {
  if (!entry?.details) return null;
  if (side === 'previous') {
    return entry.details.previous_status ?? entry.details.old_status ?? null;
  }
  return entry.details.new_status ?? null;
};

export const getStatusActor = (entry) => {
  if (!entry) return null;
  return (
    entry.user_email ||
    entry.actor_email ||
    entry.details?.user_email ||
    entry.details?.actor_email ||
    entry.details?.changed_by ||
    null
  );
};

// Sort history log oldest -> newest
export const sortedHistory = (historyLog) =>
  Array.isArray(historyLog)
    ? [...historyLog]
        .filter(isStatusHistoryEvent)
        .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
    : [];

/**
 * Find the timestamp at which the submission first transitioned to a status
 * matching `predicate(canonicalizedNewStatus, entry)`. Falls back to null.
 */
export const findFirstTransitionAt = (historyLog, predicate) => {
  for (const entry of sortedHistory(historyLog)) {
    const newCanonical = canonicalizeKey(getStatusFromHistory(entry, 'new'));
    if (predicate(newCanonical, entry)) {
      return entry.timestamp ? new Date(entry.timestamp) : null;
    }
  }
  return null;
};

/**
 * Walk the history log and return the timestamp where the submission entered
 * its CURRENT workflow_status. Used for "outstanding-by-age" calculations so we
 * compare against the time the submission entered that stage rather than the
 * generic updated_at column.
 */
export const findCurrentStageEnteredAt = (historyLog, currentStatus, fallback) => {
  const target = canonicalizeKey(currentStatus);
  if (!target) return fallback ? new Date(fallback) : null;
  let lastMatch = null;
  for (const entry of sortedHistory(historyLog)) {
    const newCanonical = canonicalizeKey(getStatusFromHistory(entry, 'new'));
    if (newCanonical === target) {
      lastMatch = entry.timestamp ? new Date(entry.timestamp) : null;
    }
  }
  return lastMatch || (fallback ? new Date(fallback) : null);
};

/**
 * If the input is a YYYY-MM-DD (date-only) string, treat the end of the
 * range as the end of that local day. ISO strings with a time component are
 * left untouched.
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const parseRangeStart = (value) => {
  if (!value) return null;
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return new Date(value);
};
export const parseRangeEnd = (value, fallback = null) => {
  if (!value) return fallback ? new Date(fallback) : null;
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) {
    const d = new Date(value);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  return new Date(value);
};

/**
 * Period helpers. `period` may be week|month|quarter|year|all|custom.
 * For `custom` callers must supply `startDate`/`endDate` ISO strings.
 */
export const getPeriodBounds = (period, now = new Date(), opts = {}) => {
  const end = opts.endDate ? parseRangeEnd(opts.endDate, now) : new Date(now);
  const start = new Date(end);
  const prevEnd = new Date(end);
  const prevStart = new Date(end);

  switch (period) {
    case 'week':
      start.setDate(end.getDate() - 7);
      prevEnd.setDate(end.getDate() - 7);
      prevStart.setDate(end.getDate() - 14);
      break;
    case 'month':
      start.setMonth(end.getMonth() - 1);
      prevEnd.setMonth(end.getMonth() - 1);
      prevStart.setMonth(end.getMonth() - 2);
      break;
    case 'quarter':
      start.setMonth(end.getMonth() - 3);
      prevEnd.setMonth(end.getMonth() - 3);
      prevStart.setMonth(end.getMonth() - 6);
      break;
    case 'year':
      start.setFullYear(end.getFullYear() - 1);
      prevEnd.setFullYear(end.getFullYear() - 1);
      prevStart.setFullYear(end.getFullYear() - 2);
      break;
    case 'custom': {
      const customStart = opts.startDate ? parseRangeStart(opts.startDate) : null;
      if (!customStart) return { start: null, end, prevStart: null, prevEnd: null };
      const span = end.getTime() - customStart.getTime();
      return {
        start: customStart,
        end,
        prevStart: new Date(customStart.getTime() - span),
        prevEnd: customStart,
      };
    }
    case 'all':
    default:
      return { start: null, end, prevStart: null, prevEnd: null };
  }

  return { start, end, prevStart, prevEnd };
};

export const parseFilters = (query) => {
  const formId = query.formId && query.formId !== 'all' ? query.formId : null;
  const period = query.period || null;
  const startDate = query.startDate || null;
  const endDate = query.endDate || null;
  return { formId, period, startDate, endDate };
};

/**
 * Produce a `withinRange(date)` predicate for the active filter window.
 * - If no period AND no startDate -> always true (all-time)
 * - If period === 'custom' -> use startDate/endDate
 * - Otherwise use period bounds
 */
export const buildRangePredicate = ({ period, startDate, endDate }, now = new Date()) => {
  if (!period && !startDate && !endDate) {
    return () => true;
  }
  if (period === 'all') {
    return () => true;
  }
  let start = null;
  let end = endDate ? parseRangeEnd(endDate, now) : new Date(now);
  if (period === 'custom') {
    start = startDate ? parseRangeStart(startDate) : null;
  } else if (period) {
    const bounds = getPeriodBounds(period, now);
    start = bounds.start;
    end = bounds.end;
  } else if (startDate) {
    start = parseRangeStart(startDate);
  }
  return (date) => {
    if (!date) return false;
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  };
};

/**
 * Build per-form lookup maps for canonical stage matching.
 * Returns: { stageOrderByForm, isHeldDecisionForForm, isStatus, allStages,
 *            stageMaps: { verified, held, approved, rejected, ddMeetAttended,
 *            inReview, new, incomplete } }
 *
 * Held disambiguation:
 * If a form's workflow_stages places "Held" BEFORE "Approved"/"Rejected",
 * Held is treated as a *meeting outcome* (not a final decision). If Held
 * appears AFTER any Approved/Rejected stage, it is treated as a "decision
 * pending" hold. Use isHeldDecisionForForm(formId) to decide which bucket.
 */
export const buildStageMaps = (ddConfigs) => {
  const stageMaps = {
    verified: new Set(),
    held: new Set(),
    approved: new Set(),
    rejected: new Set(),
    ddMeetAttended: new Set(),
    inReview: new Set(),
    new: new Set(),
    incomplete: new Set(),
  };
  const stageOrderByForm = {};
  const heldDecisionByForm = {};
  const stageLabelByCanonical = new Map();

  ddConfigs.forEach((config) => {
    const stages = config.workflow_stages || [];
    const orderMap = {};
    let firstHeldOrder = Infinity;
    let firstApprovedRejectedOrder = Infinity;

    stages.forEach((stage, idx) => {
      const canonical = canonicalizeKey(stage.label);
      const order = stage.order ?? idx;
      orderMap[canonical] = order;
      stageLabelByCanonical.set(canonical, stage.label);

      if (canonical === CANONICAL.verified) stageMaps.verified.add(stage.id);
      if (canonical === CANONICAL.held) {
        stageMaps.held.add(stage.id);
        firstHeldOrder = Math.min(firstHeldOrder, order);
      }
      if (canonical === CANONICAL.approved) {
        stageMaps.approved.add(stage.id);
        firstApprovedRejectedOrder = Math.min(firstApprovedRejectedOrder, order);
      }
      if (canonical === CANONICAL.rejected) {
        stageMaps.rejected.add(stage.id);
        firstApprovedRejectedOrder = Math.min(firstApprovedRejectedOrder, order);
      }
      if (canonical === CANONICAL.ddMeetAttended) stageMaps.ddMeetAttended.add(stage.id);
      if (canonical === CANONICAL.inReview) stageMaps.inReview.add(stage.id);
      if (canonical === CANONICAL.new) stageMaps.new.add(stage.id);
      if (canonical === CANONICAL.incomplete) stageMaps.incomplete.add(stage.id);
    });

    stageOrderByForm[config.form_id] = orderMap;
    // If Held comes BEFORE any Approved/Rejected stage, it is a meeting
    // outcome (not a decision). When Held has no neighbours we default to
    // treating it as a decision so the Decisions card still displays it.
    heldDecisionByForm[config.form_id] = !(firstHeldOrder < firstApprovedRejectedOrder);
  });

  return {
    stageMaps,
    stageOrderByForm,
    heldDecisionByForm,
    isHeldDecisionForForm: (formId) =>
      formId in heldDecisionByForm ? heldDecisionByForm[formId] : true,
    stageLabelByCanonical,
  };
};

/**
 * Generic status matcher. Tries (1) the per-canonical stageId set and
 * (2) the canonicalized label, so that submissions whose workflow_status is
 * stored as a stage UUID OR a label like "Verified" both match.
 */
export const makeStatusMatcher = (canonical, stageIdSet) => (status) => {
  if (!status) return false;
  if (canonicalizeKey(status) === canonical) return true;
  return stageIdSet?.has(status);
};

/**
 * Convenience wrapper used when iterating large submission lists.
 */
export const mkMatchers = (stageMaps) => ({
  isVerified: makeStatusMatcher(CANONICAL.verified, stageMaps.verified),
  isHeld: makeStatusMatcher(CANONICAL.held, stageMaps.held),
  isApproved: makeStatusMatcher(CANONICAL.approved, stageMaps.approved),
  isRejected: makeStatusMatcher(CANONICAL.rejected, stageMaps.rejected),
  isDDMeetAttended: makeStatusMatcher(CANONICAL.ddMeetAttended, stageMaps.ddMeetAttended),
  isInReview: makeStatusMatcher(CANONICAL.inReview, stageMaps.inReview),
  isNew: makeStatusMatcher(CANONICAL.new, stageMaps.new),
});

/**
 * Compute the timestamp the submission first reached the "verified" stage.
 * Falls back to `created_at` if no transition is logged.
 */
export const getVerifiedAt = (sub, matchers) => {
  const t = findFirstTransitionAt(sub.history_log, (canonical) =>
    canonical === CANONICAL.verified || matchers.isVerified(canonical)
  );
  return t || null;
};

/**
 * Compute the timestamp the submission first reached an "outcome" stage
 * (Held / Approved / Rejected / DD Meet Attended). Used as the "decision time"
 * for averaging.
 */
export const getOutcomeAt = (sub, matchers) => {
  const t = findFirstTransitionAt(sub.history_log, (canonical) =>
    matchers.isHeld(canonical) ||
    matchers.isApproved(canonical) ||
    matchers.isRejected(canonical) ||
    matchers.isDDMeetAttended(canonical)
  );
  return t || (sub.updated_at ? new Date(sub.updated_at) : null);
};

/**
 * Find the timestamp the submission first reached a *final decision* stage
 * (Approved / Rejected, plus Held when it is a decision-pending hold).
 */
export const getDecisionAt = (sub, matchers, isHeldDecisionForForm, formId) => {
  const heldCountsAsDecision = isHeldDecisionForForm(formId);
  return findFirstTransitionAt(sub.history_log, (canonical) =>
    matchers.isApproved(canonical) ||
    matchers.isRejected(canonical) ||
    (heldCountsAsDecision && matchers.isHeld(canonical))
  );
};

/**
 * Find the actor who made the first transition to a given outcome (used for
 * reviewer/decision-maker tables).
 */
export const findActorForFirstTransition = (historyLog, predicate) => {
  for (const entry of sortedHistory(historyLog)) {
    const newCanonical = canonicalizeKey(getStatusFromHistory(entry, 'new'));
    if (predicate(newCanonical, entry)) {
      return getStatusActor(entry);
    }
  }
  return null;
};

/**
 * CSV helper.
 */
export const toCsv = (rows, headers) => {
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = headers.map((h) => escape(h.label)).join(',');
  const body = rows
    .map((row) => headers.map((h) => escape(typeof h.value === 'function' ? h.value(row) : row[h.key])).join(','))
    .join('\n');
  return `${head}\n${body}`;
};

/**
 * Format a number of milliseconds to "Xd Yh" or "Yh".
 */
export const formatDuration = (ms) => {
  if (!ms || ms <= 0) return '0h';
  const h = ms / 3_600_000;
  if (h < 24) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
};
