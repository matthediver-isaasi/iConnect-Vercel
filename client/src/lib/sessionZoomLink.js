/**
 * Persisting a "Link Existing" Zoom selection for an ALREADY-SAVED complex
 * event session (Task #3414).
 *
 * Background: the complex-event save loop deliberately strips Zoom resource
 * columns from the bypass PATCH for existing sessions (task-692) — Zoom
 * changes for saved sessions must go through the session change-zoom API so
 * confirmed registrants are cancelled/re-registered safely. That meant a new
 * dropdown selection in ZoomSessionConfig was silently dropped for saved
 * sessions. These helpers route the selection through change-zoom instead.
 *
 * Conventions (see api/complex-event-sessions/[id]/change-zoom.js):
 * - `session.zoom_meeting_id` / `zoom_webinar_id` and the picker's
 *   `link_existing_zoom_id` hold the EXTERNAL numeric Zoom ID (string).
 * - The change-zoom endpoint takes LOCAL zoom_meeting/zoom_webinar table PKs,
 *   so the external ID must be resolved against /api/zoom/meetings|webinars.
 */

/**
 * Decide whether a saved session has a pending Link Existing change that the
 * bypass PATCH cannot persist. Returns null when nothing needs doing.
 */
export function getPendingSessionZoomChange(session) {
  if (!session?.id) return null; // new sessions persist via the POST payload
  if (!session.is_online) return null;
  if (session.zoom_link_mode !== 'link_existing') return null;
  const desired = String(session.link_existing_zoom_id || '').trim();
  if (!desired) return null;
  const currentExternal = String(session.zoom_meeting_id || session.zoom_webinar_id || '');
  if (desired === currentExternal) return null;
  const type = session.zoom_type === 'webinar' ? 'webinar' : 'meeting';
  return {
    type,
    desiredExternalId: desired,
    hadPreviousZoom: Boolean(currentExternal),
  };
}

/**
 * Persist a pending Link Existing selection for a saved session via the
 * change-zoom API. Resolves the external Zoom ID to the local zoom_* row PK,
 * then POSTs `${endpointBase}/change-zoom`.
 *
 * Returns { status: 'no_change' | 'linked' | 'not_found' }.
 * - 'not_found': the external ID isn't in the tenant's local Zoom list (e.g.
 *   a legacy manually-typed ID) — nothing is changed, existing data is kept.
 * Throws when the change-zoom call itself fails.
 */
export async function persistSessionZoomLink(session, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const pending = getPendingSessionZoomChange(session);
  if (!pending) return { status: 'no_change' };

  const listUrl = pending.type === 'webinar' ? '/api/zoom/webinars' : '/api/zoom/meetings';
  const listResp = await doFetch(listUrl, { credentials: 'include' });
  if (!listResp.ok) {
    throw new Error(`Failed to load Zoom ${pending.type} list to link session`);
  }
  const rows = await listResp.json();
  const externalCol = pending.type === 'webinar' ? 'zoom_webinar_id' : 'zoom_meeting_id';
  const match = (Array.isArray(rows) ? rows : []).find(
    (r) => String(r?.[externalCol] || '') === pending.desiredExternalId
  );
  if (!match) return { status: 'not_found' };

  const body = {
    zoom_webinar_id: pending.type === 'webinar' ? match.id : null,
    zoom_meeting_id: pending.type === 'meeting' ? match.id : null,
    cancelOld: pending.hadPreviousZoom,
    registerNew: true,
    // Bulk event save should not silently mass-email attendees; admins can
    // use the explicit Change Zoom dialog when they want resends.
    resendConfirmations: false,
  };
  const resp = await doFetch(`/api/complex-event-sessions/${session.id}/change-zoom`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Failed to link Zoom ${pending.type} to session`);
  }
  return { status: 'linked' };
}
