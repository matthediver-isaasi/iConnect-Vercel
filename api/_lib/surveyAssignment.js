// Task #3331: shared helpers for event survey assignments.
// Pure logic (window/status evaluation, token generation) lives here so the
// public serve endpoint, the submission endpoint and tests share ONE source
// of truth for when an assignment accepts responses.
import { randomBytes } from 'node:crypto';

/**
 * Generate an unguessable URL token for an assignment.
 * 24 random bytes -> 32-char base64url string.
 */
export function generateAssignmentToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * Evaluate an assignment's response window.
 * Returns one of: 'open' | 'not_open_yet' | 'closed' | 'archived'.
 *
 * - status !== 'active'            -> 'archived'
 * - opens_at in the future         -> 'not_open_yet'
 * - closes_at in the past          -> 'closed'
 * - otherwise                      -> 'open'
 *
 * Null/invalid opens_at/closes_at mean "no bound on that side".
 *
 * @param {object} assignment - row with status/opens_at/closes_at
 * @param {Date} [now]
 */
export function assignmentWindowState(assignment, now = new Date()) {
  if (!assignment || assignment.status !== 'active') return 'archived';
  const ts = now.getTime();
  const opens = parseTime(assignment.opens_at);
  const closes = parseTime(assignment.closes_at);
  if (opens !== null && ts < opens) return 'not_open_yet';
  if (closes !== null && ts > closes) return 'closed';
  return 'open';
}

function parseTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * True when the assignment currently accepts responses.
 */
export function isAssignmentOpen(assignment, now = new Date()) {
  return assignmentWindowState(assignment, now) === 'open';
}

/**
 * Submission gate for an assignment-linked survey response. Returns null when
 * the submission may proceed, or `{ status, error, code }` describing the
 * rejection. Pure — used by the submission endpoint and unit tests.
 *
 * @param {object} assignment - resolved event_survey_assignment row
 * @param {{ hasTenantSession?: boolean, now?: Date }} [opts]
 */
export function assignmentSubmissionRejection(assignment, { hasTenantSession = false, now = new Date() } = {}) {
  const state = assignmentWindowState(assignment, now);
  if (state !== 'open') {
    return {
      status: 403,
      error: assignmentClosedMessage(state) || 'This survey is not accepting responses',
      code: 'ASSIGNMENT_CLOSED',
    };
  }
  if (assignment.access_mode === 'authenticated' && !hasTenantSession) {
    return { status: 403, error: 'This survey requires authentication', code: 'ASSIGNMENT_AUTH_REQUIRED' };
  }
  return null;
}

/**
 * Canonical input for the survey respondent dedupe HMAC.
 *
 * Dedupe is scoped per RESPONSE CONTEXT: per assignment for event-linked
 * responses, per form for direct (slug) responses. The two contexts never
 * coexist — once a survey has any ACTIVE assignment, the direct path is
 * blocked entirely (see requiresAssignmentLink) — so a respondent can never
 * bypass one-submission-per-respondent by switching URLs.
 */
export function respondentKeyInput(tenantId, formId, assignmentId, respondentIdentity) {
  return `${tenantId}|${formId}|${assignmentId ? `${assignmentId}|` : ''}${respondentIdentity}`;
}

/**
 * Direct-access policy: a published survey with one or more ACTIVE event
 * assignments only accepts responses through an assignment link, so the
 * event is ALWAYS server-resolved and dedupe scopes can't be mixed.
 * Surveys with no active assignments behave exactly as before.
 */
export function requiresAssignmentLink(activeAssignmentCount) {
  return Number(activeAssignmentCount) > 0;
}

/**
 * Human-readable rejection message per window state (null when open).
 */
export function assignmentClosedMessage(state) {
  switch (state) {
    case 'not_open_yet':
      return 'This survey is not open yet.';
    case 'closed':
      return 'This survey is no longer accepting responses.';
    case 'archived':
      return 'This survey link is no longer available.';
    default:
      return null;
  }
}
