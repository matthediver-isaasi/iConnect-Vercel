import { useEffect, useMemo, useState } from 'react';

// Wake precisely at the next release (including schedules beyond the browser's
// maximum timeout), and reconcile after sleep/backgrounding or clock changes.
export function useTicketReleaseClock(tickets = []) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scheduleKey = JSON.stringify(tickets.map(ticket => ticket?.release_at || null));

  useEffect(() => {
    let timer;
    const releases = JSON.parse(scheduleKey).map(value => Date.parse(value)).filter(Number.isFinite);
    const refresh = () => {
      clearTimeout(timer);
      const now = Date.now();
      setNowMs(now);
      const next = releases.filter(release => release > now).sort((a, b) => a - b)[0];
      if (next !== undefined) timer = setTimeout(refresh, Math.min(next - now, 2147483647));
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [scheduleKey]);

  // Settings changes must apply during render, before the effect refreshes.
  return useMemo(() => Math.max(nowMs, Date.now()), [nowMs, scheduleKey]);
}