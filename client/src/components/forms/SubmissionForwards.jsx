import { useEffect, useRef, useState } from "react";
import { Forward, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import { submissionForwardRequest, useSubmissionForwardHistory, useSubmissionForwardMembers } from "@/hooks/useSubmissionForwards";
import { createSubmissionForwardSession, forwardDisplayStatus } from "@/lib/formSubmissionForwards.mjs";

// Preserve an unresolved key across dialog dismissal, pagination and remounts.
// Scope includes verified identity, tenant, session and access generation.
const sessions = new Map();
const dateLabel = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";

export default function SubmissionForwards({ scope, submissionId, listHistory }) {
  const sessionKey = `${scope.scopeKey}:${submissionId}`;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [member, setMember] = useState(null);
  const [message, setMessage] = useState("<p>Please take a look at this form submission.</p>");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [, render] = useState(0);
  const live = useRef(true);
  const inFlight = useRef(false);
  const history = useSubmissionForwardHistory(scope, submissionId, open);
  const session = sessions.get(sessionKey);
  const locked = Boolean(session?.payload);
  const sent = session?.receipt?.status === "sent";
  const allowed = scope.status === "ready" && history.data?.can_forward === true && !history.isError && !history.isFetching;
  const members = useSubmissionForwardMembers(scope, submissionId, debouncedSearch, open && allowed && !locked);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!locked || sent) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked, sent]);

  async function send() {
    if (inFlight.current || !allowed || (!locked && !member?.email)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let current = sessions.get(sessionKey);
    if (!current) {
      current = createSubmissionForwardSession(submissionId,
        payload => submissionForwardRequest(scope, null, payload));
      sessions.set(sessionKey, current);
    }
    try {
      const result = await current.send(member?.id, message,
        payload => submissionForwardRequest(scope, null, payload));
      scope.assertCurrent();
      if (live.current) {
        setError(result.forward.status === "sent" ? "" : result.forward.status === "failed"
          ? "Email delivery failed. Retry uses the same recipient, message and request."
          : "Delivery is not confirmed. Check the original request below; do not create another send.");
        void history.refetch();
        void listHistory.refetch();
      }
    } catch (err) {
      if (live.current) setError(`${err.message} The original request is retained for a safe retry.`);
    } finally {
      inFlight.current = false;
      if (live.current) { setBusy(false); render(value => value + 1); }
    }
  }

  async function revoke() {
    if (inFlight.current || !revokeTarget || !allowed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await submissionForwardRequest(scope, null, {
        action: "revoke", submission_id: submissionId, forward_id: revokeTarget.id,
      });
      if (live.current) { setRevokeTarget(null); void history.refetch(); void listHistory.refetch(); }
    } catch (err) {
      if (live.current) setError(`Could not revoke the link. ${err.message}`);
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }

  const disabledReason = !allowed ? history.isError ? "Load forwarding history before sending."
    : history.isPending || history.isFetching ? "Checking forwarding access…" : "Forwarding is not available for this submission."
    : !locked && !member?.email ? "Choose a member of the tenant’s default organisation with an email address." : "";

  const renderHistory = (query, forwards, canRevoke = false) => <>
    {query.isPending && <div role="status" aria-label="Loading forwarding history" className="mt-2 h-8 animate-pulse rounded bg-slate-100" />}
    {query.isError && <div role="alert" className="mt-2 text-sm text-red-700">
      <p>Forwarding history could not be loaded. {query.error.message}</p>
      <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry history</Button>
    </div>}
    {query.data && !forwards.length && <p className="mt-2 text-xs text-slate-500">No forwards yet. Share this submission with a member of the tenant’s default organisation by email.</p>}
    <ul className="mt-2 space-y-2">
      {forwards.map(forward => {
        const status = forwardDisplayStatus(forward);
        return <li key={forward.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
          <div className="min-w-0 space-y-1">
            <p className="break-words font-medium text-slate-800">{forward.recipient_name || forward.recipient_email} <span className="font-normal text-slate-500">{forward.recipient_name ? forward.recipient_email : ""}</span></p>
            <p className="text-slate-500">{forward.sent_at ? "Sent" : "Requested"} {dateLabel(forward.sent_at || forward.created_at)}</p>
            {forward.expires_at && !forward.revoked_at && <p className="text-slate-500">Link expires {dateLabel(forward.expires_at)}</p>}
            {forward.revoked_at && <p className="text-slate-500">Revoked {dateLabel(forward.revoked_at)}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{status}</Badge>
            {canRevoke && !["Revoked", "Expired"].includes(status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevokeTarget(forward)}>Revoke link</Button>}
          </div>
        </li>;
      })}
    </ul>
  </>;

  return <section className="mt-3 border-t border-slate-200 pt-3" aria-label="Submission forwarding">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Forwarding history</h4>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={scope.status !== "ready"}>
        <Forward className="mr-2 h-3.5 w-3.5" />{locked ? "View forward request" : "Forward submission"}
      </Button>
    </div>
    {renderHistory(listHistory, listHistory.data?.[submissionId] || [])}
    {!open && error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-h-[90dvh] w-[95vw] max-w-2xl overflow-y-auto"
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Forward submission</DialogTitle>
          <DialogDescription>Email a member of the tenant’s default organisation a link to view this submission, with your own message. No login is required.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Share thoughtfully: anyone with this link can view the submission. Only send it to someone who should see these details. Links expire after 7 days and can be revoked below.</p>
        </div>
        <div className="border-b pb-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Forwarding history &amp; link access</h4>
          {renderHistory(history, history.data?.forwards || [], allowed)}
        </div>
        {locked ? <div className="rounded-lg border bg-slate-50 p-3 text-sm">
          <p className="font-medium">{sent ? "Email sent" : "Original request retained"}</p>
          <p>{session.receipt?.recipient_name || member?.first_name || "Selected member"} {session.receipt?.recipient_email || member?.email || ""}</p>
          <p className="mt-1 text-slate-500">The recipient and message are locked. Retrying checks the same request, never a new send.</p>
        </div> : <div className="space-y-2">
          <Label htmlFor={`forward-member-${submissionId}`}>Recipient</Label>
          <Input id={`forward-member-${submissionId}`} value={search} autoComplete="off" placeholder="Search members by name or email"
            disabled={busy || !allowed} onChange={event => { setSearch(event.target.value); setMember(null); }} />
          {member ? <p className="rounded border bg-slate-50 p-2 text-sm">Selected: {[member.first_name, member.last_name].filter(Boolean).join(" ")} — {member.email}</p>
            : search.trim().length < 2 ? <p className="text-xs text-slate-500">Enter at least 2 characters to search members of the tenant’s default organisation.</p> : <>
              {(search !== debouncedSearch || members.isFetching) && <div role="status" aria-label="Searching members" className="h-10 animate-pulse rounded bg-slate-100" />}
              {members.isError && <div role="alert" className="text-sm text-red-700">{members.error.message} <Button variant="outline" size="sm" onClick={() => members.refetch()}>Retry search</Button></div>}
              {search === debouncedSearch && members.data && <ul aria-label="Matching members" className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
                {!members.data.members?.length && <li className="p-3 text-sm text-slate-500">No matching members. Try another name or email.</li>}
                {(members.data.members || []).map(candidate => <li key={candidate.id}>
                  <button type="button" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 disabled:opacity-50"
                    disabled={!candidate.email} onClick={() => setMember(candidate)}>
                    <span className="block font-medium">{[candidate.first_name, candidate.last_name].filter(Boolean).join(" ") || candidate.email}</span>
                    <span className="block text-xs text-slate-500">{candidate.email || "No email address recorded"}</span>
                  </button>
                </li>)}
              </ul>}
            </>}
        </div>}
        <div className="space-y-2">
          <Label htmlFor={`forward-message-${submissionId}`}>Your message</Label>
          <SimpleRichTextEditor id={`forward-message-${submissionId}`} aria-label="Forward email message"
            content={session?.payload?.message_html ?? message} onChange={setMessage} disabled={locked || busy || !allowed} />
          <p className="text-xs text-slate-500">The submission link is included in the email automatically.</p>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {busy && <p role="status" className="text-sm text-slate-500">Confirming request…</p>}
        {disabledReason && <p id={`forward-disabled-${submissionId}`} className="text-sm text-slate-500">{disabledReason}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{locked ? "Close" : "Cancel"}</Button>
          {sent ? <Button onClick={() => {
            sessions.delete(sessionKey); setMember(null); setSearch(""); setMessage("<p>Please take a look at this form submission.</p>"); setError(""); render(value => value + 1);
          }}>Forward to another member</Button> : <Button onClick={send} disabled={busy || Boolean(disabledReason)}
            aria-describedby={disabledReason ? `forward-disabled-${submissionId}` : undefined}>
            {locked ? session?.receipt?.status === "failed" ? "Retry same email" : "Check original request" : "Send email"}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(revokeTarget)} onOpenChange={next => { if (!next && !busy) setRevokeTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Revoke this forwarding link?</AlertDialogTitle>
          <AlertDialogDescription>The email cannot be recalled, but its link will no longer open the submission for anyone who has it.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy || !allowed} onClick={event => { event.preventDefault(); void revoke(); }}>Revoke link</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
