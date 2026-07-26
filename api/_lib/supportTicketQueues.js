/**
 * Pure helpers for support ticket internal notes and inbox-style queues
 * (Task #3100). No React, no DB — shared by the entity API (visibility
 * filtering) and the SupportManagement client page (queue classification).
 */

export const QUEUE_NEEDS_ATTENTION = 'needs_attention';
export const QUEUE_WAITING_ON_MEMBER = 'waiting_on_member';
export const QUEUE_RESOLVED = 'resolved';
export const QUEUE_CLOSED = 'closed';

export const QUEUES = [
  QUEUE_NEEDS_ATTENTION,
  QUEUE_WAITING_ON_MEMBER,
  QUEUE_RESOLVED,
  QUEUE_CLOSED,
];

/** True when a response row is a staff-only internal note. */
export function isInternalNote(row) {
  return !!row && row.is_internal_note === true;
}

/**
 * Server-side visibility boundary: strip internal notes from a list of
 * support_ticket_response rows unless the viewer is support staff.
 * Staff see everything; non-staff never receive internal notes.
 */
export function filterInternalNotesForViewer(rows, isStaff) {
  const list = Array.isArray(rows) ? rows : [];
  if (isStaff) return list;
  return list.filter((r) => !isInternalNote(r));
}

function toTime(dateStr) {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Sort a ticket's responses chronologically (oldest first), tolerating
 * missing created_date values.
 */
function sortResponses(responses) {
  return [...(Array.isArray(responses) ? responses : [])].sort(
    (a, b) => toTime(a?.created_date) - toTime(b?.created_date)
  );
}

/**
 * Classify a ticket into one of the four queues.
 *
 * - resolved / closed tickets go to their status queue regardless of replies.
 * - Otherwise (open / in_progress / anything else active):
 *   - Needs attention: no admin reply yet, OR the last conversation entry
 *     (IGNORING internal notes) is from the member. The opening ticket
 *     description counts as a member entry, so a ticket with no responses
 *     needs attention.
 *   - Waiting on member: staff replied last (ignoring internal notes).
 *
 * @param {object} ticket   support_ticket row (needs `status`)
 * @param {Array}  responses support_ticket_response rows for the ticket
 * @returns {string} one of the QUEUE_* constants
 */
export function classifyTicketQueue(ticket, responses) {
  const status = ticket?.status;
  if (status === 'resolved') return QUEUE_RESOLVED;
  if (status === 'closed') return QUEUE_CLOSED;

  const visible = sortResponses(responses).filter((r) => !isInternalNote(r));
  if (visible.length === 0) return QUEUE_NEEDS_ATTENTION;

  const hasAdminReply = visible.some((r) => r.is_admin_response === true);
  if (!hasAdminReply) return QUEUE_NEEDS_ATTENTION;

  const last = visible[visible.length - 1];
  return last.is_admin_response === true
    ? QUEUE_WAITING_ON_MEMBER
    : QUEUE_NEEDS_ATTENTION;
}

/**
 * Last-activity timestamp (ms) for sorting: the most recent of the ticket's
 * created_date and every response's created_date (internal notes included —
 * this drives the staff-facing sort, and a fresh note is staff activity).
 */
export function getTicketLastActivity(ticket, responses) {
  let latest = toTime(ticket?.created_date);
  for (const r of Array.isArray(responses) ? responses : []) {
    const t = toTime(r?.created_date);
    if (t > latest) latest = t;
  }
  return latest;
}
