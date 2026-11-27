import { createContext, useContext, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useEventFunnelEntry, startEventFunnel } from '@/hooks/useEventFunnelEntry';
import { isGuestOwnedReservation } from '@/lib/eventReservationSelection.mjs';
import { isTicketRoutedByEntry, IN_PAGE_RESERVATION_PARAM } from '@/lib/eventFunnelInPage.mjs';

// This context is supplied only after the journey shell verifies ownership.
// Session IDs are identifiers, never credentials.
const EventReservationContext = createContext(null);
export const EventReservationProvider = EventReservationContext.Provider;
export const useOwnedEventReservation = () => useContext(EventReservationContext);

export function useEventReservation({ eventId, eventKind, viewerKey, selectedTicketIds = [], enabled = true }) {
  const owned = useOwnedEventReservation();
  const journeyOwned = owned && !owned.normalCheckout ? owned : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const entry = useEventFunnelEntry({ eventId, eventKind, viewerKey, enabled: enabled && !journeyOwned });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const draft = useRef(null);
  const busy = useRef(false);
  const request = useRef(null);
  const [normal, setNormal] = useState(null);
  const selectionKey = JSON.stringify([...selectedTicketIds].sort());
  const identity = JSON.stringify([eventId, eventKind, viewerKey]);
  const owner = useRef(identity);
  owner.current = identity;
  // Never reuse a draft after an event or viewer change.
  if (draft.current?.identity !== identity) draft.current = null;
  const validEntry = entry.data?.active === true && (entry.data.routing === 'ticket'
    || typeof entry.data.versionId === 'string' && typeof entry.data.sourceNodeId === 'string');
  // A ticket the server reports as unmapped uses normal checkout immediately.
  const unroutedTicket = validEntry && !isTicketRoutedByEntry(entry.data, selectedTicketIds);
  const normalSelected = unroutedTicket || normal?.identity === identity && normal?.key === selectionKey
    || owned?.normalCheckout && selectionKey === JSON.stringify((owned.offer.selectedTickets || []).map(ticket => ticket.id).sort());
  const active = Boolean(journeyOwned || (enabled && validEntry && !normalSelected));
  const malformed = !journeyOwned && enabled && entry.data && entry.data.active !== false && !validEntry;
  const intercept = Boolean(journeyOwned || (enabled && !normalSelected && (entry.data?.active !== false || entry.isError || entry.isFetching)));
  const journeySessionId = !owned ? searchParams.get(IN_PAGE_RESERVATION_PARAM) || null : null;

  const openJourney = sessionId => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    next.set(IN_PAGE_RESERVATION_PARAM, sessionId);
    return next;
  });
  const closeJourney = () => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    next.delete(IN_PAGE_RESERVATION_PARAM);
    return next;
  });

  async function submit({ tickets, answers }) {
    if (busy.current || !active || (!journeyOwned && (entry.isError || entry.isFetching))) return null;
    busy.current = true;
    setPending(true);
    setError(null);
    const startedFor = identity;
    try {
      if (journeyOwned) return await journeyOwned.select({ tickets, answers });
      if (entry.data.routing === 'ticket' && tickets.length !== 1) throw new Error('Choose one ticket class. You can add other classes at later steps.');
      const fingerprint = JSON.stringify([identity, tickets, answers]);
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      const result = await startEventFunnel({ eventId, eventKind, requestId: request.current.id, tickets, answers });
      if (owner.current !== startedFor) return null;
      if (result.outcome === 'normal' && result.active === false) {
        setNormal({ identity, key: JSON.stringify(tickets.map(ticket => ticket.id).sort()) });
        return result;
      }
      draft.current = { identity, snapshot: result };
      // The event page stays in place; the journey opens over it.
      openJourney(result.session.id);
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
    singleChoice: journeyOwned ? journeyOwned.offer?.selectionMode === 'single' : enabled && entry.data?.routing === 'ticket',
    normalCheckout: normalSelected,
    error: error || entry.error || (malformed ? new Error('Registration information could not be verified. Please retry.') : null),
    loading: !journeyOwned && !normalSelected && enabled && (!entry.data || entry.isFetching) && !entry.isError,
    retry: () => { setNormal(null); return entry.refetch(); }, submit, initialAnswers: owned?.offer?.draft?.answers,
    purchaser: owned?.snapshot?.purchaser || null,
    ownedGuest: isGuestOwnedReservation(owned?.snapshot),
    resume: draft.current?.snapshot ? () => openJourney(draft.current.snapshot.session.id) : null,
    journeySessionId, closeJourney,
    owned: Boolean(owned && !owned.normalCheckout) };
}
