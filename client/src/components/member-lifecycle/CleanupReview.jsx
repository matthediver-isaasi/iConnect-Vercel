import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorRetry, Loading, Notice, Panel, words } from "./LifecycleUI";

function CleanupItem({ item, disabled, onAction }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const submit = async event => {
    event.preventDefault();
    if (disabled || !reason.trim() || confirmation !== "VERIFIED REMOVED") return;
    const outcome = await onAction("resolve_cleanup", {
      action: "resolve_cleanup", cleanupId: item.id, reason: reason.trim(), confirmation,
    });
    if (outcome) { setOpen(false); setReason(""); setConfirmation(""); }
  };
  return <li className="ml-panel-body space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">{words(item.kind)}</h3><p className="ml-muted text-sm">State: {words(item.state)}</p></div>
      {!open && item.state !== "resolved" && <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}>Record independent removal verification</Button>}
    </div>
    <dl className="ml-evidence">
      <div><dt>Cleanup ID</dt><dd className="break-words">{item.id}</dd></div>
      <div><dt>Member ID</dt><dd className="break-words">{item.memberId || "Not reported"}</dd></div>
      {typeof item.referenceLabel === "string" && <div><dt>Stored media (sanitized location)</dt><dd className="whitespace-pre-wrap break-words">{item.referenceLabel}</dd></div>}
      <div><dt>Reason</dt><dd>{item.reason || "Not reported"}</dd></div>
      <div><dt>Created at (server timestamp)</dt><dd>{item.createdAt || "Not reported"}</dd></div>
    </dl>
    {open && <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <p className="text-sm">Independently verify that the stored media was removed using your authorised storage process before recording this attestation. This action records your verification; it does not remove files.</p>
      <label className="ml-field"><span>Documented independent removal verification</span><Textarea required maxLength={2000} disabled={disabled} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label className="ml-field"><span>Type VERIFIED REMOVED after independently verifying storage removal</span><Input required autoComplete="off" disabled={disabled} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled || !reason.trim() || confirmation !== "VERIFIED REMOVED"}>Confirm independently verified removal</Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={() => { setOpen(false); setReason(""); setConfirmation(""); }}>Cancel verification</Button>
      </div>
    </form>}
  </li>;
}

export default function CleanupReview({ resource, executionReady, pending, onLoad, onAction }) {
  const { data, loading, error } = resource;
  const disabled = executionReady !== true || !!pending || loading || !!error;
  return <Panel step="05 / Verify storage" title="Stored-media cleanup review" description="Independent administrator verification, not automatic external-file removal. Supplied sanitized storage labels are plain text; raw storage references are not shown.">
    <div className="ml-panel-body"><Notice>Profile erasure does not prove stored media, external-provider records or backups were erased. Independently verify storage removal before resolving a cleanup entry. This application does not claim to have removed external files.</Notice>
      {executionReady !== true && <p className="ml-muted mt-3 text-sm">Read-only cleanup evidence. Recording verification is unavailable until execution is ready.</p>}</div>
    {loading && <Loading label="Loading stored-media cleanup review…" />}
    {error && <ErrorRetry message={error} onRetry={onLoad} disabled={!!pending || loading} />}
    {data && <>
      {data.items.length ? <ol className="divide-y" aria-label="Stored-media cleanup entries">{data.items.map(item => <CleanupItem key={item.id} item={item} disabled={disabled} onAction={onAction} />)}</ol>
        : <div className="ml-empty"><h3 className="font-semibold">No cleanup entries reported</h3><p className="ml-muted mt-2 text-sm">An empty list does not prove stored media or external files have been removed.</p></div>}
      <p className="ml-panel-body ml-muted border-t text-xs">{data.items.length} cleanup entries loaded · {data.limited === true ? "Limited result; older entries may not be shown. This is not the full cleanup history." : "Server-reported result"}</p>
    </>}
  </Panel>;
}
