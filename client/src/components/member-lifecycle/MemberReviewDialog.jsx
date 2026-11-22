import { useState } from "react";
import { Archive, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { lifecycleDay } from "../../../../shared/memberLifecyclePolicy.mjs";
import { EvidenceValue, ErrorRetry, Loading, Notice, words } from "./LifecycleUI";

const actions = [
  { id: "retain", label: "Retain with durable hold", permission: "review", description: "Keep this record unchanged by automation until an authorised reviewer explicitly releases the hold." },
  { id: "release_hold", label: "Release hold", permission: "review", description: "Release the durable hold. The server rechecks eligibility; a release is not an archive approval." },
  { id: "extend", label: "Extend retention", permission: "review", description: "Defer review until a future tenant-calendar date. This does not change purchased membership history." },
  { id: "exempt", label: "Exempt from automation", permission: "review", description: "Exclude this member from lifecycle automation until the exemption is explicitly cleared." },
  { id: "clear_exemption", label: "Clear exemption", permission: "review", description: "Remove this individual exemption. Other holds, evidence and obligations still apply." },
  { id: "archive", label: "Archive member", permission: "archive", description: "Block member access, including existing sessions, and remove this record from ordinary operational lists and communications. Personal data and protected historical reporting remain." },
  { id: "restore", label: "Restore member", permission: "archive", description: "Request restoration with a fresh eligibility check. This does not restore removed data or automatically grant paid membership." },
  { id: "minimise", label: "Review minimisation", permission: "minimise", description: "Separately review removal of names, contact and profile information. Internal IDs, lifecycle dates, audit references and protected historical or financial records remain. Removed data cannot be restored." },
  { id: "delete", label: "Review permanent deletion", permission: "delete", description: "One authorised administrator can confirm deletion. Financial, legal, evidence and referential-integrity blockers still apply. This does not promise complete erasure of external-provider or backup data." },
];

export default function MemberReviewDialog({ memberId, resource, permissions, executionReady, pending, feedback, timezone, onClose, onRetry, onAction }) {
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [reviewAfter, setReviewAfter] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [impact, setImpact] = useState(null);
  const [error, setError] = useState(null);
  const data = resource.data;
  const chosen = actions.find(item => item.id === action);
  const destructive = action === "minimise" || action === "delete";
  const word = action.toUpperCase();
  const blocked = !data || !Array.isArray(data.blockers) || data.blockers.length > 0;
  const allowed = actions.filter(item => permissions[item.permission] === true
    && (data?.state !== "deleted")
    && (item.id !== "archive" || !["archived", "minimised"].includes(data?.state)));
  const impactValid = !!impact && impact.memberId === memberId && impact.action === action
    && impact.revision === data?.revision && Array.isArray(impact.blockers) && impact.blockers.length === 0;
  const disabled = executionReady !== true || !!pending || resource.loading || !!resource.error || !data;
  const today = (() => { try { return lifecycleDay(new Date(), timezone); } catch { return null; } })();

  const choose = (value) => { setAction(value); setImpact(null); setConfirmation(""); setError(null); };
  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!chosen || permissions[chosen.permission] !== true || disabled) return;
    if (!reason.trim()) { setError("A documented reason is required for every decision."); return; }
    if (action === "extend" && (!today || !reviewAfter || reviewAfter <= today)) {
      setError("Choose a future review date in the tenant timezone."); return;
    }
    if ((destructive || action === "archive") && blocked) {
      setError("Resolve the server-reported blockers before continuing."); return;
    }
    if (destructive && impact && (!impactValid || confirmation !== word)) {
      setError(`Generate a current, unblocked impact preview and type ${word} exactly.`); return;
    }
    const revision = data.revision;
    const payload = {
      action: destructive && !impact ? `${action}_preview` : action,
      memberId,
      expectedRevision: revision,
      reason: reason.trim(),
      ...(action === "extend" ? { reviewAfter } : {}),
      ...(destructive && impact ? { confirmation, impactToken: impact.impactToken } : {}),
    };
    const outcome = await onAction(payload.action, payload);
    setConfirmation("");
    if (!outcome) { setImpact(null); return; }
    if (destructive && !impact) {
      const result = outcome.result;
      if (typeof result.impactToken !== "string" || !result.impactToken
        || !Array.isArray(result.fieldsRemoved) || !Array.isArray(result.fieldsRetained) || !Array.isArray(result.blockers)) {
        setError("The service did not provide a complete field-level impact preview. Confirmation is unavailable.");
        setImpact(null);
        return;
      }
      setImpact({ ...result, revision, action, memberId });
    } else {
      setImpact(null);
      setAction("");
      setReason("");
      setReviewAfter("");
    }
  };

  return <Dialog open={!!memberId} onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="ml-detail max-h-[90dvh] overflow-y-auto sm:max-w-3xl" onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Archive className="h-5 w-5" aria-hidden="true" />Member lifecycle review</DialogTitle>
        <DialogDescription>Review server-owned evidence before recording a decision. No automatic disposal.</DialogDescription></DialogHeader>
      <p className="ml-code rounded-md bg-slate-50 p-3">Member ID: {memberId}</p>
      {feedback && <Notice tone={feedback.tone}>{feedback.message}</Notice>}
      {executionReady !== true && <Notice tone="warning" title="Preparation only">Member decisions are unavailable until the server reports execution ready.</Notice>}
      {resource.loading && <Loading label="Refreshing member evidence…" />}
      {resource.error && <ErrorRetry message={resource.error} onRetry={onRetry} disabled={!!pending} />}
      {data && <>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"><p className="font-semibold">State: {words(data.state)}</p><span className="ml-code">Record revision {data.revision}</span></div>
        <section aria-label="Current blockers" className="space-y-2">
          {data.blockers.length > 0 ? <Notice tone="warning" title="Disposal or transition blockers"><EvidenceValue value={data.blockers} /></Notice>
            : <Notice title="No blockers reported in this snapshot">The server must still recheck current obligations and evidence immediately before acting.</Notice>}
        </section>
        <section><h3 className="mb-2 font-semibold">Evidence & date provenance</h3><EvidenceValue value={data.evidence} /></section>
        <section className="border-t pt-4"><h3 className="mb-2 font-semibold">Audit & operation history</h3>
          <p className="ml-muted mb-2 text-xs">Check failures or partial operations here before retrying. A successful request alone is not proof that all cleanup completed.</p>
          <EvidenceValue value={data.audit} /></section>
      </>}
      {data && allowed.length > 0 && <form onSubmit={submit} className="space-y-4 border-t pt-4">
        <h3 className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4" aria-hidden="true" />Record a decision</h3>
        <label className="ml-field"><span>Decision</span><select className="ml-select" value={action} disabled={disabled} onChange={event => choose(event.target.value)} required>
          <option value="">Choose an authorised action</option>{allowed.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {chosen && <>
          <p className="ml-muted text-sm">{chosen.description}</p>
          <label className="ml-field"><span>Reason for this decision</span><Textarea value={reason} required disabled={disabled} onChange={event => { setReason(event.target.value); setImpact(null); setConfirmation(""); }} placeholder="Document the evidence and retention decision…" /></label>
          {action === "extend" && <label className="ml-field"><span>Review after ({timezone})</span><Input type="date" required value={reviewAfter} min={today || undefined} disabled={disabled || !today} onChange={event => setReviewAfter(event.target.value)} /></label>}
          {destructive && impact && <section className="space-y-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4" aria-label="Field-level impact preview">
            <h4 className="font-semibold">Field-level impact · {words(action)}</h4>
            <div className="ml-fields"><div><h5 className="mb-2 text-sm font-semibold">Fields removed</h5><EvidenceValue value={impact.fieldsRemoved} /></div>
              <div><h5 className="mb-2 text-sm font-semibold">Fields retained / protected</h5><EvidenceValue value={impact.fieldsRetained} /></div></div>
            {impact.blockers.length > 0 && <Notice tone="error" title="Confirmation blocked"><EvidenceValue value={impact.blockers} /></Notice>}
            {impact.revision !== data.revision && <Notice tone="warning">The record changed. Generate a fresh impact preview.</Notice>}
            <label className="ml-field"><span>Type {word} to confirm this irreversible operation</span><Input autoComplete="off" value={confirmation} disabled={disabled || !impactValid} onChange={event => setConfirmation(event.target.value)} /></label>
            <Button type="button" variant="outline" disabled={disabled} onClick={() => { setImpact(null); setConfirmation(""); }}>Discard impact preview</Button>
          </section>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={destructive && impact ? "destructive" : "default"}
              disabled={disabled || !reason.trim() || ((destructive || action === "archive") && blocked)
                || (destructive && !!impact && (!impactValid || confirmation !== word))}>
              {pending === action || pending === `${action}_preview` ? "Awaiting server & reloading…" : destructive ? impact ? `Confirm ${words(action).toLowerCase()}` : "Generate field-level impact preview" : `Confirm: ${chosen.label}`}
            </Button>
            <Button variant="ghost" type="button" disabled={!!pending} onClick={() => choose("")}>Cancel decision</Button>
          </div>
        </>}
      </form>}
      {data && allowed.length === 0 && <Notice>Read-only evidence. You have no authorised decisions for this record.</Notice>}
      <div className="flex justify-end border-t pt-4"><Button type="button" variant="outline" onClick={onClose} disabled={!!pending}>Close review</Button></div>
    </DialogContent>
  </Dialog>;
}
