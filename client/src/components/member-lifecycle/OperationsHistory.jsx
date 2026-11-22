import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceValue, ErrorRetry, Loading, Notice, Panel, words } from "./LifecycleUI";

function NotificationRecovery({ noticeId, disabled, onAction }) {
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const word = resolution === "sent" ? "VERIFIED DELIVERY" : resolution === "retry" ? "VERIFIED NOT SENT" : "";
  const submit = async event => {
    event.preventDefault();
    if (disabled || !["sent", "retry"].includes(resolution) || !reason.trim() || confirmation !== word) return;
    const outcome = await onAction("resolve_notice", {
      action: "resolve_notice", noticeId, resolution, reason: reason.trim(), confirmation,
    });
    if (outcome) { setOpen(false); setResolution(""); setReason(""); setConfirmation(""); }
  };
  if (!open) return <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}>Review notification outcome</Button>;
  return <form onSubmit={submit} className="space-y-3 rounded-lg border p-4" aria-label="Independently verified notification recovery">
    <Notice tone="warning" title="Verify the provider outcome independently">Check the provider’s delivery records before choosing a resolution. Retry only after independently verifying the notification was not sent, to avoid duplicate emails. A timeout or missing receipt is not proof of non-delivery. Ambiguous sends are not automatically retried.</Notice>
    <label className="ml-field"><span>Verified notification outcome</span><select className="ml-select" required disabled={disabled} value={resolution} onChange={event => {
      setResolution(event.target.value); setConfirmation(""); setReason("");
    }}>
      <option value="">Choose an independently verified outcome</option>
      <option value="sent">Mark verified delivered</option>
      <option value="retry">Retry after verifying not sent</option>
    </select></label>
    <label className="ml-field"><span>Documented provider verification and reason</span><Textarea required maxLength={2000} disabled={disabled} value={reason} onChange={event => setReason(event.target.value)} /></label>
    {word && <label className="ml-field"><span>Type {word} to confirm your independent verification</span><Input required autoComplete="off" disabled={disabled} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={disabled || !word || !reason.trim() || confirmation !== word}>{resolution === "retry" ? "Request verified retry" : "Record verified delivery"}</Button>
      <Button type="button" variant="ghost" disabled={disabled} onClick={() => { setOpen(false); setResolution(""); setReason(""); setConfirmation(""); }}>Cancel notification review</Button>
    </div>
  </form>;
}

export default function OperationsHistory({ resource, pending, onLoad, permissions, executionReady, onAction }) {
  const { data, loading, error } = resource;
  return <Panel step="04 / Verify" title="Runtime operation history" description="Server-reported operations, including failures. History does not authorise processing or prove that all cleanup completed. Notification recovery requires independent provider verification.">
    {loading && <Loading label="Loading runtime operation history…" />}
    {error && <ErrorRetry message={error} onRetry={() => onLoad()} disabled={!!pending || loading} />}
    {data && <>
      {data.items.length > 0 ? <ol className="divide-y" aria-label="Runtime operations">
        {data.items.map(item => <li key={item.id} className="ml-panel-body space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{words(item.action)}</h3>
            <span className="text-sm">Status: {words(item.status)}</span>
          </div>
          <dl className="ml-evidence">
            <div><dt>Operation ID</dt><dd className="break-words">{item.id}</dd></div>
            <div><dt>Member ID</dt><dd className="break-words"><EvidenceValue value={item.memberId} /></dd></div>
            <div><dt>Created at (server timestamp)</dt><dd><EvidenceValue value={item.createdAt} /></dd></div>
            <div><dt>{item.action === "notification" ? "Outcome code" : "Reason"}</dt><dd><EvidenceValue value={item.reason} /></dd></div>
            <div><dt>Error reported</dt><dd>{item.error == null ? "No error supplied; verify status and member evidence." : <EvidenceValue value={item.error} />}</dd></div>
          </dl>
          {item.action === "notification" && item.status === "needs_attention" && permissions?.review === true && executionReady === true
            && <NotificationRecovery noticeId={item.id} disabled={!!pending || loading || !!error} onAction={onAction} />}
        </li>)}
      </ol> : <div className="ml-empty"><h3 className="font-semibold">No runtime operations reported</h3><p className="ml-muted mt-2 text-sm">The server returned no operations on this page. This is not proof that automation has run or completed successfully.</p></div>}
      <div className="ml-panel-body flex flex-wrap items-center justify-between gap-3 border-t">
        <p className="ml-muted text-xs">{data.items.length} operations loaded · {data.limited === true
          ? "Limited to 100 operations. Older operations may not be shown; this is not the full operation history."
          : "Server-reported result"}</p>
      </div>
    </>}
  </Panel>;
}
