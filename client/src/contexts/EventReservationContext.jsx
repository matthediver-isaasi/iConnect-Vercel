import { createContext, useContext, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEventFunnelEntry, startEventFunnel, changeEventFunnel } from '@/hooks/useEventFunnelEntry';
import { isGuestOwnedReservation } from '@/lib/eventReservationSelection.mjs';

// This context is supplied only after the journey shell verifies ownership.
// Session IDs are identifiers, never credentials.
const EventReservationContext = createContext(null);
export const EventReservationProvider = EventReservationContext.Provider;
export const useOwnedEventReservation = () => useContext(EventReservationContext);

export function useEventReservation({ eventId, eventKind, viewerKey, enabled = true }) {
  const owned = useOwnedEventReservation();
  const navigate = useNavigate();
  const entry = useEventFunnelEntry({ eventId, eventKind, viewerKey, enabled: enabled && !owned });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const draft = useRef(null);
  const busy = useRef(false);
  const identity = JSON.stringify([eventId, eventKind, viewerKey]);
  const owner = useRef(identity);
  owner.current = identity;
  // Never reuse a draft after an event or viewer change.
  if (draft.current?.identity !== identity) draft.current = null;
  const validEntry = entry.data?.active === true && typeof entry.data.versionId === 'string'
    && typeof entry.data.sourceNodeId === 'string';
  const active = Boolean(owned || (enabled && validEntry));
  const malformed = !owned && enabled && entry.data && entry.data.active !== false && !validEntry;
  const intercept = Boolean(owned || (enabled && (entry.data?.active !== false || entry.isError || entry.isFetching)));

  async function submit({ tickets, answers }) {
    if (busy.current || !active || (!owned && (entry.isError || entry.isFetching))) return null;
    busy.current = true;
    setPending(true);
    setError(null);
    const startedFor = identity;
    try {
      if (owned) return await owned.select({ tickets, answers });
      let snapshot = draft.current?.snapshot;
      if (!snapshot) {
        snapshot = await startEventFunnel({ eventId, eventKind });
        if (owner.current !== startedFor) return null;
        draft.current = { identity, snapshot };
      }
      const result = await changeEventFunnel(snapshot.session.id, {
        type: 'select', nodeId: entry.data.sourceNodeId,
        expectedRevision: snapshot.session.revision, tickets, answers,
      });
      if (owner.current !== startedFor) return null;
      draft.current = { identity, snapshot: result };
      navigate(`/EventReservation?sessionId=${encodeURIComponent(result.session.id)}`);
      return result;
    } catch (cause) {
      if (owner.current === startedFor) setError(cause);
      return null;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { active, intercept, pending: pending || owned?.pending,
    error: error || entry.error || (malformed ? new Error('Registration information could not be verified. Please retry.') : null),
    loading: !owned && enabled && (!entry.data || entry.isFetching) && !entry.isError,
    retry: () => entry.refetch(), submit, initialAnswers: owned?.offer?.draft?.answers,
    purchaser: owned?.snapshot?.purchaser || null,
    ownedGuest: isGuestOwnedReservation(owned?.snapshot),
    resume: draft.current?.snapshot ? () => navigate(`/EventReservation?sessionId=${encodeURIComponent(draft.current.snapshot.session.id)}`) : null,
    owned: Boolean(owned) };
}
