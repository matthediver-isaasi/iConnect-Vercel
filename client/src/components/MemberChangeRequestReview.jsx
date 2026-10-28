import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFormAlertTenant } from "@/hooks/useFormAlerts";
import { adminFetch } from "@/lib/adminFetch";
import { memberChangeEndpoint, readMemberChangeResponse } from "@/lib/memberChangeRequests";
import { MemberChangeRequestRecord } from "./MemberChangeRequestSummary";

export default function MemberChangeRequestReview({ memberId, tenantId, actionsEnabled = true, onSelectApprovedAuthority }) {
  const scope = useFormAlertTenant("commerce.monthly-finance-report");
  if (scope.status !== "ready" || scope.tenantId !== tenantId) return <section className="space-y-2 rounded-md border p-4" aria-label="Member request review"><h3 className="font-medium">Member-submitted requests</h3><p role={scope.status === "loading" ? "status" : "alert"} className="text-sm text-muted-foreground">{scope.status === "loading" ? "Verifying finance administrator access…" : "Your tenant or finance access could not be verified. Reload or sign in again before reviewing requests."}</p></section>;
  return <MemberChangeReviewSession key={`${memberId}:${tenantId}:${scope.scopeKey}`} memberId={memberId} tenantId={tenantId} scope={scope} actionsEnabled={actionsEnabled} onSelectApprovedAuthority={onSelectApprovedAuthority} />;
}

export function MemberChangeReviewSession({ memberId, tenantId, scope, actionsEnabled, onSelectApprovedAuthority }) {
  const queryClient = useQueryClient();
  const [requests, setRequests] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [unknown, setUnknown] = useState(false);
  const [historyStale, setHistoryStale] = useState(false);
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState("");
  const live = useRef(false);
  const version = useRef(0);
  const lock = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; version.current += 1; lock.current = false; };
  }, []);
  function current(token) {
    if (!live.current || token !== version.current) return false;
    try { scopeRef.current.assertCurrent(); return true; } catch { return false; }
  }
  async function run(review) {
    if (lock.current || (review && (!actionsEnabled || unknown || historyStale || !review.reason.trim()
      || review.reason.trim().length > 2000 || !review.confirmed))) return;
    lock.current = true;
    const token = ++version.current;
    setBusy(review ? "review" : "load"); setError(null); setMessage("");
    try {
      scopeRef.current.assertCurrent();
      const result = await readMemberChangeResponse(await adminFetch(review ? memberChangeEndpoint
        : `${memberChangeEndpoint}?action=member_change_requests&memberId=${encodeURIComponent(memberId)}`, review ? {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review_member_change_request", memberId, id: review.id,
          decision: review.decision, reason: review.reason.trim() }),
      } : { cache: "no-store" }, tenantId));
      if (!current(token)) return;
      if (!review) {
        if (!Array.isArray(result?.requests)) throw new Error("Request history could not be verified. Reload before reviewing.");
        setRequests(result.requests); setUnknown(false); setHistoryStale(false); setDraft(null);
        // A previously ambiguous approval may now be present. Refresh the
        // existing authority panel after authoritative history reload too.
        if (result.requests.some(record => record.state === "approved")) {
          void queryClient.invalidateQueries({ queryKey: ["member-amendments", tenantId, memberId] });
        }
      } else {
        if (result?.id !== review.id || result.state !== (review.decision === "approve" ? "approved" : "rejected")) throw new Error("The review outcome was not confirmed.");
        setRequests(old => old.map(record => record.id === result.id ? result : record));
        setDraft(null);
        setMessage(result.state === "approved"
          ? "Approved for processing only. Select Review financial processing to check the saved authority and explicitly approve its permitted treatment. No payment, refund or membership change was executed."
          : "Request rejected. No financial authority was created by this rejection.");
        if (result.state === "approved") void queryClient.invalidateQueries({ queryKey: ["member-amendments", tenantId, memberId] });
      }
    } catch (failure) {
      if (!current(token)) return;
      setError(failure);
      if (review) { setUnknown(true); setDraft(null); }
      else setHistoryStale(true);
    } finally {
      if (current(token)) { lock.current = false; setBusy(""); }
    }
  }
  useEffect(() => { void run(); }, []);
  const denied = [401, 403].includes(error?.status);
  const disabled = !!busy || unknown || historyStale || denied || !actionsEnabled;
  return <section aria-label="Member request review" className="space-y-4 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">Member-submitted requests</h3><Button size="sm" variant="outline" disabled={!!busy} onClick={() => run()}>Reload member requests</Button></div>
    <p className="text-sm text-muted-foreground">Review the member’s request and record a reason. Approval creates financial authority for the existing administrator financial panel; it does not execute transactions or apply membership. Upfront and monthly requests remain subject to the server’s financial and evidence checks. Processing is a separate administrator action, not automatic.</p>
    {busy === "load" && <div role="status" aria-label="Loading member-submitted requests" className="space-y-2"><div className="h-5 w-2/3 rounded bg-muted motion-safe:animate-pulse" /><div className="h-24 rounded bg-muted motion-safe:animate-pulse" /></div>}
    {error && <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-slate-800">{denied ? `Sign-in or finance access is required. ${error.message}` : error.message}</div>}
    {unknown && <p role="alert" className="text-sm">Review outcome unknown. Reload member requests before making any further decision. Do not repeat approval without checking the saved outcome.</p>}
    {historyStale && requests && <p role="alert" className="text-sm">History could not be verified. Reload member requests before reviewing the previously loaded records.</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {requests?.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">This member has not submitted any membership review requests.</p>}
    {requests?.map(record => <MemberChangeRequestRecord key={record.id} record={record}>
      {record.state === "approved" && <div className="space-y-2 border-t pt-3">
        <p className="text-sm text-muted-foreground">The request summary does not establish settlement policy, liability backing or current execution status. Review the original saved authority in the financial controls below; no zero balance or refund eligibility is inferred.</p>
        <Button size="sm" variant="outline" disabled={disabled || !record.authorityId || !onSelectApprovedAuthority} onClick={() => {
          try {
            scopeRef.current.assertCurrent();
            onSelectApprovedAuthority(record.authorityId);
          } catch (failure) { setError(failure); }
        }}>Review financial processing</Button>
        {!record.authorityId && <p role="alert" className="text-sm">Approved authority reference is missing. Reload requests or contact finance support; do not create another authority.</p>}
        {!onSelectApprovedAuthority && <p className="text-sm">Open this member’s administrator financial controls to process the saved authority.</p>}
      </div>}
      {record.state === "pending" && (draft?.id === record.id ? <form className="space-y-3 border-t pt-3" onSubmit={event => { event.preventDefault(); void run(draft); }}>
        <p className="text-sm font-medium">{draft.decision === "approve" ? "Approve financial authority only" : "Reject request"}</p>
        <Label htmlFor={`review-reason-${record.id}`}>Review reason (required)</Label>
        <p className="text-xs text-muted-foreground">This reason will be visible to the member.</p>
        <Textarea id={`review-reason-${record.id}`} value={draft.reason} required maxLength={2000} disabled={disabled} onChange={event => setDraft({ ...draft, reason: event.target.value, confirmed: false })} />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.confirmed} disabled={disabled} onChange={event => setDraft({ ...draft, confirmed: event.target.checked })} />{draft.decision === "approve" ? "I explicitly approve this financial authority. I understand execution remains a separate administrator action." : "I confirm rejection of this member request."}</label>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !draft.reason.trim() || !draft.confirmed}>{busy === "review" ? "Recording decision…" : draft.decision === "approve" ? "Confirm approval" : "Confirm rejection"}</Button><Button type="button" variant="outline" disabled={!!busy} onClick={() => setDraft(null)}>Cancel review</Button></div>
      </form> : <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => setDraft({ id: record.id, decision: "approve", reason: "", confirmed: false })}>Review approval</Button><Button variant="outline" size="sm" disabled={disabled} onClick={() => setDraft({ id: record.id, decision: "reject", reason: "", confirmed: false })}>Review rejection</Button></div>)}
    </MemberChangeRequestRecord>)}
  </section>;
}
