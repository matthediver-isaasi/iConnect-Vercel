import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  buildCreditRefreshSnapshot,
  createCreditRefreshSession,
  runCreditRefreshSession,
} from "@/lib/bookingCreditRefresh";

async function postRefresh(body) {
  const response = await fetch('/api/reports/reconcile-booking-credits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Credit refresh failed');
  return data;
}

export default function BookingCreditRefresh({
  groups,
  tenantId,
  canRefresh,
  scopeKey,
  filterDescriptors,
  onRefetch,
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const pinnedRef = useRef(null);
  const contextRef = useRef({ tenantId, scopeKey });
  contextRef.current = { tenantId, scopeKey };

  const candidate = useMemo(() => buildCreditRefreshSnapshot(groups, {
    tenantId,
    scopeKey,
    filters: filterDescriptors,
  }), [groups, tenantId, scopeKey, filterDescriptors]);

  const publish = () => {
    if (!mountedRef.current) return;
    if (!sessionRef.current) {
      setSession(null);
      return;
    }
    const pinned = sessionRef.current?.snapshot;
    const current = contextRef.current;
    if (pinned && (pinned.tenantId !== current.tenantId || pinned.scopeKey !== current.scopeKey)) {
      setSession(null);
      return;
    }
    setSession({ ...sessionRef.current });
  };

  const stop = () => {
    if (runningRef.current) {
      stopRef.current = true;
      publish();
    }
  };

  useEffect(() => {
    const stale = pinnedRef.current
      && (pinnedRef.current.tenantId !== tenantId || pinnedRef.current.scopeKey !== scopeKey);
    if (stale) {
      if (runningRef.current) stopRef.current = true;
      sessionRef.current = null;
      pinnedRef.current = null;
      setSession(null);
    }
  }, [tenantId, scopeKey]);

  useEffect(() => {
    const warnOnClose = (event) => {
      if (!runningRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnOnClose);
    return () => window.removeEventListener('beforeunload', warnOnClose);
  }, []);

  useEffect(() => {
    // Strict Effects runs setup again after its development cleanup.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
    };
  }, []);

  const run = async (nextSession) => {
    if (runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    pinnedRef.current = nextSession.snapshot;
    sessionRef.current = nextSession;
    // The orchestrator marks the mutable session running synchronously, but
    // publish an explicit view state before its first network request so Stop
    // and the duplicate-run guard are visible immediately.
    if (mountedRef.current) setSession({ ...nextSession, status: 'running' });
    try {
      await runCreditRefreshSession(nextSession, {
        request: postRefresh,
        shouldStop: () => stopRef.current,
        onProgress: publish,
      });
      if (nextSession.status === 'complete') {
        toast.success(`Credits refreshed for ${nextSession.completed} bookings`);
      } else {
        toast.info(`Credit refresh stopped after ${nextSession.completed} bookings`);
      }
    } catch (error) {
      toast.error(error.message || 'Credit refresh failed');
    } finally {
      runningRef.current = false;
      publish();
      // Refresh the exact pinned report query. This keeps its table, totals and
      // exports aligned after success, failure, or a user-requested stop.
      await onRefetch?.(nextSession.snapshot);
    }
  };

  const begin = () => {
    if (!candidate.counts.total) return;
    const next = createCreditRefreshSession(candidate);
    setOpen(false);
    run(next);
  };

  const retry = () => {
    if (sessionRef.current?.status !== 'error') return;
    const snapshot = sessionRef.current.snapshot;
    if (snapshot.tenantId !== tenantId || snapshot.scopeKey !== scopeKey) {
      sessionRef.current = null;
      setSession(null);
      return;
    }
    run(sessionRef.current);
  };

  const resume = () => {
    if (sessionRef.current?.status !== 'stopped') return;
    const snapshot = sessionRef.current.snapshot;
    if (snapshot.tenantId !== tenantId || snapshot.scopeKey !== scopeKey) {
      sessionRef.current = null;
      setSession(null);
      return;
    }
    run(sessionRef.current);
  };

  if (!canRefresh || !tenantId) return null;
  const status = session?.status;
  const busy = status === 'running';
  const progressTotal = session?.snapshot?.counts?.total || candidate.counts.total;

  return (
    <>
      <Button
        variant="outline"
        className="gap-2"
        onClick={() => setOpen(true)}
        disabled={busy || !groups?.length}
        data-testid="button-refresh-booking-credits"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        Refresh Credits
      </Button>
      {busy && (
        <div className="flex items-center gap-2 text-sm" data-testid="credit-refresh-progress">
          <span>{session.completed} / {progressTotal} bookings completed. Keep this tab open.</span>
          <Button size="sm" variant="outline" className="gap-1" onClick={stop} data-testid="button-stop-credit-refresh">
            <Square className="w-3 h-3" /> Stop
          </Button>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-2 text-sm text-destructive" data-testid="credit-refresh-error">
          <span>{session.error}</span>
          <Button size="sm" variant="outline" onClick={retry} data-testid="button-retry-credit-refresh">Retry</Button>
        </div>
      )}
      {status === 'stopped' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="credit-refresh-stopped">
          <span>
            {session.stopReason === 'request_budget'
              ? `Paused after ${session.completed} of ${progressTotal} bookings at the per-run safety budget. Resume to continue from the saved cursor.`
              : `Stopped after ${session.completed} of ${progressTotal} bookings.`}
          </span>
          <Button size="sm" variant="outline" onClick={resume} data-testid="button-resume-credit-refresh">Resume</Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refresh booking credits?</DialogTitle>
            <DialogDescription>
              This checks a fixed snapshot across all displayed pagination pages, not only the current page. It performs read-only provider lookups and never creates refunds or credit notes. Keep this tab open until it finishes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="font-medium">{candidate.counts.total} eligible booking{candidate.counts.total === 1 ? '' : 's'}</div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{candidate.counts.booking} standard</Badge>
              <Badge variant="secondary">{candidate.counts.complex_event_booking} complex</Badge>
              {candidate.counts.excludedPublicInvoicePo > 0 && (
                <Badge variant="outline">{candidate.counts.excludedPublicInvoicePo} Invoice / PO excluded</Badge>
              )}
              {candidate.counts.excludedUnsupported > 0 && (
                <Badge variant="outline">{candidate.counts.excludedUnsupported} unsupported excluded</Badge>
              )}
            </div>
            <div>
              <div className="font-medium mb-1">Pinned filter scope</div>
              <ul className="list-disc pl-5 text-muted-foreground" data-testid="credit-refresh-filter-scope">
                {candidate.filters.map((filter, index) => <li key={`${filter}-${index}`}>{filter}</li>)}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={begin} disabled={!candidate.counts.total} data-testid="button-confirm-credit-refresh">
              Refresh {candidate.counts.total} bookings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}