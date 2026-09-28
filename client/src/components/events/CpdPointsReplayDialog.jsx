import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CPD_REPLAY_ENDPOINT, canConfirmCpdPreview, cpdRegistrationKey, readCpdReplayResponse } from "@/lib/cpdPointsReplay";

const LABELS = {
  eligible: "Eligible", already_awarded: "Already awarded", no_rule: "No rule",
  no_award: "No award", missing_attendance: "Missing / non-qualifying attendance",
  unmatched_member: "Unmatched member", ineligible: "Cancelled / ineligible",
  evaluation_error: "Evaluation error", pending: "Pending", awarded: "Awarded",
  unchanged: "Unchanged / skipped", retrying: "Retrying", failed: "Terminal failure",
};
const PAGE_SIZE = 50;
const MAX_AUTO_PAGES = 20;
const MAX_POLLS = 60;

// Mounted with a frozen scope; report filters and selection never change this dialog.
export default function CpdPointsReplayDialog({ scope, scopeLabel, replayId: initialReplayId, onClose }) {
  const client = useQueryClient();
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [replayId, setReplayId] = useState(initialReplayId || null);
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [previewPage, setPreviewPage] = useState(1);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const pending = useRef(false);
  const requestId = useRef(null);
  const confirmedReason = useRef(null);
  const lastAwarded = useRef(0);
  const controller = useRef(null);
  const generation = useRef(0);

  useEffect(() => {
    controller.current = new AbortController();
    return () => {
      controller.current.abort();
      generation.current++;
      pending.current = false;
    };
  }, []);

  const request = useCallback(async (body, query = "") => {
    const response = await fetch(`${CPD_REPLAY_ENDPOINT}${query}`, {
      credentials: "include", signal: controller.current.signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    return readCpdReplayResponse(response);
  }, []);

  const loadPreview = async (resume = false) => {
    if (pending.current) return;
    pending.current = true;
    const currentGeneration = generation.current;
    setBusy(true);
    setError("");
    setStale(false);
    if (!resume) {
      setRows([]);
      setPreview(null);
      setPreviewPage(1);
      setReason("");
      requestId.current = null;
      confirmedReason.current = null;
    }
    let cursor = resume ? preview?.cursor : null;
    try {
      for (let index = 0; index < MAX_AUTO_PAGES; index++) {
        const data = await request({ action: "preview", scope, ...(cursor ? { cursor } : {}) });
        if (currentGeneration !== generation.current || controller.current.signal.aborted) return;
        if (!Array.isArray(data.rows) || !data.totals || (!data.complete && !data.cursor && !data.evaluation_failed)) {
          throw new Error("Incomplete preview response. No points have been queued.");
        }
        setRows(previous => [...previous, ...data.rows]);
        setPreview(data);
        if (data.evaluation_failed) {
          throw new Error(data.error || "Preview evaluation failed. Review the registration errors and run a new preview.");
        }
        if (data.complete) break;
        cursor = data.cursor;
      }
    } catch (err) {
      if (currentGeneration === generation.current && err.name !== "AbortError") {
        setError(err.message);
        setStale(true);
      }
    } finally {
      if (currentGeneration === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const refreshResults = useCallback(async () => {
    if (!replayId || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await request(null, `?${new URLSearchParams({ replay_id: replayId, page: String(page), page_size: String(PAGE_SIZE) })}`);
      if (!Array.isArray(data.rows) || !data.totals) throw new Error("Incomplete results response. Refresh to try again.");
      setResult(data);
      const awarded = Number(data.totals.awarded) || 0;
      if (awarded > lastAwarded.current) {
        lastAwarded.current = awarded;
        // Include member history and any certificate metadata queries; opening a
        // certificate also fetches fresh metadata rather than reusing a PDF.
        client.invalidateQueries({
          predicate: query => ["event-registration-report", "member-cpd-points", "attendee-cpd-certificate"].includes(query.queryKey[0]),
        });
      }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [replayId, page, request, client]);

  useEffect(() => {
    if (!initialReplayId) loadPreview();
  }, []); // Scope is frozen by the parent for the lifetime of this dialog.

  useEffect(() => {
    if (replayId) refreshResults();
  }, [refreshResults, replayId]);

  useEffect(() => {
    if (!replayId || !result || result.complete || busy || error || pollCount >= MAX_POLLS) return undefined;
    const timer = setTimeout(() => {
      setPollCount(count => count + 1);
      refreshResults();
    }, 3000);
    return () => clearTimeout(timer);
  }, [replayId, result, busy, error, pollCount, refreshResults]);

  const confirm = async () => {
    if (pending.current || stale || !canConfirmCpdPreview(preview, rows) || !reason.trim()) return;
    if (!requestId.current) {
      if (!globalThis.crypto?.randomUUID) {
        setError("Secure request IDs are unavailable. Use a supported browser.");
        return;
      }
      requestId.current = globalThis.crypto.randomUUID();
      confirmedReason.current = reason.trim();
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await request({
        action: "confirm", preview_token: preview.preview_token,
        reason: confirmedReason.current, request_id: requestId.current, confirmed: true,
      });
      if (!data.replay_id) throw new Error("No processing ID was returned. Retry confirmation with the same request.");
      setReplayId(data.replay_id);
      setUncertain(false);
      client.invalidateQueries({ queryKey: ["cpd-points-replays"] });
    } catch (err) {
      if (err.name !== "AbortError") {
        setError(err.status === 409 ? "This preview is no longer current. Run a new preview and review it before confirming again." : err.message);
        setStale(err.status === 409);
        setUncertain(err.status !== 409);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const canConfirm = !stale && canConfirmCpdPreview(preview, rows);
  const visibleRows = replayId ? result?.rows || [] : rows.slice((previewPage - 1) * PAGE_SIZE, previewPage * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil((replayId ? Number(result?.total) || 0 : rows.length) / PAGE_SIZE));
  const currentPage = replayId ? page : previewPage;
  const changePage = replayId ? setPage : setPreviewPage;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto" data-testid="cpd-replay-dialog">
        <DialogHeader>
          <DialogTitle>{replayId ? "CPD points processing results" : "Reprocess CPD points"}</DialogTitle>
          <DialogDescription>
            {replayId
              ? "These are actual processing outcomes, not queue acceptance. Processing continues after you close this dialog."
              : "Read-only preview first. This does not award points, change attendance, or send certificates. Existing awards, even if later adjusted or reversed, will not be topped up or re-awarded."}
          </DialogDescription>
        </DialogHeader>
        {scopeLabel && <p className="text-sm font-medium">Scope: {scopeLabel}</p>}
        {!replayId && scope?.mode === "all_event" && <p className="text-sm text-muted-foreground">Includes every server-side registration for this event, regardless of report filters or pagination.</p>}
         {!replayId && rows.some(row => row.outcome === "unmatched_member") && (
           <p className="text-sm text-muted-foreground" data-testid="cpd-unmatched-member-guidance">
             Unmatched member: no unique member in this event&apos;s tenant matches the attendee email. Verify the attendee&apos;s identity and email against the intended member record through the normal admin process, then run a new read-only preview. A purchaser&apos;s member record is not a substitute; guest registrations without a matching attendee member cannot receive member CPD points.
           </p>
         )}
        {replayId ? (
          <>
            <p className="text-xs break-all">Processing ID: {replayId}</p>
            {result && <>
              <p className="text-sm">Reason: {result.reason}</p>
              <div className="flex flex-wrap gap-3 text-sm" aria-label="Processing totals">
                {["registrations", "pending", "awarded", "unchanged", "retrying", "failed"].map(key => <span key={key}>{key === "registrations" ? "Registrations" : LABELS[key]}: <strong>{result.totals[key]}</strong></span>)}
                <span>Actual points awarded: <strong>{result.totals.awarded_points}</strong></span>
              </div>
              <p role="status" className="text-sm">{result.complete
                ? Number(result.totals.failed) > 0 ? "Processing finished with failures. Review the rows below." : "Processing finished. Review the actual outcomes below."
                : "Processing is not finished. Pending and retrying registrations have not been awarded yet."}</p>
              {pollCount >= MAX_POLLS && !result.complete && <p className="text-sm text-muted-foreground">Automatic refresh paused. Refresh manually or reopen results later.</p>}
            </>}
            <Button type="button" variant="outline" disabled={busy} onClick={refreshResults}>Refresh results</Button>
          </>
        ) : preview && (
          <div className="space-y-2 text-sm">
            <p role="status">{preview.complete ? "Preview complete" : "Preview incomplete — confirmation is unavailable"} · {preview.totals.registrations} unique registrations · {preview.totals.eligible} eligible · <strong>{preview.totals.proposed_points} proposed points</strong></p>
            {!busy && !stale && !preview.complete && <Button type="button" variant="outline" onClick={() => loadPreview(true)}>Continue read-only preview</Button>}
            {preview.complete && !canConfirm && !stale && <p>No confirmation is available: there are no eligible registrations, or the evaluation is incomplete or contains errors.</p>}
          </div>
        )}
        {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{replayId ? "Loading results…" : "Checking…"}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {uncertain && <p className="text-sm text-warning">Confirmation may already have been accepted. Retry with the same request below or close and check recent results. Do not start a second replay.</p>}
        {stale && !replayId && <Button type="button" variant="outline" disabled={busy} onClick={() => loadPreview()}>Run a new read-only preview</Button>}
        {visibleRows.length > 0 && (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <caption className="sr-only">{replayId ? "Actual CPD points outcomes" : "Read-only CPD points predictions"}</caption>
              <thead><tr className="border-b bg-muted">
                <th className="p-2 text-left">Registration</th>
                {!replayId && <><th className="p-2 text-left">Effective rule</th><th className="p-2 text-left">Trigger</th></>}
                <th className="p-2 text-left">{replayId ? "Awarded points" : "Proposed points"}</th>
                <th className="p-2 text-left">{replayId ? "Actual outcome" : "Predicted outcome"}</th>
              </tr></thead>
              <tbody>{visibleRows.map(row => <tr key={cpdRegistrationKey(row)} className="border-b last:border-0">
                <td className="p-2"><span>{row.attendee_name || "Unnamed attendee"}</span><span className="block text-xs text-muted-foreground break-all">{row.booking_source} · {row.booking_id}<br />Event: {row.event_id}</span></td>
                {!replayId && <><td className="p-2">{row.rule ? `${row.rule.ticket_id ? "Ticket override" : "Event-wide"}: ${row.rule.no_award ? "No award" : `${row.rule.points} points`}` : "No rule"}</td><td className="p-2">{row.trigger === "registration" ? "Registration" : row.trigger === "attendance" ? "Verified attendance" : "—"}</td></>}
                <td className="p-2">{replayId ? row.points ?? "—" : row.proposed_points}</td>
                <td className="p-2">{LABELS[row.status || row.outcome] || row.status || row.outcome}{row.detail && <span className="block text-xs text-muted-foreground">{row.detail}</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" disabled={busy || currentPage <= 1} onClick={() => changePage(value => value - 1)}>Previous</Button>
          <span className="text-sm">Page {currentPage} of {totalPages}</span>
          <Button type="button" variant="outline" disabled={busy || currentPage >= totalPages} onClick={() => changePage(value => value + 1)}>Next</Button>
        </div>}
        {!replayId && canConfirm && <div className="space-y-2 border-t pt-3">
          <Label htmlFor="cpd-replay-reason">Reason for reprocessing (required)</Label>
          <Textarea id="cpd-replay-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy || uncertain} />
          <p className="text-xs text-muted-foreground">Confirm only after reviewing this complete preview. The worker rechecks eligibility and will not award a different rule or amount. Certificates are not sent automatically.</p>
          <Button type="button" disabled={busy || !reason.trim()} onClick={confirm} data-testid="confirm-cpd-reprocessing">{uncertain ? "Retry confirmation safely" : "Confirm reprocessing"}</Button>
        </div>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}