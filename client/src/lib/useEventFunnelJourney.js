import { useCallback, useEffect, useRef, useState } from 'react';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (message, code = 'JOURNEY_UNAVAILABLE') => Object.assign(new Error(message), { code });

/**
 * Owned reservation requests only. Credentials stay in the existing member
 * session / HttpOnly guest cookie, never localStorage or navigation URLs.
 * No automatic retry can duplicate a mutation or restart an expired hold.
 */
export function useEventFunnelJourney({ sessionId, enabled = true }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const current = useRef(null), generation = useRef(0), controller = useRef(null), busy = useRef(false);
  const owner = useRef(sessionId);
  owner.current = sessionId;

  const request = useCallback(async (body, mutation = false) => {
    if (!enabled || !sessionIdPattern.test(sessionId || '')) throw failed('Reservation unavailable.', 'INVALID_SESSION');
    if (busy.current) throw failed('Wait for your current selection to finish saving.', 'REQUEST_PENDING');
    const ownGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    busy.current = mutation;
    setError(null);
    if (mutation) setPending(true);
    else setLoading(true);
    try {
      const response = await fetch('/api/event-funnels/journey', {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, sessionId }), signal: abort.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw failed('The reservation service returned an unreadable response.'); }
      if (!response.ok) throw failed(data?.error || 'Your reservation could not be saved.', data?.code);
      if (!data?.session || data.session.id !== sessionId.toLowerCase()
        || !Number.isSafeInteger(data.session.revision) || !Array.isArray(data.holds)
        || !data.route || !data.graph || !Number.isFinite(Date.parse(data.serverNow))) {
        throw failed('The reservation service returned incomplete information.');
      }
      if (ownGeneration !== generation.current || owner.current !== sessionId) return null;
      if (current.current && data.session.revision < current.current.session.revision) return null;
      current.current = data;
      setSnapshot(data);
      return data;
    } catch (cause) {
      if (cause.name === 'AbortError' || ownGeneration !== generation.current || owner.current !== sessionId) return null;
      // A failed optional offer never clears the last good source reservation.
      if (cause.code === 'JOURNEY_NOT_FOUND') {
        current.current = null; setSnapshot(null);
      }
      setError(cause);
      throw cause;
    } finally {
      if (ownGeneration === generation.current) {
        busy.current = false; setPending(false); setLoading(false);
      }
    }
  }, [sessionId, enabled]);

  const refresh = useCallback(() => request({ action: 'read' }), [request]);
  const change = useCallback(command => {
    if (!current.current || current.current.session.id !== sessionId?.toLowerCase()) {
      return Promise.reject(failed('Load your reservation before changing it.'));
    }
    return request({ action: 'change', command: { ...command, expectedRevision: current.current.session.revision } }, true);
  }, [request, sessionId]);
  const saveAnswers = useCallback((nodeId, answers) => {
    if (!current.current || current.current.session.id !== sessionId?.toLowerCase()) {
      return Promise.reject(failed('Load your reservation before saving attendee details.'));
    }
    return request({ action: 'answers', nodeId, answers, expectedRevision: current.current.session.revision }, true);
  }, [request, sessionId]);

  useEffect(() => {
    ++generation.current; controller.current?.abort(); busy.current = false;
    current.current = null; setSnapshot(null); setError(null); setPending(false); setLoading(false);
    if (enabled) refresh().catch(cause => {
      if (cause.code === 'INVALID_SESSION') setError(cause);
    });
    return () => { ++generation.current; controller.current?.abort(); busy.current = false; };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const sync = () => {
      if (document.visibilityState !== 'hidden' && !busy.current) refresh().catch(() => {});
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [enabled, refresh]);

  return {
    snapshot: enabled && snapshot?.session.id === sessionId?.toLowerCase() ? snapshot : null,
    error, loading, pending, refresh, change, saveAnswers,
  };
}
