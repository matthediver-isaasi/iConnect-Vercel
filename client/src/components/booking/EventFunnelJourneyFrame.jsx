import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Clock3, ShieldCheck } from 'lucide-react';
import { useEventFunnelJourney } from '../../lib/useEventFunnelJourney';
import { Button } from '../ui/button';
import './EventFunnelJourneyFrame.css';

const monotonicNow = () => performance.now();
const remainingAt = clock => clock ? Math.max(0, clock.remaining - (monotonicNow() - clock.startedAt)) : null;
const deadlineClock = snapshot => {
  const deadline = Date.parse(snapshot?.session?.expires_at);
  const server = Date.parse(snapshot?.serverNow);
  return Number.isFinite(deadline) && Number.isFinite(server)
    ? { deadline, remaining: Math.max(0, deadline - server), startedAt: monotonicNow() }
    : null;
};
const frozenCopy = {
  payable: ['Reservation ready for the payment step', 'Your selections are locked while payment is prepared. This is not a booking confirmation.'],
  confirming: ['Your booking is being checked', 'Selections are locked while confirmation is in progress. Do not submit another booking.'],
  payment_uncertain: ['Payment status needs checking', 'We cannot yet verify the payment outcome. Do not pay again. Your saved selections are shown below for reference.'],
  confirmed: ['Your booking is confirmed', 'Selections are read-only here. Refer to your booking confirmation for the final details.'],
  cancelled: ['This reservation has been cancelled', 'The saved information is shown for reference only. Places are not being held by this reservation.'],
};
function removalExplanation(reason) {
  if (reason === 'You chose to continue with the source event only.' || reason === 'source_only') {
    return 'An optional selection was removed because you chose to continue with your original event only.';
  }
  if (reason === 'You removed this optional selection.' || reason === 'skipped') {
    return 'An optional selection was removed because you skipped that offer.';
  }
  return 'An optional selection was removed because it is no longer available with your current choices. An extra that depends on it may also have been removed.';
}

/**
 * Isolated reservation shell: no checkout activation, routing or event forms.
 * Keying the owner prevents even one render of another session's saved data.
 * Child mutation wrappers resolve to a snapshot on success, or null on failure.
 * renderBody optionally separates recovery UI from disabled event editing;
 * callers wrap ordinary inputs with the supplied renderEventFields function.
 */
export default function EventFunnelJourneyFrame({
  sessionId, enabled = true, sourceLabel = 'your original event', onBack, children, renderBody,
}) {
  return <OwnedJourneyFrame key={sessionId} sessionId={sessionId} enabled={enabled}
    sourceLabel={sourceLabel} onBack={onBack} renderBody={renderBody}>{children}</OwnedJourneyFrame>;
}

function OwnedJourneyFrame({ sessionId, enabled, sourceLabel, onBack, children, renderBody }) {
  const { snapshot: received, error, loading, pending, refresh: read, change: write, saveAnswers: writeAnswers } =
    useEventFunnelJourney({ sessionId, enabled });
  const snapshot = enabled && received?.session?.id === String(sessionId).toLowerCase() ? received : null;
  const headingId = useId();
  const clock = useRef(null);
  const synced = useRef(null);
  const expiredLatch = useRef(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const [, tick] = useState(0);
  const [localError, setLocalError] = useState(null);

  // Revision updates may shorten a hold, never start it over or extend it.
  // Only a successful explicit rereserve below can replace an existing clock.
  if (snapshot && synced.current !== snapshot) {
    synced.current = snapshot;
    const incoming = deadlineClock(snapshot);
    if (!clock.current && !expiredLatch.current && incoming) clock.current = incoming;
    else if (clock.current && incoming) {
      const remaining = Math.min(remainingAt(clock.current), incoming.remaining,
        Math.max(0, clock.current.deadline - Date.parse(snapshot.serverNow)));
      clock.current = { ...clock.current, remaining, startedAt: monotonicNow() };
    }
    if (snapshot.session.state === 'expired') expiredLatch.current = true;
  }
  const remaining = remainingAt(clock.current);
  if (remaining === 0) expiredLatch.current = true;
  const state = snapshot?.session?.state;
  const editableState = state === 'draft' || state === 'held';
  const mutableState = editableState || state === 'expired';
  const expired = Boolean(snapshot && (state === 'expired' || (editableState && expiredLatch.current)));
  const unverifiableHold = state === 'held' && !clock.current;
  // Expiry blocks inventory additions, not answer edits or optional removals.
  const frozen = !snapshot || !mutableState || unverifiableHold;
  const busy = pending || lock.current;
  const readBlocked = !enabled || busy || loading;
  const blocked = readBlocked || state === 'payment_uncertain';
  const reportedDeadline = Date.parse(snapshot?.session?.expires_at);
  const reopenRequired = expired && state === 'held' && clock.current
    && reportedDeadline > clock.current.deadline && reportedDeadline > Date.parse(snapshot.serverNow);
  const source = snapshot?.graph?.nodes?.find(node => node.type === 'source');
  const sourceHolds = snapshot?.holds?.filter(hold => hold.node_id === source?.id) || [];
  const hasSource = sourceHolds.length > 0;
  const current = snapshot?.graph?.nodes?.find(node => node.id === snapshot.route?.currentNodeId);
  const optionalNode = current && ['event', 'addon'].includes(current.type);
  const checkoutNow = snapshot?.session?.journey?.checkoutNow === true;
  const held = state === 'held' && !expired && !unverifiableHold && hasSource;
  const timerVisible = Boolean(clock.current && !frozenCopy[state]);
  const seconds = Math.ceil((remaining || 0) / 1000);
  const timeLabel = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const announcement = reopenRequired ? 'Reservation timing has changed. Reopen the reservation to verify its current hold. This view has not extended the timer.'
    : expired ? 'Reservation time has ended. Availability and prices must be checked again.'
    : !timerVisible ? ''
    : seconds <= 60 ? 'One minute or less remains on your reservation.'
      : seconds <= 300 ? 'Five minutes or less remain on your reservation.' : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  async function safely(task, readOnly = false) {
    if (lock.current || pending || !enabled || (state === 'payment_uncertain' && !readOnly)) return null;
    lock.current = true;
    setLocalError(null);
    try {
      return await task();
    } catch {
      if (mounted.current) setLocalError('We could not verify that request. Your last saved information is still shown. Check the reservation before trying a change again.');
      return null;
    } finally {
      lock.current = false;
      if (mounted.current) tick(value => value + 1);
    }
  }
  async function change(command) {
    if (blocked || !snapshot) return null;
    const isRereserve = command?.type === 'rereserve';
    const isNonStockChange = ['source_only', 'skip', 'resume_offers'].includes(command?.type);
    if (isRereserve ? !expired || !mutableState || reopenRequired
      : frozen || (expired && !isNonStockChange)) return null;
    return safely(async () => {
      const result = await write(command);
      if (isRereserve && result && mounted.current) {
        const next = deadlineClock(result);
        // Do not infer a new reservation from a local click or a failed response.
        if (result.session.state === 'held' && next?.remaining > 0) {
          clock.current = next;
          expiredLatch.current = false;
          synced.current = result;
        }
      }
      return result;
    });
  }
  const saveAnswers = (nodeId, answers) => frozen || blocked ? Promise.resolve(null)
    : safely(() => writeAnswers(nodeId, answers));
  const refresh = () => readBlocked ? Promise.resolve(null) : safely(read, true);
  // Checkout shares this frame's clock and conservative expiry/reopen latch.
  // The callback also checks monotonic time at the actual request boundary,
  // including when an awaited quote crosses the deadline between timer ticks.
  const checkoutAllowed = Boolean(held && !blocked && !reopenRequired && snapshot.route.atCheckout);
  const checkoutEligibility = {
    allowed: checkoutAllowed,
    reason: reopenRequired
      ? 'Reopen the reservation to verify its timing before reviewing or submitting a quote.'
      : expired
        ? 'Reservation time has ended. Check availability and prices again before reviewing or submitting a quote.'
        : !held
          ? 'A verified, current timed hold is required before reviewing or submitting a quote.'
          : blocked ? 'Wait for the reservation check to finish before continuing.'
            : !snapshot.route.atCheckout ? 'Return to the current checkout step before continuing.' : '',
    canSubmitNow: () => checkoutAllowed && !lock.current && !expiredLatch.current
      && remainingAt(clock.current) > 0,
  };
  const renderEventFields = content => <fieldset className="event-journey-frame__fields" disabled={frozen || blocked}
    aria-label={frozen ? 'Saved event details, read only' : 'Event details'}>
    <div inert={frozen || blocked ? '' : undefined}>{content}</div>
  </fieldset>;
  const journey = { snapshot, change, saveAnswers, pending, refresh, checkoutEligibility, renderEventFields };

  let title = held ? `Your places for ${sourceLabel} are held` : 'Your saved reservation';
  let description = held
    ? 'Optional extras are your choice. Skipping an offer keeps your original event selection. Nothing here confirms a booking.'
    : 'Choose your event details below. Places are only held once your timed reservation is confirmed.';
  if (!enabled) {
    title = 'Reservation not active';
    description = 'No reservation is currently active. No places have been reserved.';
  } else if (!snapshot) {
    title = error || localError ? 'We could not load your reservation' : 'Checking your reservation';
    description = 'We will show your saved event information once we can verify this reservation.';
  } else if (frozenCopy[state]) {
    [title, description] = frozenCopy[state];
  } else if (reopenRequired) {
    title = 'Your reservation timing has changed';
    description = 'The server reports a newer deadline, possibly after a reservation check in another tab. This view has not restored a hold or extended its timer. Reopen the reservation to verify the current hold before adding tickets or checking availability again.';
  } else if (expired) {
    title = 'Your reservation time has ended';
    description = 'Your information is retained, but no places are held until an explicit availability and price check succeeds. You can still save attendee answers, skip offers, or remove optional selections. These changes do not reserve places or restart the timer.';
  } else if (unverifiableHold || !['draft', 'held', 'expired'].includes(state)) {
    title = 'Reservation status needs checking';
    description = 'Your saved information is shown below. We cannot verify an active hold or accept changes in this state.';
  }

  return <section className="event-journey-frame" aria-labelledby={headingId} data-testid="event-funnel-journey-frame"
    data-state={state || (enabled ? 'loading' : 'disabled')}>
    <header className="event-journey-frame__header">
      <div className="event-journey-frame__topline">
        <div className="event-journey-frame__identity">
          <ShieldCheck size={19} aria-hidden="true" className="event-journey-frame__icon" />
          <span className="event-journey-frame__eyebrow">Your event reservation</span>
        </div>
        {timerVisible && <div className="event-journey-frame__timer" role="timer" aria-live="off"
          aria-label={expired ? 'Reservation time ended' : `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds remaining`}
          data-urgent={seconds <= 300} data-testid="journey-remaining-time">
          <Clock3 size={15} aria-hidden="true" />
          <span aria-hidden="true">{expired ? 'Time ended' : `${timeLabel} remaining`}</span>
        </div>}
      </div>
      <h2 id={headingId} data-testid="journey-status">{title}</h2>
      <p className="event-journey-frame__description">{description}</p>
      {reopenRequired && <p role="status" data-testid="journey-reopen-required">
        Reopen this reservation to load its latest timing. Changes to optional selections here will not extend the expired timer.
      </p>}
      {expired && !frozen && <p data-testid="journey-expired-editing">
        Adding or changing tickets is unavailable in this view until a timed hold is verified.
      </p>}
      {snapshot && state === 'draft' && !clock.current && <p data-testid="journey-no-deadline">No timed hold has started.</p>}
    </header>
    <div className="event-journey-frame__sr-only" role="status" aria-live="polite" aria-atomic="true"
      data-testid="journey-time-announcement">{announcement}</div>
    {(error || localError) && enabled && <div className="event-journey-frame__notice" data-tone="warning"
      role="alert" data-testid="journey-error">
      <strong>We could not verify the latest request.</strong>
      <p>{snapshot ? 'Your last saved selections are still shown. A failed request does not extend the reservation time.'
        : 'No reservation information has been verified. You can try loading it again.'}</p>
      <Button type="button" variant="outline" className="mt-3" disabled={readBlocked}
        onClick={refresh} data-testid="journey-retry">Check reservation again</Button>
    </div>}
    {snapshot?.removed?.length > 0 && <aside className="event-journey-frame__notice"
      aria-label="Optional selections updated" data-testid="journey-removed">
      <strong>Your optional selections changed</strong>
      <ul>{snapshot.removed.map((item, index) => <li key={`${item.nodeId}:${index}`}>{removalExplanation(item.reason)}</li>)}</ul>
    </aside>}
    {!snapshot && enabled && !error && !localError && <div className="event-journey-frame__skeleton"
      role="status" data-testid="journey-loading">
      <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
      <p>Loading your saved reservation…</p>
    </div>}
    {snapshot && <div className="event-journey-frame__body event-journey-frame__content" data-testid="journey-content"
      aria-busy={pending || loading}>
      {typeof renderBody === 'function' ? renderBody(journey)
        : renderEventFields(typeof children === 'function' ? children(journey) : null)}
    </div>}
    <footer className="event-journey-frame__actions" aria-label="Reservation actions">
      {typeof onBack === 'function' && <Button type="button" variant="ghost" disabled={blocked}
        onClick={() => safely(() => onBack())} data-testid="journey-back"><ArrowLeft aria-hidden="true" />Back</Button>}
      {snapshot && !frozen && optionalNode && !snapshot.route.atCheckout && <Button type="button" variant="outline"
        disabled={blocked} onClick={() => change({ type: 'skip', nodeId: current.id })} data-testid="journey-skip">Skip this offer</Button>}
      {snapshot && !frozen && hasSource && !checkoutNow && <Button type="button" variant="outline"
        disabled={blocked} onClick={() => change({ type: 'source_only' })} data-testid="journey-source-only">
        Continue with original event only
      </Button>}
      {snapshot && !frozen && checkoutNow && <Button type="button" variant="outline"
        disabled={blocked} onClick={() => change({ type: 'resume_offers' })} data-testid="journey-resume-offers">Return to optional offers</Button>}
      {expired && mutableState && <Button type="button" disabled={blocked || Boolean(reopenRequired)}
        onClick={() => change({ type: 'rereserve' })} data-testid="journey-rereserve">Check availability and prices again</Button>}
      {snapshot && frozen && !expired && <Button type="button" variant="outline" disabled={readBlocked}
        onClick={refresh} data-testid="journey-refresh">Check reservation status</Button>}
      {snapshot && !frozen && hasSource && !checkoutNow && <span className="event-journey-frame__actions-note">
        Continuing with the original event only removes optional selections. It does not reserve places, extend the timer, confirm or pay for a booking.
      </span>}
      {snapshot && !frozen && checkoutNow && <span className="event-journey-frame__actions-note">
        Returning to offers does not restore extras you previously released.
      </span>}
      {pending && <span role="status" data-testid="journey-saving">Saving your choice…</span>}
    </footer>
  </section>;
}
