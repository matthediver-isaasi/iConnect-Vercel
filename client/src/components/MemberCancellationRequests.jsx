import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFormAlertTenant } from "@/hooks/useFormAlerts";
import { adminFetch } from "@/lib/adminFetch";
import { memberChangeEndpoint, readMemberChangeResponse, requestDate, requestMoney } from "@/lib/memberChangeRequests";

const readable = value => typeof value === "string" && value ? value.replaceAll("_", " ") : "Not supplied";
const status = record => record.withdrawn_at ? "Withdrawn" : record.access_ended_at ? "Applied — access ended"
  : record.timing === "immediate" ? "Access end not confirmed"
    : record.timing ? "Scheduled — access end not recorded" : "Status not supplied";
const canWithdraw = record => !record.withdrawn_at && !record.access_ended_at && !!record.timing && record.timing !== "immediate";
const consequences = "Ending access does not waive service-used debt and does not prove that a refund or provider stop has completed. Financial processing and provider evidence must be checked separately.";

function AuthoritySummary({ authority }) {
  const calculation = authority.calculation;
  const policy = authority.policySnapshot?.policy;
  const surplusPolicy = policy?.cancellationUnusedValue;
  const surplusHandling = policy?.surplusHandling;
  const amount = value => Number.isSafeInteger(value) ? requestMoney(value, calculation?.currency) : "Awaiting reconciliation";
  return <div className="space-y-2 text-sm">
    <p>Effective date: {requestDate(authority.effectiveDate)} · Timing: {readable(authority.timing)} (tenant policy; no override).</p>
    <p>Financial review: {readable(authority.financialReviewReason)}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><dt className="text-muted-foreground">Service-used balance due</dt><dd>{amount(calculation?.paymentDueMinor)}</dd></div>
      <div><dt className="text-muted-foreground">Calculated unused value — not a return entitlement</dt><dd>{amount(calculation?.surplusMinor)}</dd></div>
    </dl>
    {surplusPolicy === "none" ? <p>Frozen cancellation policy: unused value is retained. The calculated unused value is not owed back as a refund or member credit under this policy.</p>
      : surplusPolicy === "tenant_surplus_policy" ? <p>Frozen cancellation policy: tenant surplus policy. {{
        credit: "Eligible unused value is considered for member credit, subject to separate financial review and execution. No member credit has been issued by this preview.",
        refund: "Eligible unused value is considered for refund, subject to separate financial review and reconciliation. No refund is promised or processed by this preview.",
        approval: "Unused-value treatment requires separate approval. Neither member credit nor a refund has been approved by this preview.",
      }[surplusHandling] || "Surplus handling is not supplied or is unsupported here. Return entitlement requires financial review; do not infer a refund or member credit."}</p>
        : <p>Unused-value treatment is not established by this preview. Check the frozen policy in the separate financial review before determining any return entitlement.</p>}
    <p className="text-muted-foreground">Unknown monthly amounts: awaiting reconciliation, not zero. Preview amounts are not evidence of collection, refund or settlement.</p>
  </div>;
}

export default function MemberCancellationRequests({ memberId, tenantId, actionsEnabled = false, onChange }) {
  const scope = useFormAlertTenant("commerce.monthly-finance-report");
  if (!memberId) return null;
  if (scope.status !== "ready" || scope.tenantId !== tenantId) return <section aria-label="Administrator cancellation requests" className="rounded-md border p-4 space-y-2">
    <h3 className="font-medium">Administrator cancellation requests</h3>
    <p role={scope.status === "loading" ? "status" : "alert"} className="text-sm text-muted-foreground">{scope.status === "loading" ? "Verifying finance administrator access…" : "Finance administrator access for this tenant could not be verified. Reload or sign in again."}</p>
  </section>;
  return <CancellationSession key={JSON.stringify([memberId, tenantId, scope.scopeKey])} memberId={memberId} tenantId={tenantId} scope={scope} actionsEnabled={actionsEnabled} onChange={onChange} />;
}

function CancellationSession({ memberId, tenantId, scope, actionsEnabled, onChange }) {
  const [records, setRecords] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [historyStale, setHistoryStale] = useState(true);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(null);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [withdrawal, setWithdrawal] = useState(null);
  const [withdrawUnknown, setWithdrawUnknown] = useState(null);
  const live = useRef(false);
  const lock = useRef(false);
  const permissionVersion = useRef(0);
  const context = useRef({ scope, actionsEnabled, onChange });
  context.current = { scope, actionsEnabled, onChange };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    permissionVersion.current += 1;
    // A bound, uncertain confirmation must retain its original consequences.
    if (!attempt) setPreview(null);
    setApproved(false);
  }, [actionsEnabled]);
  function current() {
    if (!live.current) return false;
    try { context.current.scope.assertCurrent(); return true; } catch { return false; }
  }
  function update(record) {
    setRecords(previous => [record, ...(previous || []).filter(item => item.id !== record.id)]);
    // This signals authoritative request/access evidence, not completed finances.
    context.current.onChange?.(record);
  }
  async function request(payload) {
    context.current.scope.assertCurrent();
    const response = await adminFetch(memberChangeEndpoint, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, memberId }),
    }, tenantId);
    const result = await readMemberChangeResponse(response);
    context.current.scope.assertCurrent();
    return result;
  }
  async function load(after = null) {
    if (lock.current) return;
    lock.current = true; setBusy("load"); setError(null);
    try {
      context.current.scope.assertCurrent();
      const query = new URLSearchParams({ action: "cancellation_requests", memberId });
      if (after) query.set("after", after);
      const result = await readMemberChangeResponse(await adminFetch(`${memberChangeEndpoint}?${query}`, { credentials: "include", cache: "no-store" }, tenantId));
      if (!current()) return;
      if (!Array.isArray(result?.records) || result.records.some(record => !record?.id)
        || (result.nextCursor != null && typeof result.nextCursor !== "string")) throw new Error("Cancellation history could not be verified.");
      setRecords(previous => after ? [...(previous || []), ...result.records.filter(item => !(previous || []).some(old => old.id === item.id))] : result.records);
      setCursor(result.nextCursor || null); setHistoryStale(false);
    } catch (failure) {
      if (current()) { setError(failure); setHistoryStale(true); }
    } finally {
      lock.current = false;
      if (current()) setBusy("");
    }
  }
  useEffect(() => { void load(); }, []);
  const denied = [401, 403].includes(error?.status);
  const disabled = !!busy || !actionsEnabled || historyStale || denied;
  async function run(action, record) {
    if (lock.current || !context.current.actionsEnabled || denied || historyStale) return;
    if (action !== "recover_cancellation" && withdrawUnknown) return;
    if (action === "preview_cancellation" && (attempt || saved || !reason.trim() || reason.trim().length > 2000)) return;
    if (action === "confirm_cancellation" && (!approved || (attempt ? !retryAllowed : !preview))) return;
    if (action === "withdraw_cancellation" && ((attempt && !saved) || !canWithdraw(record) || !withdrawal?.reason.trim() || withdrawal.reason.trim().length > 2000 || !withdrawal?.approved)) return;
    const permissionToken = permissionVersion.current;
    lock.current = true; setBusy(action); setError(null); setMessage("");
    let payload = { action };
    if (action === "preview_cancellation") {
      setPreview(null); setApproved(false);
      payload.selection = { reason: reason.trim() };
    } else if (action === "confirm_cancellation") {
      const stable = attempt || { key: crypto.randomUUID(), fingerprint: preview.fingerprint, selection: { reason: reason.trim() } };
      setAttempt(stable); setRetryAllowed(false);
      payload = { ...payload, ...stable, approve: true };
    } else if (action === "recover_cancellation") {
      payload = record ? { ...payload, id: record.id } : { ...payload, key: attempt.key, fingerprint: attempt.fingerprint };
      if (!record) setRetryAllowed(false);
    } else if (action === "withdraw_cancellation") {
      payload = { ...payload, id: record.id, reason: withdrawal.reason.trim() };
      setWithdrawUnknown(record.id);
    }
    try {
      const result = await request(payload);
      if (!current()) return;
      if (action === "preview_cancellation") {
        if (!context.current.actionsEnabled || permissionVersion.current !== permissionToken) return;
        if (!result?.authority || !result.authority.effectiveDate || Number.isNaN(Date.parse(result.authority.effectiveDate))
          || typeof result.authority.timing !== "string" || !result.authority.timing
          || typeof result.fingerprint !== "string" || !result.fingerprint) throw new Error("A valid cancellation preview was not returned. Preview again before confirming.");
        setPreview(result);
      } else if (action === "recover_cancellation" && !record && result?.record === null) {
        setRetryAllowed(true); setApproved(false);
        setMessage("No request found for this key. You may explicitly retry confirmation with the same key, fingerprint and reason.");
      } else {
        if (!result?.record?.id || !result.record.effective_date || !result.record.timing || (record && result.record.id !== record.id)
          || (action === "withdraw_cancellation" && !result.record.withdrawn_at)) throw new Error("The cancellation outcome was not confirmed. Recover the request before any retry.");
        update(result.record);
        if (record) {
          if (!withdrawUnknown || withdrawUnknown === record.id) { setWithdrawUnknown(null); setWithdrawal(null); }
        }
        else { setSaved(true); setPreview(null); setApproved(false); }
        setMessage(`${status(result.record)}. Financial processing and provider stop are not confirmed by this response. Review Applied cancellation finances below.`);
      }
    } catch (failure) {
      if (current()) setError(failure);
    } finally {
      lock.current = false;
      if (current()) setBusy("");
    }
  }
  const formLocked = disabled || !!attempt || saved || !!withdrawUnknown;
  return <section aria-label="Administrator cancellation requests" className="rounded-md border p-4 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">Administrator cancellation requests</h3>
      <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => load()}>Reload cancellation history</Button>
    </div>
    <p className="text-sm text-muted-foreground">{consequences}</p>
    {busy === "load" && <div role="status" aria-label="Loading cancellation requests" className="space-y-2"><div className="h-5 w-2/3 rounded bg-muted" /><div className="h-16 rounded bg-muted" /></div>}
    {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{denied ? "Sign-in or finance administrator access is required. " : ""}{error.message}</p>}
    {historyStale && !busy && <p role="alert" className="text-sm">Reload cancellation history before making changes. Previously loaded records may be out of date.</p>}
    {message && <p role="status" className="rounded-md bg-muted/50 p-3 text-sm">{message}</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run("preview_cancellation"); }}>
      <Label htmlFor={`cancel-reason-${memberId}`}>Cancellation reason (required)</Label>
      <Textarea id={`cancel-reason-${memberId}`} required maxLength={2000} value={reason} disabled={formLocked} onChange={event => { setReason(event.target.value); setPreview(null); setApproved(false); setError(null); }} />
      {!attempt && !saved && <Button type="submit" variant="outline" disabled={formLocked || !reason.trim()}>{busy === "preview_cancellation" ? "Preparing cancellation preview…" : "Preview cancellation"}</Button>}
    </form>
    {preview && !saved && <div className="rounded-md border p-3 space-y-3" aria-live="polite">
      <h4 className="text-sm font-medium">Cancellation preview — not confirmed</h4>
      <AuthoritySummary authority={preview.authority} />
      {(!attempt || retryAllowed) && <>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={approved} disabled={disabled || !!withdrawUnknown} onChange={event => setApproved(event.target.checked)} /><span>I explicitly approve cancellation on the policy effective date. I understand access ending does not waive debt or confirm a refund or provider stop.</span></label>
        <Button type="button" disabled={disabled || !!withdrawUnknown || !approved} onClick={() => run("confirm_cancellation")}>{attempt ? "Retry cancellation confirmation with same key" : "Confirm cancellation"}</Button>
      </>}
    </div>}
    {attempt && !saved && <div className="space-y-2 text-sm">
      <p role="status">{retryAllowed ? "Recovery found no saved request. The original reason, key and fingerprint are retained." : "Confirmation outcome is unconfirmed. The form is retained and locked. Recover by key before any retry."}</p>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => run("recover_cancellation")}>Recover cancellation by key</Button>
    </div>}
    <section aria-label="Cancellation request history" className="space-y-3">
      <h4 className="font-medium text-sm">Cancellation request history</h4>
      {records?.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No cancellation requests recorded for this member.</p>}
      <ol className="space-y-3">{records?.map(record => <li key={record.id} className="rounded-md border p-3 space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium break-all">Cancellation request {record.id}</h5><Badge variant="outline">{status(record)}</Badge></div>
        <p>Effective: {requestDate(record.effective_date)} · Timing: {readable(record.timing)}{record.created_at ? ` · Recorded: ${requestDate(record.created_at)}` : ""}</p>
        <p className="whitespace-pre-wrap break-words">{record.reason || "Reason not supplied"}</p>
        <p>Access ended: {requestDate(record.access_ended_at)} · Withdrawn: {requestDate(record.withdrawn_at)}</p>
        <p>Recorded financial state: {readable(record.financial_state)}. This is not proof of a completed refund or provider stop.</p>
        <Button type="button" variant="outline" size="sm" disabled={disabled || (!!attempt && !saved)} onClick={() => run("recover_cancellation", record)}>Recover cancellation request {record.id}</Button>
        {canWithdraw(record) && (withdrawal?.id === record.id ? <form className="space-y-3 border-t pt-3" onSubmit={event => { event.preventDefault(); void run("withdraw_cancellation", record); }}>
          <Label htmlFor={`withdraw-cancellation-${record.id}`}>Withdrawal reason (required)</Label>
          <Textarea id={`withdraw-cancellation-${record.id}`} required maxLength={2000} value={withdrawal.reason} disabled={disabled || !!withdrawUnknown || (!!attempt && !saved)} onChange={event => setWithdrawal({ ...withdrawal, reason: event.target.value, approved: false })} />
          <label className="flex items-start gap-2"><input type="checkbox" checked={withdrawal.approved} disabled={disabled || !!withdrawUnknown || (!!attempt && !saved)} onChange={event => setWithdrawal({ ...withdrawal, approved: event.target.checked })} />I confirm withdrawal before access has ended. This does not reverse completed access or financial actions.</label>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !!withdrawUnknown || (!!attempt && !saved) || !withdrawal.reason.trim() || !withdrawal.approved}>Confirm cancellation withdrawal</Button><Button type="button" variant="outline" disabled={!!busy || !!withdrawUnknown} onClick={() => setWithdrawal(null)}>Keep scheduled cancellation</Button></div>
        </form> : <Button type="button" variant="outline" size="sm" disabled={disabled || (!!attempt && !saved) || !!withdrawUnknown} onClick={() => setWithdrawal({ id: record.id, reason: "", approved: false })}>Withdraw scheduled cancellation {record.id}</Button>)}
        {withdrawUnknown === record.id && <p role="alert">Withdrawal outcome is unconfirmed. Recover this request before trying to withdraw it again.</p>}
      </li>)}</ol>
      {cursor && <Button type="button" variant="outline" disabled={!!busy || historyStale} onClick={() => load(cursor)}>Load more cancellation requests</Button>}
    </section>
  </section>;
}
