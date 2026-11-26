import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminFetch } from "@/lib/adminFetch";
import { memberChangeEndpoint, readMemberChangeResponse, requestMoney } from "@/lib/memberChangeRequests";

export default function MemberCancelUnpaidMembership({ memberId, tenantId, onChanged }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState("");
  const [preview, setPreview] = useState(null), [error, setError] = useState(null);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const lock = useRef(false);
  const status = useQuery({
    queryKey: ["member-unpaid-cancellation", tenantId, memberId], retry: false, staleTime: 0,
    queryFn: async () => readMemberChangeResponse(await adminFetch(`${memberChangeEndpoint}?${new URLSearchParams({
      action: "unpaid_cancellation_status", memberId,
    })}`, { credentials: "include", cache: "no-store" }, tenantId)),
  });
  async function run(action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const response = await adminFetch(memberChangeEndpoint, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, memberId, reason: reason.trim(), approve: true,
          fingerprint: preview?.fingerprint, operationId: status.data?.operationId }),
      }, tenantId);
      const data = await readMemberChangeResponse(response);
      if (action === "preview_unpaid_cancellation") {
        if (!/^[a-f0-9]{64}$/.test(data.fingerprint || "")) throw new Error("A valid invoice preview was not returned.");
        setPreview(data);
      } else {
        if (data.state !== "released") throw new Error("Cancellation has not yet been confirmed.");
        setDone(true); setOpen(false); onChanged();
      }
    } catch (failure) {
      setError(failure.message || "Cancellation could not be confirmed. Check the existing cancellation before starting another purchase.");
      if (action === "confirm_unpaid_cancellation") setPreview(null);
    } finally {
      lock.current = false; setBusy(false);
      if (action === "confirm_unpaid_cancellation") setOpen(false);
      if (action !== "preview_unpaid_cancellation") void status.refetch();
    }
  }
  if (done || status.data?.completed) return <p role="status">The unpaid membership and its invoice were cancelled. History is retained. The member can start again using the configured joining form in /portal.</p>;
  if (status.isLoading) return <p role="status">Checking for an unpaid membership…</p>;
  if (status.isError) return <div role="alert"><p>Unpaid cancellation options could not be loaded: {status.error.message}</p>
    <Button variant="outline" onClick={() => status.refetch()}>Try again</Button></div>;
  if (!status.data?.eligible && !status.data?.pending) return <p className="text-muted-foreground" data-testid="text-cancel-membership-blocked">There is no current membership to cancel.</p>;
  return <div className="space-y-3" data-testid="unpaid-membership-cancellation">
    <p>This membership is awaiting payment{status.data.invoiceNumber ? ` on invoice ${status.data.invoiceNumber}` : ""}.
      {" "}Cancel the unpaid purchase and its invoice to let the member choose again from /portal.</p>
    {error && <p role="alert">{error}</p>}
    {status.data.pending ? <>
      <p>Invoice cancellation needs reconciliation. A new purchase stays blocked until cancellation is confirmed.</p>
      <Button data-testid="button-recover-unpaid-cancellation" disabled={busy} onClick={() => run("recover_unpaid_cancellation")}>{busy ? "Checking…" : "Check unpaid cancellation"}</Button>
    </> : <Button data-testid="button-cancel-unpaid-membership" variant="destructive" onClick={() => { setOpen(true); setPreview(null); setError(null); }}>
      Cancel unpaid membership
    </Button>}
    {open && <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel unpaid membership</DialogTitle>
          <DialogDescription>This cancels the unpaid invoice in accounting and releases the original purchase.
            Membership and invoice history are retained. It does not permanently cancel the member or set up Direct Debit.</DialogDescription>
        </DialogHeader>
        <Label htmlFor="unpaid-cancellation-reason">Reason for cancellation</Label>
        <Textarea id="unpaid-cancellation-reason" data-testid="input-unpaid-cancellation-reason" value={reason} maxLength={1000} disabled={busy}
          onChange={event => { setReason(event.target.value); setPreview(null); }} />
        {preview && <p role="status">Cancel invoice {preview.invoiceNumber || ""} for {requestMoney(preview.grossMinor, preview.currency)}.
          Xero currently confirms no payments or credits. The member can then start a new purchase through the configured portal joining form.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Keep membership</Button>
          <Button data-testid="button-submit-unpaid-cancellation" variant="destructive" disabled={busy || reason.trim().length < 3}
            onClick={() => run(preview ? "confirm_unpaid_cancellation" : "preview_unpaid_cancellation")}>
            {busy ? "Checking…" : preview ? "Confirm membership and invoice cancellation" : "Review unpaid invoice"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>}
  </div>;
}
