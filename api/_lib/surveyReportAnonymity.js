// Task #3332: anonymity resolution for survey reporting.
//
// The version snapshot's survey_settings are AUTHORITATIVE for the responses
// submitted under that version — the live form settings are mutable and must
// never re-identify historical anonymous responses (or hide identified ones).
// For mixed-version result sets the strictest applicable protection wins.

const DEFAULT_THRESHOLD = 3;

// Settings that governed a given submission: its version snapshot's settings
// when present, otherwise the live form settings (defensive fallback only).
export function governingSurveySettings(submission, versionById, form) {
  const v = submission.survey_version_id ? versionById.get(submission.survey_version_id) : null;
  const snap = v && v.survey_settings && typeof v.survey_settings === 'object' ? v.survey_settings : null;
  return snap || form.survey_settings || {};
}

// Is this individual response anonymous? True when either the governing
// settings say so, or the submission itself was stored anonymised.
export function isSubmissionAnonymous(submission, versionById, form) {
  const s = governingSurveySettings(submission, versionById, form);
  const identity = s.response_identity || 'identified';
  return identity !== 'identified' || submission.is_anonymous === true;
}

export function governingThreshold(submission, versionById, form) {
  const s = governingSurveySettings(submission, versionById, form);
  const t = Number(s.anonymity_threshold);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_THRESHOLD;
}

/**
 * Compute the anonymity posture of a FILTERED result set.
 *
 * Returns:
 *   isAnonymous          — any response in the set is anonymous
 *   threshold            — strictest (max) threshold among anonymous responses
 *   anonCount            — number of anonymous responses in the set
 *   suppressAnonymousRows— anonymous rows must be withheld from every
 *                          respondent-level view/export (below threshold)
 *   allSuppressed        — the whole respondent-level view is suppressed
 *                          (every row is anonymous and below threshold)
 *   isAnonymousRow(sub)  — per-row predicate for redaction
 */
export function computeSetAnonymity(submissions, versionById, form) {
  let anonCount = 0;
  let threshold = DEFAULT_THRESHOLD;
  const anonById = new Map();
  for (const sub of submissions) {
    const anon = isSubmissionAnonymous(sub, versionById, form);
    anonById.set(sub.id, anon);
    if (anon) {
      anonCount += 1;
      threshold = Math.max(threshold, governingThreshold(sub, versionById, form));
    }
  }
  const suppressAnonymousRows = anonCount > 0 && anonCount < threshold;
  return {
    isAnonymous: anonCount > 0,
    threshold,
    anonCount,
    suppressAnonymousRows,
    allSuppressed: suppressAnonymousRows && anonCount === submissions.length,
    isAnonymousRow: (sub) => anonById.get(sub.id) === true,
  };
}
