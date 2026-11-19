// Client contract for task #4230. The server owns award/grant correctness;
// these helpers only identify potentially affected references and invoke its
// dedicated reconciliation endpoint.
export function speakerIdsFromReferences({ eventSpeakerIds = [], agendaLines = [], sessions = [] } = {}) {
  const ids = new Set(eventSpeakerIds || []);
  [...(agendaLines || []), ...(sessions || [])].forEach((row) => {
    (row?.speaker_ids || []).forEach((id) => ids.add(id));
  });
  return [...ids].filter(Boolean);
}

export function finalRemovedSpeakerIds(before, after) {
  const beforeIds = speakerIdsFromReferences(before);
  const afterIds = new Set(speakerIdsFromReferences(after));
  return beforeIds.filter((id) => !afterIds.has(id));
}

export function removedAgendaSpeakerIds(before = [], after = []) {
  const remaining = new Map(after.filter(row => row.id).map(row => [row.id, new Set(row.speaker_ids || [])]));
  return [...new Set(before.flatMap(row => (row.speaker_ids || [])
    .filter(id => !remaining.get(row.id)?.has(id))))];
}

export function removedAgendaSpeakerGrants(grants = [], after = []) {
  return grants.filter(grant => grant.agenda_item_id && !after.some(row =>
    row.id === grant.agenda_item_id && (row.speaker_ids || []).includes(grant.speaker_id)));
}

export function hasRelevantAwardedBadge(config, grants = [], removedSpeakerIds = []) {
  const removed = new Set(removedSpeakerIds || []);
  if (removed.size === 0) return false;
  // The persisted grant is the historical authority. The event config may have
  // been disabled or changed to a different badge after this award was made.
  return (grants || []).some((grant) =>
    removed.has(grant?.speaker_id)
    && Boolean(grant?.member_badge_id)
    && grant?.member_badge_active === true
  );
}

export async function reconcileSpeakerAwards({ action, eventType, eventId, speakerIds = [], revokeBadge } = {}) {
  const response = await fetch("/api/admin/speaker-awards/reconcile", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action, // "reconcile" | "remove"
      event_type: eventType,
      event_id: eventId,
      training_scope_version: 1,
      speaker_ids: speakerIds,
      ...(action === "remove" ? { revoke_badge: revokeBadge === true } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Speaker award reconciliation failed");
  }
  const body = await response.json();
  if (body.results?.some(result => result.error)) throw new Error('Some agenda speaker awards failed; processing will retry.');
  return body;
}